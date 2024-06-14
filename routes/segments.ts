import { Router, Request, Response } from 'express';
import { prisma } from '../app';
import { InternalServerError, MissingRequiredParametersError, UserNotFoundError } from '../errors';

const router = Router();

router.get('/segments', async (req: Request, res: Response) => {
  const user_id = req.body.user_id;
  if (!user_id) return res.status(400).json({ error: MissingRequiredParametersError });

  const user = await prisma.user.findUnique({
    where: { id: user_id },
  });

  if (!user) return res.status(404).json({ error: UserNotFoundError });

  const segments = await prisma.segment.findMany({
    where: { user_id: user.id, demo: user.demo },
    include: { campaign: true, profiles: true },
    orderBy: {
      created_at: 'desc',
    },
  });

  res.json(segments);
})

router.delete('/segments/:id', async (req: Request, res: Response) => {
  const user_id = req.body.user_id;
  if (!user_id) return res.status(400).json({ error: MissingRequiredParametersError });

  const segment = await prisma.segment.findUnique({
    where: { id: req.params.id },
  });

  if (!segment) return res.status(404).json({ error: 'Segment not found' });

  if (segment.user_id !== user_id) return res.status(403).json({ error: 'Forbidden' });

  try {
    await prisma.segment.delete({
      where: { id: req.params.id },
    });
  } catch (error: any) {
    console.error(error);
    return res.status(500).json({ error: InternalServerError });
  }

  res.json({ success: 'Segment deleted successfully' });
})

router.put('/segments/:id', async (req: Request, res: Response) => {
  const user_id = req.body.user_id;
  const newName = req.body.segmentName;
  if (!user_id || !newName) return res.status(400).json({ error: MissingRequiredParametersError });

  const segment = await prisma.segment.findUnique({
    where: { id: req.params.id },
  });

  if (!segment) return res.status(404).json({ error: 'Segment not found' });

  if (segment.user_id !== user_id) return res.status(403).json({ error: 'Forbidden' });

  try {
    await prisma.segment.update({
      where: { id: req.params.id },
      data: { name: newName },
    });
  } catch (error: any) {
    console.error(error);
    return res.status(500).json({ error: InternalServerError });
  }

  res.json({ success: 'Segment updated successfully' });
})

export default router;