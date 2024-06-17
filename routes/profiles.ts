import { Router } from 'express';
import { prisma } from '../app';
import { InternalServerError, MissingRequiredParametersError, ProfilesNotFoundError } from '../errors';
import { API_URL } from '../constants';

const router = Router();

router.get('/', async (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: MissingRequiredParametersError });

  try {
    const segments = await prisma.segment.findMany({
      where: {
        user_id
      },
      select: {
        id: true,
        name: true,
        profiles: {
          select: {
            id: true,
            email: true,
            first_name: true,
            last_name: true,
            address: true,
            zip_code: true,
            city: true,
            country: true,
          },
        },
      },
    });

    res.json(segments);
  } catch (error: any) {
    console.error(error);
    return res.status(500).json({ error: InternalServerError });
  }
})

router.delete('/:id', async (req, res) => {
  const { user_id } = req.body;
  const { id } = req.params;

  if (!user_id) return res.status(400).json({ error: MissingRequiredParametersError });

  // validate that the profile belongs to a segment that belongs to the user
  const profile = await prisma.profile.findFirst({
    where: {
      id,
      segment: {
        user_id
      }
    }
  });

  if (!profile) return res.status(404).json({ error: ProfilesNotFoundError });

  try {
    await prisma.profile.delete({
      where: { id },
    });

    res.status(200).json({ success: 'Profilen blev slettet' });
  } catch (error: any) {
    console.error(error);
    return res.status(500).json({ error: InternalServerError });
  }
})

router.put('/:id', async (req, res) => {
  const { user_id, email, first_name, last_name, address, zip_code, city, country, custom_variable } = req.body;
  if (!user_id) return res.status(400).json({ error: MissingRequiredParametersError });
  const { id } = req.params;

  // validate that the profile belongs to a segment that belongs to the user
  const profile = await prisma.profile.findFirst({
    where: {
      id,
      segment: {
        user_id
      }
    }
  });

  if (!profile) return res.status(404).json({ error: ProfilesNotFoundError });

  try {
    await prisma.profile.update({
      where: { id },
      data: {
        email,
        first_name,
        last_name,
        address,
        zip_code,
        city,
        country,
        custom_variable
      },
    });

    res.status(200).json({ success: 'Profilen blev opdateret' });
  } catch (error: any) {
    console.error(error);
    return res.status(500).json({ error: InternalServerError });
  }
})

router.get('/webhook', async (req, res) => {
  const users = await prisma.user.findMany();

  for (const user of users) {
    const campaigns = await prisma.campaign.findMany({
      where: { user_id: user.id }
    });
    for (const campaign of campaigns) {
      const profiles = await prisma.profile.findMany({
        where: {
          segment_id: campaign.segment_id,
          letter_sent: false,
          segment: {
            type: "webhook",
          },
          in_robinson: false,
        },
      });

      if (profiles.length === 0) {
        continue;
      }

      if (campaign.demo === false) {
        const response = await fetch(API_URL + '/letters', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            campaign_id: campaign.id,
            profiles
          }),
        });

        if (!response.ok) {
          throw new Error('Error sending letters');
        }
      }

      // If campaign is a demo campaign, mark profiles as sent
      await prisma.profile.updateMany({
        where: {
          segment_id: campaign.segment_id,
          in_robinson: false,
        },
        data: {
          letter_sent: true,
          letter_sent_at: new Date(),
        },
      });
    }
  }
});

export default router;