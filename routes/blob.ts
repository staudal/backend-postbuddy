import { Router, Request, Response } from 'express';
import { prisma } from '../app';
import { DesignNotFoundError, InternalServerError, MissingRequiredParametersError } from '../errors';
import { del, put } from '@vercel/blob';

const router = Router();

router.post('/new', async (req: Request, res: Response) => {
  const { user_id, design_id, scene } = req.body;
  if (!user_id || !design_id || !scene) return res.status(400).json({ error: MissingRequiredParametersError });

  const design = await prisma.design.findUnique({
    where: { id: design_id },
  });
  if (!design) return res.status(404).json({ error: DesignNotFoundError });

  if (design.blob) {
    await del(design.blob)
  }
  const blob = await put(`scenes/${design_id}.txt`, scene, {
    access: 'public',
    contentType: 'text/plain',
  })

  try {
    await prisma.design.update({
      where: { id: design_id },
      data: { blob: blob.url },
    })

    return res.status(200).json({ success: "Design uploaded to vercel blob" });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: InternalServerError });
  }
})

export default router;