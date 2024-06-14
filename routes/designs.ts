import { Router, Request, Response } from 'express';
import { prisma } from '../app';
import { InternalServerError, MissingRequiredParametersError, UserNotFoundError } from '../errors';

const router = Router();

router.get('/designs', async (req: Request, res: Response) => {
  const user_id = req.body.user_id;
  if (!user_id) return res.status(400).json({ error: MissingRequiredParametersError });

  const dbUser = await prisma.user.findUnique({
    where: { id: user_id },
  });
  if (!dbUser) return res.status(404).json({ error: UserNotFoundError });

  try {
    const designs = await prisma.design.findMany({
      where: {
        user_id: dbUser.id,
        demo: dbUser.demo,
      },
      include: {
        campaigns: true,
      },
    });

    res.json(designs);
  } catch (error: any) {
    console.error(error);
    return res.status(500).json({ error: InternalServerError });
  }
})

export default router;