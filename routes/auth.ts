import { Router } from 'express';
import { logtail, prisma } from '../app';
import jwt from 'jsonwebtoken';
import { InternalServerError, UserAlreadyExistsError, UserNotFoundError } from '../errors';
import argon2 from 'argon2';
import { Resend } from 'resend';

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret';

router.post('/signup', async (req, res) => {
  try {
    const { firstName, lastName, company, email, password } = req.body;

    // email to lowercase
    const emailToLower = email.toLowerCase();

    // Check if the user already exists
    const existingUser = await prisma.user.findUnique({
      where: { email: emailToLower },
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
        email: emailToLower,
        password: hashedPassword,
      },
    });

    // Create a JWT token for the new user
    const token = jwt.sign(
      { userId: user.id, email: user.email },
      JWT_SECRET,
      { expiresIn: '24h' } // Expires in 24 hours
    );

    const resend = new Resend(process.env.RESEND_API_KEY);
    (async function () {
      const { error } = await resend.emails.send({
        from: 'Postbuddy <noreply@postbuddy.dk>',
        to: ['jakob@postbuddy.dk', 'christian@postbuddy.dk'],
        subject: `Ny bruger signup: ${user.email}`,
        html: `Der er blevet oprettet en ny bruger med følgende oplysninger:
      <br>
      <br>
      <strong>Navn:</strong> ${user.first_name} ${user.last_name}
      <br>
      <strong>Virksomhed:</strong> ${user.company}
      <br>
      <strong>Email:</strong> ${user.email}`,
      });

      if (error) {
        return console.error({ error });
      }
    })();

    return res.status(201).json({
      success: 'Bruger oprettet',
      token,
    });
  } catch (error: any) {
    logtail.error(error);
    return res.status(500).json({ error: InternalServerError });
  }
})

router.post('/signin', async (req, res) => {
  try {
    const { email, password } = req.body;

    const emailToLower = email.toLowerCase();

    // Check if the user exists
    const user = await prisma.user.findUnique({
      where: { email: emailToLower },
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

    return res.status(200).json({ success: 'Du er nu logget ind', token });
  } catch (error: any) {
    logtail.error(error);
    return res.status(500).json({ error: InternalServerError });
  }
})

router.post('/refresh-token', async (req, res) => {
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
      { expiresIn: '24h' } // Expires in 24 hours
    );

    return res.status(200).json({ token: newToken });
  } catch (error: any) {
    logtail.error(error);
    return res.status(500).json({ error: InternalServerError });
  }
})

export default router;