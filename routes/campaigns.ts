import { Router } from 'express';
import { logtail, prisma } from '../app';
import { CampaignNotFoundError, DesignNotFoundError, ErrorWithStatusCode, FailedToBillUserError, FailedToCreateCampaignError, FailedToGeneratePdfError, FailedToScheduleCampaignError, FailedToSendPdfToPrintPartnerError, InsufficientRightsError, MissingAddressError, MissingRequiredParametersError, MissingSubscriptionError, ProfilesNotFoundError, SegmentNotFoundError, UserNotFoundError } from '../errors';
import { billUserForLettersSent, generateCsvAndSendToPrintPartner, generatePdf, generateTestDesign, sendLettersForNonDemoUser, sendPdfToPrintPartner } from '../functions';
import Client from "ssh2-sftp-client";
import { Campaign, Profile } from '@prisma/client';
import { testProfile } from '../constants';

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
    where: { id: segment_id, user_id },
    include: {
      user: {
        include: {
          subscription: true,
        }
      },
      profiles: true,
    }
  });
  if (!segment) return res.status(404).json({ error: SegmentNotFoundError }); // Segment not found
  if (segment.profiles.length === 0) return res.status(404).json({ error: ProfilesNotFoundError }); // No profiles found
  if (!segment.user.subscription && segment.demo === false) return res.status(400).json({ error: MissingSubscriptionError }); // User has no subscription

  const design = await prisma.design.findUnique({
    where: { id: design_id },
  });
  if (!design || !design.blob) return res.status(404).json({ error: DesignNotFoundError });

  const startDate = start_date ? new Date(start_date) : new Date().toISOString();
  let campaign: Campaign | null;
  try {
    campaign = await prisma.campaign.create({
      data: {
        name,
        type,
        status: "scheduled",
        segment_id,
        created_at: new Date(),
        user_id,
        design_id,
        discount_codes: discountCodes || [],
        start_date: startDate,
        demo: segment.demo,
      }
    })
  } catch (error: any) {
    return res.status(500).json({ error: FailedToCreateCampaignError });
  }

  return res.status(201).json({ success: "Kampagnen er blevet oprettet og afventer afsendelse", campaign });
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

  // Try to bill the user for the letters sent
  try {
    await billUserForLettersSent(1, user_id);
  } catch (error: any) {
    return res.status(500).json({ error: FailedToBillUserError });
  }

  // Generate pdf
  let pdf;
  try {
    pdf = await generatePdf([testProfile], design.blob);
  } catch (error: any) {
    logtail.error(`An error occured while trying to generate a pdf for a test letter for user ${user_id}`);
    return res.status(500).json({ error: FailedToGeneratePdfError });
  }

  // Send pdf to print partner with datestring e.g. 15-05-2024
  const date = new Date();
  const dateString = `${date.getDate()}-${date.getMonth() + 1}-${date.getFullYear()}`;

  try {
    await sendPdfToPrintPartner(pdf, user_id, dateString);
  } catch (error: any) {
    logtail.error(`An error occured while trying to send a test letter pdf to the print partner for user ${user_id}`);
    return res.status(500).json({ error: FailedToSendPdfToPrintPartnerError });
  }

  try {
    await generateCsvAndSendToPrintPartner([testProfile], user_id, dateString);
  } catch (error: any) {
    logtail.error(`An error occured while trying to generate a test letter csv and send it to the print partner for user ${user_id}`);
    return res.status(500).json({ error: FailedToSendPdfToPrintPartnerError });
  }

  return res.status(201).json({ success: "Testbrevet er blevet sendt til produktion" });
})

export default router;