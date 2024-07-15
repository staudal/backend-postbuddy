import { Router } from 'express';
import { prisma } from '../app';
import { DesignNotFoundError, MissingRequiredParametersError } from '../errors';
import { del, put } from '@vercel/blob';

const router = Router();

router.post('/new', async (req, res) => {
  const { user_id, design_id, scene } = req.body;
  if (!user_id || !design_id || !scene) return res.status(400).json({ error: MissingRequiredParametersError });

  const design = await prisma.design.findUnique({
    where: { id: design_id },
  });
  if (!design) return res.status(404).json({ error: DesignNotFoundError });

  if (design.scene) {
    await del(design.scene)
  }
  const blob = await put(`scenes/${design_id}.txt`, scene, {
    access: 'public',
    contentType: 'text/plain',
  })

  await prisma.design.update({
    where: { id: design_id },
    data: { scene: blob.url },
  })

  return res.status(200).json({ success: "Design uploaded to vercel blob" });
})

export default router;