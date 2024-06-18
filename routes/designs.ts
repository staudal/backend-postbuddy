import { Router } from 'express';
import { prisma } from '../app';
import { DesignNotFoundError, InternalServerError, MissingRequiredParametersError, UserNotFoundError } from '../errors';
import { del, put } from '@vercel/blob';
import { generatePdf } from '../functions';
import { Profile } from '@prisma/client';

const router = Router();

router.get('/', async (req, res) => {
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

router.get('/:id', async (req, res) => {
  const user_id = req.body.user_id;
  const { id } = req.params;
  if (!user_id) return res.status(400).json({ error: MissingRequiredParametersError });

  const dbUser = await prisma.user.findUnique({
    where: { id: user_id },
  });
  if (!dbUser) return res.status(404).json({ error: UserNotFoundError });

  const design = await prisma.design.findFirst({
    where: {
      id,
      user_id: dbUser.id,
    },
  });
  if (!design) return res.status(404).json({ error: DesignNotFoundError });

  return res.status(200).json(design);
})

router.post('/duplicate', async (req, res) => {
  try {
    const { user_id, design_id } = req.body;
    if (!user_id || !design_id) return res.status(400).json({ error: MissingRequiredParametersError });

    const user = await prisma.user.findUnique({
      where: { id: user_id },
    });
    if (!user) return res.status(404).json({ error: UserNotFoundError });

    const design = await prisma.design.findUnique({
      where: { id: design_id },
    });
    if (!design) return res.status(404).json({ error: DesignNotFoundError });

    await prisma.design.create({
      data: {
        name: design.name,
        blob: design.blob,
        user_id: user.id,
        thumbnail: design.thumbnail,
        format: design.format,
        demo: design.demo,
      },
    });

    return res.status(201).json({ success: 'Design duplikeret' });
  } catch (error: any) {
    console.error(error);
    return res.status(500).json({ error: InternalServerError });
  }
})

router.post('/', async (req, res) => {
  try {
    const { user_id, name, format } = req.body;
    if (!name || !user_id || !format) return res.status(400).json({ error: MissingRequiredParametersError });

    const user = await prisma.user.findUnique({
      where: { id: user_id },
    });
    if (!user) return res.status(404).json({ error: UserNotFoundError });

    const newDesign = await prisma.design.create({
      data: {
        name,
        format,
        user_id: user.id,
        demo: user.demo,
      },
    });

    // We have to return the design because its ID is used for redirection in the frontend
    return res.status(201).json({ success: 'Design oprettet', design: newDesign });
  } catch (error: any) {
    console.error(error);
    return res.status(500).json({ error: InternalServerError });
  }
})

router.put('/:id', async (req, res) => {
  try {
    const { user_id, name } = req.body;
    const { id } = req.params;
    if (!name || !user_id) return res.status(400).json({ error: MissingRequiredParametersError });

    const user = await prisma.user.findUnique({
      where: { id: user_id },
    });
    if (!user) return res.status(404).json({ error: UserNotFoundError });

    const design = await prisma.design.findUnique({
      where: { id },
    });
    if (!design) return res.status(404).json({ error: DesignNotFoundError });

    await prisma.design.update({
      where: { id },
      data: {
        name
      },
    });

    return res.json({ success: 'Design opdateret' });
  } catch (error: any) {
    console.error(error);
    return res.status(500).json({ error: InternalServerError });
  }
})

router.delete('/:id', async (req, res) => {
  try {
    const { user_id } = req.body;
    const { id } = req.params;
    if (!user_id) return res.status(400).json({ error: MissingRequiredParametersError });

    const user = await prisma.user.findUnique({
      where: { id: user_id },
    });
    if (!user) return res.status(404).json({ error: UserNotFoundError });

    // Check if design belongs to user
    const userDesign = await prisma.design.findFirst({
      where: {
        id,
        user_id: user.id,
      },
    });
    if (!userDesign) return res.status(404).json({ error: DesignNotFoundError });

    const design = await prisma.design.findUnique({
      where: { id },
    });
    if (!design) return res.status(404).json({ error: DesignNotFoundError });

    await prisma.design.delete({
      where: { id },
    });

    return res.json({ success: 'Design slettet' });
  } catch (error: any) {
    console.error(error);
    return res.status(500).json({ error: InternalServerError });
  }
})

router.post('/thumbnail', async (req, res) => {
  try {
    const { user_id, design_id, thumbnail } = req.body;
    if (!user_id || !design_id || !thumbnail) return res.status(400).json({ error: MissingRequiredParametersError });

    const user = await prisma.user.findUnique({
      where: { id: user_id },
    });
    if (!user) return res.status(404).json({ error: UserNotFoundError });

    const design = await prisma.design.findUnique({
      where: { id: design_id },
    });
    if (!design) return res.status(404).json({ error: DesignNotFoundError });

    if (design && design.thumbnail) {
      await del(design.thumbnail);
      const newThumbnail = await put(`thumbnails/${design.id}-thumbnail.jpg`, thumbnail, {
        access: "public",
        contentType: "image/jpeg",
      });
      await prisma.design.update({
        where: { id: design.id },
        data: {
          thumbnail: newThumbnail.url,
        },
      });
    } else {
      const newThumbnail = await put(`thumbnails/${design.id}-thumbnail.jpg`, thumbnail, {
        access: "public",
        contentType: "image/jpeg",
      });
      await prisma.design.update({
        where: { id: design.id },
        data: {
          thumbnail: newThumbnail.url,
        },
      });
    }

    return res.status(200).json({ success: 'Thumbnail gemt' });
  } catch (error: any) {
    console.error(error);
    return res.status(500).json({ error: InternalServerError });
  }
})

router.post('/export', async (req, res) => {
  const { user_id, design_id } = req.body;
  if (!user_id || !design_id) return res.status(400).json({ error: MissingRequiredParametersError });

  const design = await prisma.design.findUnique({
    where: { id: design_id, user_id },
  });
  if (!design || !design.blob) return res.status(404).json({ error: DesignNotFoundError });

  const dummyProfile: Profile = {
    first_name: 'John',
    last_name: 'Doe',
    email: 'john@doe.dk',
    address: 'Testvej 1',
    city: 'Testby',
    zip_code: '1234',
    in_robinson: false,
    country: 'Danmark',
    custom_variable: 'Random data',
    demo: true,
    klaviyo_id: '1234',
    letter_sent: false,
    letter_sent_at: null,
    segment_id: '1234',
    id: '12345678',
  }

  const pdf = await generatePdf([dummyProfile], design.blob)
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename=export.pdf');
  res.send(pdf);
})

export default router;