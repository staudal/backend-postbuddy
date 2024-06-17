import { Router } from 'express';
import { prisma } from '../app';
import { InsufficientRightsError, InternalServerError, MissingRequiredParametersError, UserAlreadyExistsError, UserNotFoundError } from '../errors';
import argon2 from 'argon2';

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

router.get('/', async (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return MissingRequiredParametersError;

  // Check that user is an admin
  const user = await prisma.user.findUnique({
    where: { id: user_id },
  });
  if (!user) return UserNotFoundError;

  if (user.role !== 'admin') {
    return res.status(403).json({ error: InsufficientRightsError });
  }

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

  return res.status(200).json(users);
})

router.post('/', async (req, res) => {
  const { user_id, first_name, last_name, company, email, password, role, demo } = req.body;
  if (!user_id) return MissingRequiredParametersError

  const user = await prisma.user.findUnique({
    where: { id: user_id },
  });
  if (!user) return UserNotFoundError;

  // Check that user has the correct role
  if (user.role !== 'admin') {
    return res.status(403).json({ error: InsufficientRightsError });
  }

  // Check if the created user already exists
  const existingUser = await prisma.user.findUnique({
    where: { email },
  });
  if (existingUser) {
    return res.status(400).json({ error: UserAlreadyExistsError });
  }

  const hashedPassword = await argon2.hash(password);

  // Create the new user
  try {
    await prisma.user.create({
      data: {
        first_name,
        last_name,
        company,
        email,
        password: hashedPassword,
        role,
        demo,
      },
    });

    return res.status(201).json({ success: 'User created successfully' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: InternalServerError });
  }
})

router.put(`/:id`, async (req, res) => {
  const { user_id, first_name, last_name, company, email, role, demo } = req.body;
  const id = req.params.id;
  if (!user_id || !id) return MissingRequiredParametersError;

  // Check if user is an admin
  const user = await prisma.user.findUnique({
    where: { id: user_id },
  });
  if (!user) return UserNotFoundError;

  if (user.role !== 'admin') {
    return res.status(403).json({ error: InsufficientRightsError });
  }

  try {
    await prisma.user.update({
      where: {
        id
      },
      data: {
        first_name,
        last_name,
        email,
        company,
        role,
        demo,
      },
    });

    return res.status(200).json({ success: 'User updated successfully' });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: InternalServerError });
  }
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