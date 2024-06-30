import { Router } from 'express';
import { logtail, prisma } from '../app';
import { CampaignNotFoundError, DesignNotFoundError, FailedToBillUserError, FailedToCreateCampaignError, FailedToGeneratePdfError, FailedToScheduleCampaignError, FailedToSendPdfToPrintPartnerError, InsufficientRightsError, InternalServerError, MissingAddressError, MissingRequiredParametersError, MissingSubscriptionError, ProfilesNotFoundError, SegmentNotFoundError, UserNotFoundError } from '../errors';
import { billUserForLettersSent, generateCsvAndSendToPrintPartner, generatePdf, generateTestDesign, periodicallySendLetters, sendLettersForNonDemoUser, sendPdfToPrintPartner } from '../functions';
import { Campaign, Profile } from '@prisma/client';
import { testProfile } from '../constants';

const router = Router();

router.get('/', async (req, res) => {
  const user_id = req.body.user_id;
  if (!user_id) return res.status(400).json({ error: 'MissingRequiredParametersError' });

  try {
    const dbUser = await prisma.user.findUnique({
      where: { id: user_id },
    });

    if (!dbUser) return res.status(404).json({ error: 'UserNotFoundError' });

    // Fetch campaigns including necessary aggregation data
    const campaigns = await prisma.campaign.findMany({
      where: { user_id: dbUser.id, demo: dbUser.demo },
      include: {
        segment: {
          include: {
            profiles: {
              select: {
                id: true,
                first_name: true,
                last_name: true,
                address: true,
                zip_code: true,
                city: true,
                email: true,
                country: true,
                letter_sent: true,
                letter_sent_at: true,
                orders: {
                  select: {
                    order: {
                      select: {
                        amount: true,
                      }
                    }
                  }
                }
              }
            }
          }
        },
        design: true,
      },
      orderBy: {
        created_at: "desc",
      },
    });

    // Process the data on the backend
    const campaignData = campaigns.map((campaign) => {
      const lettersSentCount = campaign.segment.profiles.filter(profile => profile.letter_sent).length;

      const profilesWithTotalAmount = campaign.segment.profiles.map(profile => {
        const totalAmount = profile.orders.reduce((acc, orderProfile) => {
          return acc + (orderProfile.order.amount || 0);
        }, 0);
        return { ...profile, totalAmount };
      });

      // Sort profiles based on total order amount in descending order
      profilesWithTotalAmount.sort((a, b) => b.totalAmount - a.totalAmount);

      const campaignRevenue = profilesWithTotalAmount.reduce((acc, profile) => acc + profile.totalAmount, 0);

      return {
        ...campaign,
        segment: { ...campaign.segment, profiles: profilesWithTotalAmount },
        lettersSent: lettersSentCount,
        campaignRevenue,
      };
    });

    return res.json(campaignData);
  } catch (error: any) {
    logtail.error(`Failed to fetch campaigns for user ${user_id}: ${error.message}`);
    return res.status(500).json({ InternalServerError });
  }
});

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

router.post('/force-send-letters', async (req, res) => {
  await periodicallySendLetters();
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