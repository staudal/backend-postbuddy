import { Router } from 'express';
import { prisma } from '../app';
import { InternalServerError, MissingRequiredParametersError, UserNotFoundError } from '../errors';

const router = Router();

router.get('/profiles', async (req, res) => {
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