import { Router } from 'express';
import { prisma } from '../app';
import { CampaignNotFoundError, MissingRequiredParametersError, MissingSubscriptionError, UserNotFoundError } from '../errors';
import { billUserForLettersSent, generateCsvAndSendToPrintPartner, generatePdf, sendPdfToPrintPartner } from '../functions';

const router = Router();

router.post('/letters', async (req, res) => {
  const { campaign_id, profiles } = req.body;

  if (!campaign_id || !profiles) {
    return res.status(400).json({ error: MissingRequiredParametersError });
  }

  if (!profiles.length || profiles.length === 0) {
    return res.status(400).json({ error: 'Ingen profiler blev sendt med i request body' });
  }

  const campaign = await prisma.campaign.findUnique({
    where: { id: campaign_id },
  });

  if (!campaign || !campaign.design_id) {
    return res.status(404).json({ error: CampaignNotFoundError });
  }

  const user = await prisma.user.findUnique({
    where: { id: campaign.user_id },
  });

  if (!user) {
    return res.status(404).json({ error: UserNotFoundError });
  }

  const subscription = await prisma.subscription.findFirst({
    where: { user_id: user.id },
  });

  if (!subscription) {
    return res.status(400).json({ error: MissingSubscriptionError });
  }

  const design = await prisma.design.findUnique({
    where: { id: campaign.design_id },
  });

  if (!design || !design.blob) {
    return res.status(404).json({ error: 'Design blev ikke fundet' });
  }

  // Create datestring e.g. 15-05-2024
  const date = new Date();
  const dateString = `${date.getDate()}-${date.getMonth() + 1}-${date.getFullYear()}`;

  const pdf = await generatePdf(profiles, design.blob);
  await sendPdfToPrintPartner(pdf, campaign.id, dateString)
  await generateCsvAndSendToPrintPartner(profiles, campaign.id, dateString);
  await billUserForLettersSent(profiles, user.id);
});