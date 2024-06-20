import { Router, Request } from 'express';
import { logtail, prisma } from '../app';
import { CampaignNotFoundError, DesignNotFoundError, InsufficientRightsError, InternalServerError, MissingAddressError, MissingRequiredParametersError, MissingSubscriptionError, ProfilesNotFoundError, SegmentNotFoundError, UserNotFoundError } from '../errors';
import { activateCampaignForDemoUser, activateCampaignForNonDemoUser, billUserForLettersSent, generateCsvAndSendToPrintPartner, generatePdf, generateTestDesign, sendPdfToPrintPartner } from '../functions';
import Client from "ssh2-sftp-client";

const router = Router();

router.get('/', async (req, res) => {
  const user_id = req.body.user_id;
  if (!user_id) return res.status(400).json({ error: MissingRequiredParametersError });

  const dbUser = await prisma.user.findUnique({
    where: { id: user_id },
  });
  if (!dbUser) return UserNotFoundError;

  const campaigns = await prisma.campaign.findMany({
    where: { user_id: dbUser.id, demo: dbUser.demo },
    include: {
      segment: {
        include: {
          profiles: {
            include: {
              orders: {
                include: {
                  order: true
                }
              }
            }
          }
        },
      },
      design: true,
    },
    orderBy: {
      created_at: "desc",
    },
  });

  res.json(campaigns);
})

router.post('/', async (req, res) => {
  const { user_id, name, type, segment_id, design_id, discountCodes, start_date } = req.body;
  if (!name || !user_id || !type || !segment_id || !design_id || !discountCodes) return res.status(400).json({ error: MissingRequiredParametersError });

  const segment = await prisma.segment.findUnique({
    where: { id: segment_id },
  });
  if (!segment) return res.status(404).json({ error: SegmentNotFoundError });

  const design = await prisma.design.findUnique({
    where: { id: design_id },
  });
  if (!design || !design.blob) return res.status(404).json({ error: DesignNotFoundError });

  const user = await prisma.user.findUnique({
    where: { id: user_id },
  });
  if (!user) return res.status(404).json({ error: UserNotFoundError });

  const profiles = await prisma.profile.findMany({
    where: {
      segment_id: segment.id,
      in_robinson: false,
    },
  });
  if (!profiles || profiles.length === 0) return res.status(404).json({ error: ProfilesNotFoundError });

  const startDate = start_date ? new Date(start_date) : new Date();
  const campaign = await prisma.campaign.create({
    data: {
      name,
      type,
      status: "pending",
      segment_id,
      created_at: new Date(),
      user_id,
      design_id,
      discount_codes: discountCodes || [],
      start_date: startDate,
      demo: segment.demo,
    }
  })

  // If the campaign is scheduled for a future date, update the status to "scheduled"
  if (campaign.start_date > new Date()) {
    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { status: "scheduled" },
    })

    return res.status(201).json({ success: "Kampagnen er blevet oprettet og er blevet sat til at starte på en senere dato" });
  }

  try {
    if (!segment.demo) {
      await activateCampaignForNonDemoUser(user.id, profiles, design.blob, campaign.id)
    } else {
      await activateCampaignForDemoUser(profiles, campaign.id)
    }
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }

  return res.status(201).json({ success: segment.demo ? "Kampagnen er blevet oprettet" : "Kampagnen er blevet oprettet og er blevet sendt til produktion" });
})

router.put('/:id', async (req, res) => {
  const { user_id, status, design_id } = req.body;
  const id = req.params.id;
  if (!user_id) return res.status(400).json({ error: MissingRequiredParametersError });

  const campaign = await prisma.campaign.findUnique({
    where: { id: id },
  });
  if (!campaign) return CampaignNotFoundError;

  if (campaign.user_id !== user_id) return InsufficientRightsError;

  await prisma.campaign.update({
    where: { id: id },
    data: {
      status: status || campaign.status,
      design_id: design_id || campaign.design_id,
    }
  });

  return res.status(200).json({ success: "Kampagnen er blevet opdateret" });
})

router.delete('/:id', async (req, res) => {
  const { user_id } = req.body;
  const id = req.params.id;
  if (!user_id || !id) return res.status(400).json({ error: MissingRequiredParametersError });

  const campaign = await prisma.campaign.findUnique({
    where: { id: id },
  });
  if (!campaign) return CampaignNotFoundError;

  if (campaign.user_id !== user_id) return InsufficientRightsError;

  await prisma.campaign.delete({
    where: { id: id },
  });

  return res.status(200).json({ success: "Kampagnen er blevet slettet" });
})

router.post('/test-letter', async (req, res) => {
  const { user_id, design_id } = req.body;
  if (!user_id || !design_id) return res.status(400).json({ error: MissingRequiredParametersError });

  const user = await prisma.user.findUnique({
    where: { id: user_id },
  });
  if (!user) return UserNotFoundError;

  const design = await prisma.design.findUnique({
    where: { id: design_id },
  })
  if (!design || !design.blob) return DesignNotFoundError

  if (!user.address || !user.zip_code || !user.city) MissingAddressError

  // Bill the user for the letters sent
  await billUserForLettersSent(1, user_id)

  let format = "";
  const pdfBuffer = await generateTestDesign(design.blob, format);

  const client = new Client();
  await client.connect({
    host: process.env.SFTP_HOST,
    port: parseInt(process.env.SFTP_PORT as string),
    username: process.env.SFTP_USER,
    password: process.env.SFTP_PASSWORD,
  });

  // Create datestring e.g. 15-05-2024
  const date = new Date();
  const dateString = `${date.getDate()}-${date.getMonth() + 1}-${date.getFullYear()}`;

  // Create folder if not exists
  await client.mkdir(`/files/til-distplus/${dateString}`, true);

  // Upload the PDF to the SFTP server
  await client.put(
    pdfBuffer,
    `/files/til-distplus/${dateString}/${format}_${user.id.slice(-5)}_1.pdf`,
  );

  // Generate csv data
  let csvData = "fullname,company,address,zip_city,id\n"; // CSV headers
  csvData += `"${user.first_name} ${user.last_name}","${user.company}","${user.address}","${user.zip_code} ${user.city}","${user.id.slice(-5)}"\n`;

  // Convert the CSV data to a Buffer
  const csvBuffer = Buffer.from(csvData);

  // Upload the CSV data to the SFTP server
  await client.put(
    csvBuffer,
    `/files/til-distplus/${dateString}/${format}_${user.id.slice(-5)}_1.csv`,
  );

  // Close the SFTP connection
  await client.end();

  return res.status(201).json({ success: "Testbrevet er blevet sendt til produktion" });
})

export default router;