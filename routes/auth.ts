import { Router } from 'express';
import { prisma } from '../app';
import jwt from 'jsonwebtoken';
import { UserAlreadyExistsError, UserNotFoundError } from '../errors';
import argon2 from 'argon2';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret';

router.post('/signup', async (req, res) => {
  const { firstName, lastName, company, email, password } = req.body;

  // Check if the user already exists
  const existingUser = await prisma.user.findUnique({
    where: { email },
  });

  if (existingUser) {
    return res.status(409).json({ error: UserAlreadyExistsError });
  }

  // Hash the password
  const hashedPassword = await argon2.hash(password);

  // Create a new user
  const user = await prisma.user.create({
    data: {
      first_name: firstName,
      last_name: lastName,
      company,
      email,
      password: hashedPassword,
    },
  });

  // Create a JWT token for the new user
  const token = jwt.sign(
    { userId: user.id, email: user.email },
    JWT_SECRET,
    { expiresIn: '24h' } // Expires in 24 hours
  );

  return res.status(201).json({
    success: 'User created successfully',
    token,
  });
})

router.post('/signin', async (req, res) => {
  const { email, password } = req.body;

  // Check if the user exists
  const user = await prisma.user.findUnique({
    where: { email },
  });

  if (!user) {
    return res.status(403).json({ error: UserNotFoundError });
  }

  // Compare the password
  const passwordMatch = await argon2.verify(user.password, password);

  if (!passwordMatch) {
    return res.status(403).json({ error: UserNotFoundError });
  }

  // Create a JWT token for the user
  const token = jwt.sign(
    { userId: user.id, email: user.email },
    JWT_SECRET,
    { expiresIn: '24h' } // Expires in 24 hours
  );

  return res.status(200).json({ success: 'User signed in successfully', token });
})

router.post('/refresh-token', async (req, res) => {
  const { token } = req.body;

  // Decode the token
  const decodedToken = jwt.decode(token) as jwt.JwtPayload;

  // Validate the user existence in the database
  const user = await prisma.user.findUnique({
    where: { email: decodedToken.email },
  });

  if (!user) {
    return res.status(403).json({ error: UserNotFoundError });
  }

  // Sign a new token with the same payload
  const newToken = jwt.sign(
    { userId: user.id, email: user.email },
    JWT_SECRET,
    { expiresIn: '24h' } // Expires in 24 hours
  );

  return res.status(200).json({ token: newToken });
})

export default router;