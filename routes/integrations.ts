import { Router, Request, Response } from 'express';
import { prisma } from '../app';
import { InternalServerError, MissingRequiredParametersError, UserNotFoundError } from '../errors';

const router = Router();

router.get('/integrations', async (req: Request, res: Response) => {
  const user_id = req.body.user_id;
  const integrationType = req.body.integrationType;
  if (!user_id) return res.status(400).json({ error: MissingRequiredParametersError });

  const user = await prisma.user.findUnique({
    where: { id: user_id },
  });
  if (!user) return res.status(404).json({ error: UserNotFoundError });

  if (integrationType) {
    try {
      const integration = await prisma.integration.findFirst({
        where: { type: integrationType },
      });

      return res.json(integration);
    } catch (error: any) {
      console.error(error);
      return res.status(500).json({ error: InternalServerError });
    }
  }

  try {
    const integrations = await prisma.integration.findMany({
      where: { user_id: user.id },
    });

    res.json(integrations);
  } catch (error: any) {
    console.error(error);
    return res.status(500).json({ error: InternalServerError });
  }
})

export default router;