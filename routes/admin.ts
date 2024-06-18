import { Router } from 'express';
import { prisma } from '../app';
import { InsufficientRightsError, InternalServerError, MissingRequiredParametersError, UserAlreadyExistsError, UserNotFoundError } from '../errors';
import argon2 from 'argon2';
import jwt from 'jsonwebtoken';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret';

router.get('/users', async (req, res) => {
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
    include: {
      campaigns: true,
      designs: true,
      segments: true,
    },
    orderBy: {
      created_at: 'desc',
    },
  })

  return res.status(200).json(users);
})

router.post('/users', async (req, res) => {
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

router.put(`/users/:id`, async (req, res) => {
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

  // check if email already exists
  const existingUser = await prisma.user.findUnique({
    where: { email },
  });
  if (existingUser) {
    return res.status(400).json({ error: UserAlreadyExistsError });
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

router.post('/impersonate', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: MissingRequiredParametersError });

    // Find the user to impersonate
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return res.status(404).json({ error: UserNotFoundError });

    // Create a JWT token for the impersonated user
    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.status(200).json({ success: 'Token created successfully', token });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});


export default router;