import { Router, Request, Response } from 'express';
import { prisma } from '../app';
import { CampaignNotFoundError, DesignNotFoundError, InsufficientRightsError, InternalServerError, MissingAddressError, MissingRequiredParametersError, ProfilesNotFoundError, SegmentNotFoundError, UserNotFoundError } from '../errors';
import { billUserForLettersSent, generateTestDesign } from '../functions';
import Client from "ssh2-sftp-client";

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  const user_id = req.body.user_id;
  if (!user_id) return res.status(400).json({ error: MissingRequiredParametersError });

  const dbUser = await prisma.user.findUnique({
    where: { id: user_id },
  });
  if (!dbUser) return UserNotFoundError;

  try {
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
  } catch (error: any) {
    console.error(error);
    return res.status(500).json({ error: InternalServerError });
  }
})

router.post('/', async (req: Request, res: Response) => {
  const { user_id, name, type, segment_id, design_id, discountCodes, start_date } = req.body;
  if (!name || !user_id || !type || !segment_id || !design_id || !discountCodes) return res.status(400).json({ error: MissingRequiredParametersError });

  const segment = await prisma.segment.findUnique({
    where: { id: segment_id },
  });
  if (!segment) return res.status(404).json({ error: SegmentNotFoundError });

  const design = await prisma.design.findUnique({
    where: { id: design_id },
  });
  if (!design) return res.status(404).json({ error: DesignNotFoundError });

  const user = await prisma.user.findUnique({
    where: { id: user_id },
  });
  if (!user) return UserNotFoundError;

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

  // Bill the user if the campaign is not a demo
  if (!segment.demo) {
    try {
      await billUserForLettersSent(profiles.length, user_id)
    } catch (error: any) {
      console.error(error);
      return res.status(500).json({ error: InternalServerError });
    }
  }

  // If the campaign is scheduled for a future date, update the status to "scheduled"
  if (campaign.start_date > new Date()) {
    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { status: "scheduled" },
    })

    return res.status(201).json({ success: "Kampagnen er blevet oprettet og er blevet sat til at starte på en senere dato" });
  }

  // If the campaign is a demo, update the profiles to sent. If not, generate the pdf which will update the profiles to sent
  if (segment.demo === false) {
    const response = await fetch("https://app.postbuddy.dk/api/designs/export", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ campaignId: campaign.id }),
    })
    if (!response.ok) {
      const data = await response.json();
      console.error(data);
      return res.status(500).json({ error: InternalServerError });
    }
  } else {
    await prisma.profile.updateMany({
      where: {
        segment_id: segment.id,
        in_robinson: false,
      },
      data: {
        letter_sent: true,
        letter_sent_at: new Date(),
      },
    })
  }

  // If the campaign is scheduled for now, update the status to "active"
  await prisma.campaign.update({
    where: { id: campaign.id },
    data: { status: "active" },
  })

  return res.status(201).json({ success: segment.demo ? "Kampagnen er blevet oprettet" : "Kampagnen er blevet oprettet og er blevet sendt til produktion" });
})

router.put('/:id', async (req: Request, res: Response) => {
  const { user_id, status, design_id } = req.body;
  const id = req.params.id;
  if (!user_id) return res.status(400).json({ error: MissingRequiredParametersError });

  const campaign = await prisma.campaign.findUnique({
    where: { id: id },
  });
  if (!campaign) return CampaignNotFoundError;

  if (campaign.user_id !== user_id) return InsufficientRightsError;

  try {
    await prisma.campaign.update({
      where: { id: id },
      data: {
        status: status || campaign.status,
        design_id: design_id || campaign.design_id,
      }
    });

    return res.status(200).json({ success: "Kampagnen er blevet opdateret" });
  } catch (error: any) {
    console.error(error);
    return res.status(500).json({ error: InternalServerError });
  }
})

router.delete('/:id', async (req: Request, res: Response) => {
  const { user_id } = req.body;
  const id = req.params.id;
  if (!user_id || !id) return res.status(400).json({ error: MissingRequiredParametersError });

  const campaign = await prisma.campaign.findUnique({
    where: { id: id },
  });
  if (!campaign) return CampaignNotFoundError;

  if (campaign.user_id !== user_id) return InsufficientRightsError;

  try {
    await prisma.campaign.delete({
      where: { id: id },
    });

    return res.status(200).json({ success: "Kampagnen er blevet slettet" });
  } catch (error: any) {
    console.error(error);
    return res.status(500).json({ error: InternalServerError });
  }
})

router.post('/test-letter', async (req: Request, res: Response) => {
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
  try {
    await billUserForLettersSent(1, user_id)
  } catch (error: any) {
    console.error(error);
    return res.status(500).json({ error: error.message });
  }

  try {
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
  } catch (error: any) {
    console.error(error);
    return res.status(500).json({ error: InternalServerError });
  }
})

export default router;