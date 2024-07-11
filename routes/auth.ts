import { Router } from 'express';
import { logtail, prisma } from '../app';
import jwt from 'jsonwebtoken';
import { InternalServerError, InvalidJwtTokenError, PasswordResetTokenExpiredError, PasswordTooShortError, UserAlreadyExistsError, UserNotFoundError } from '../errors';
import argon2 from 'argon2';
import { Resend } from 'resend';
import { JWT_EXPIRATION_TIME, WEB_URL } from '../constants';
import { LoopsClient } from "loops";

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret';

router.post('/signup', async (req, res) => {
  try {
    const { firstName, lastName, company, email, password, marketing } = req.body;

    // email to lowercase
    const emailToLower = email.toLowerCase();

    // Check if the password is at least 8 characters long
    if (password.length < 8) {
      return res.status(400).json({ error: PasswordTooShortError });
    }

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
      { expiresIn: JWT_EXPIRATION_TIME } // Expires in 24 hours
    );

    try {
      const resend = new Resend(process.env.RESEND_API_KEY);
      (async function () {
        await resend.emails.send({
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
      })();
    } catch (error: any) {
      logtail.error(error);
    }

    if (marketing) {
      try {
        const loops = new LoopsClient(process.env.LOOPS_API_KEY as string);
        await loops.createContact(emailToLower, {
          firstName,
          lastName,
          company,
        });
      } catch (error: any) {
        logtail.error(error);
      }
    }

    return res.status(201).json({
      success: 'Bruger oprettet. Du kan nu logge ind.',
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
      { expiresIn: JWT_EXPIRATION_TIME } // Expires in 24 hours
    );

    return res.status(200).json({ success: 'Du er nu logget ind.', token });
  } catch (error: any) {
    logtail.error(error);
    return res.status(500).json({ error: InternalServerError });
  }
})

router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    const emailToLower = email.toLowerCase();

    // Check if the user exists
    const user = await prisma.user.findUnique({
      where: { email: emailToLower },
    });

    if (!user) {
      return res.status(403).json({ error: UserNotFoundError });
    }

    // Generate a JWT token with user ID for password reset
    const token = jwt.sign(
      { userId: user.id },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRATION_TIME }
    );

    // Construct the reset password URL
    const resetPasswordUrl = `${WEB_URL}/reset-password/${token}`;

    // Send password reset email
    const resend = new Resend(process.env.RESEND_API_KEY);
    const { error } = await resend.emails.send({
      from: 'Postbuddy <noreply@postbuddy.dk>',
      to: [user.email],
      subject: 'Reset Your Password',
      html: `Hi ${user.first_name},<br><br>You can reset your password by clicking <a href="${resetPasswordUrl}">here</a>.<br><br>If you didn't request a password reset, you can ignore this message.`,
    });

    if (error) {
      logtail.error(error);
      return res.status(500).json({ error: InternalServerError });
    }

    return res.status(200).json({ success: 'Der er blevet sendt en email med et link til at nulstille din adgangskode' });
  } catch (error: any) {
    logtail.error(error);
    return res.status(500).json({ error: InternalServerError });
  }
});

router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;

    try {
      // Verify the JWT token
      const decoded = jwt.verify(token, JWT_SECRET) as jwt.JwtPayload;

      // Check if the user exists
      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
      });

      if (!user) {
        return res.status(403).json({ error: UserNotFoundError });
      }

      // Check if the password is at least 8 characters long
      if (password.length < 8) {
        return res.status(400).json({ error: PasswordTooShortError });
      }

      // Hash the new password
      const hashedPassword = await argon2.hash(password);

      // Update the user's password
      await prisma.user.update({
        where: { id: user.id },
        data: { password: hashedPassword },
      });

      return res.status(200).json({ success: 'Din adgangskode er blevet nulstillet' });

    } catch (error) {
      if (error instanceof jwt.TokenExpiredError) {
        return res.status(401).json({ error: PasswordResetTokenExpiredError });
      } else if (error instanceof jwt.JsonWebTokenError) {
        return res.status(403).json({ error: InvalidJwtTokenError });
      }
      // Handle other jwt errors here if needed

      throw error; // re-throw other errors for global error handling
    }

  } catch (error: any) {
    logtail.error(error);
    return res.status(500).json({ error: InternalServerError });
  }
});

export default router;