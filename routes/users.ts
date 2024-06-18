import { Router } from 'express';
import { prisma } from '../app';
import { InternalServerError, MissingRequiredParametersError } from '../errors';

const router = Router();

router.post('/uploads', async (req, res) => {
  const { user_id, name, url, format, width, height } = req.body;
  if (!user_id || !name || !url || !format || !height || !width) return MissingRequiredParametersError

  try {
    await prisma.uploads.create({
      data: {
        name,
        url,
        user_id,
        format,
        height,
        width
      },
    });

    return res.json({ success: 'Upload created successfully' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: InternalServerError });
  }
})

router.get('/uploads', async (req, res) => {
  const user_id = req.body.user_id;
  if (!user_id) return MissingRequiredParametersError

  const uploads = await prisma.uploads.findMany({
    where: { user_id }
  });

  return res.json(uploads);
})

router.post('/access-token', async (req, res) => {
  const user_id = req.body.user_id;
  if (!user_id) return MissingRequiredParametersError

  try {
    await prisma.user.update({
      where: { id: user_id },
      data: {
        access_token: Math.random().toString(36).substring(2),
      },
    });

    return res.status(200).json({ success: 'Access token updated successfully' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: InternalServerError });
  }
})


export default router;