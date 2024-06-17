import { Router, Request, Response } from 'express';
import { prisma } from '../app';
import { InsufficientRightsError, InternalServerError, MissingRequiredParametersError, UserAlreadyExistsError, UserNotFoundError } from '../errors';

const router = Router();

router.get('/', async (req: Request, res: Response) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: MissingRequiredParametersError });

  const user = await prisma.user.findUnique({
    where: { id: user_id },
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

  return res.status(200).json(user);
})

export default router;