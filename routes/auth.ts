import { Router } from 'express';
import { prisma } from '../app';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcrypt';
import { InternalServerError, UserAlreadyExistsError, UserNotFoundError } from '../errors';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret';

router.post('/auth/signup', async (req, res) => {
  try {
    const { firstName, lastName, company, email, password } = req.body;

    // Check if the user already exists
    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      return res.status(409).json({ error: UserAlreadyExistsError });
    }

    // Hash the password
    const hashedPassword = await bcrypt.hash(password, 10);

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
      { expiresIn: '1h' }
    );

    res.status(201).json({
      success: 'User created successfully',
      token,
    });
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ error: InternalServerError });
  }
})

router.post('/auth/signin', async (req, res) => {
  try {
    const { email, password } = req.body;

    // Check if the user exists
    const user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      console.log('User not found');
      return res.status(403).json({ error: UserNotFoundError });
    }

    // Compare the password
    const passwordMatch = await bcrypt.compare(password, user.password);

    if (!passwordMatch) {
      console.log('Password does not match');
      return res.status(403).json({ error: UserNotFoundError });
    }

    // Create a JWT token for the user
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.status(200).json({ success: 'User signed in successfully', token });
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ error: InternalServerError });
  }
})

router.post('/auth/refresh-token', async (req, res) => {
  try {
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
      { expiresIn: '24h' }
    );

    console.log('Token refreshed successfully');
    res.json({ token: newToken });
  } catch (error) {
    console.error('Token refresh error:', error);
    res.status(500).json({ error: InternalServerError });
  }
})

export default router;