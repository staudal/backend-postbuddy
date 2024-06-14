import { Router, Request, Response } from 'express';
import { prisma } from '../app';
import { InternalServerError, MissingRequiredParametersError, UserNotFoundError } from '../errors';

const router = Router();

router.get('/user', async (req: Request, res: Response) => {
  const user_id = req.body.user_id;

  if (!user_id) {
    return res.status(400).json({ error: MissingRequiredParametersError });
  }

  const user = await prisma.user.findUnique({
    where: {
      id: user_id as string,
    },
    select: {
      first_name: true,
      last_name: true,
      company: true,
      email: true,
      address: true,
      city: true,
      zip_code: true,
      country: true,
      access_token: true,
      role: true,
      demo: true,
    },
  });

  if (!user) {
    return res.status(404).json({ error: UserNotFoundError });
  }

  res.json(user);
})

router.post('/user/uploads', async (req, res) => {
  const user_id = req.body.user_id;

  if (!user_id) {
    return res.status(400).json({ error: MissingRequiredParametersError });
  }

  const { name, url, format, height, width } = req.body;
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

    res.json({ success: 'Upload created successfully' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: InternalServerError });
  }
})

router.get('/user/uploads', async (req, res) => {
  const user_id = req.body.user_id;
  if (!user_id) return MissingRequiredParametersError

  const uploads = await prisma.uploads.findMany({
    where: { user_id }
  });

  return Response.json(uploads);
})

router.get('/users', async (req, res) => {
  const users = await prisma.user.findMany({
    select: {
      id: true,
      first_name: true,
      last_name: true,
      company: true,
      email: true,
      address: true,
      city: true,
      zip_code: true,
      country: true,
      access_token: true,
      role: true,
      demo: true,
    },
  });

  res.json(users);
})

router.post('/user/access-token', async (req, res) => {
  const user_id = req.body.user_id;
  if (!user_id) return MissingRequiredParametersError

  try {
    await prisma.user.update({
      where: { id: user_id },
      data: {
        access_token: Math.random().toString(36).substring(2),
      },
    });

    res.json({ success: 'Access token updated successfully' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: InternalServerError });
  }
})


export default router;