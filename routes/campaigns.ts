import { Router, Request, Response } from 'express';
import { prisma } from '../app';
import { DesignNotFoundError, InternalServerError, MissingRequiredParametersError, ProfilesNotFoundError, SegmentNotFoundError, UserNotFoundError } from '../errors';
import { billUserForLettersSent } from '../functions';

const router = Router();

router.get('/campaigns', async (req: Request, res: Response) => {
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

router.post('/campaigns', async (req: Request, res: Response) => {
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

    return res.json({ success: "Kampagnen er blevet oprettet og er blevet planlagt til at starte på det angivne tidspunkt" });
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

  return res.json({ success: segment.demo ? "Kampagnen er blevet oprettet" : "Kampagnen er blevet oprettet og sendt til produktion" });
})

router.put

export default router;