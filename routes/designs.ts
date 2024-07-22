import { Router } from 'express';
import { logtail, prisma } from '../app';
import { DesignNotFoundError, InternalServerError, MissingRequiredParametersError, SceneNotFoundError, UserNotFoundError } from '../errors';
import { s3, generatePdf } from '../functions';
import { Profile } from '@prisma/client';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import multer from 'multer';

const router = Router();

router.get('/', async (req, res) => {
  const user_id = req.body.user_id;
  if (!user_id) return res.status(400).json({ error: MissingRequiredParametersError });

  const dbUser = await prisma.user.findUnique({
    where: { id: user_id },
  });
  if (!dbUser) return res.status(404).json({ error: UserNotFoundError });

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
      scene: design.scene,
      user_id: user.id,
      thumbnail: design.thumbnail,
      format: design.format,
      demo: design.demo,
    },
  });

  return res.status(201).json({ success: 'Design duplikeret' });
})

router.post('/', async (req, res) => {
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
})

router.put('/:id', async (req, res) => {
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
})

router.delete('/:id', async (req, res) => {
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
})

router.post('/export', async (req, res) => {
  const { user_id, design_id } = req.body;
  if (!user_id || !design_id) return res.status(400).json({ error: MissingRequiredParametersError });

  const design = await prisma.design.findUnique({
    where: { id: design_id, user_id },
  });
  if (!design || !design.scene) return res.status(404).json({ error: DesignNotFoundError });

  const dummyProfile: Profile = {
    first_name: 'John',
    last_name: 'Doe',
    created_at: new Date(),
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

  const pdf = await generatePdf([dummyProfile], design.scene)
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', 'attachment; filename=export.pdf');
  res.send(pdf);
})

// used to fetch scene when loading a design in the editor
router.get('/:id/scene', async (req, res) => {
  const { id } = req.params;
  if (!id) return res.status(400).json({ error: MissingRequiredParametersError });

  try {
    await prisma.$transaction(async (prisma) => {
      const design = await prisma.design.findUnique({
        where: { id },
      });

      if (!design || !design.scene) {
        return res.status(404).json({ error: DesignNotFoundError });
      }

      // if the design was uploaded to vercel, we need to fetch it from the old bucket
      if (design.scene.includes('public.blob.vercel-storage.com')) {
        return res.status(200).send(design.scene);
      }

      const getObjectParams = {
        Bucket: 'scenes',
        Key: design.scene,
      };

      const s3res = await s3.send(new GetObjectCommand(getObjectParams));

      if (!s3res.Body) {
        return res.status(404).json({ error: SceneNotFoundError });
      }

      const bodyString = await s3res.Body.transformToString();
      return res.status(200).send(bodyString);
    });
  } catch (error: any) {
    logtail.error("Error fetching scene in editor", error);
    res.status(500).json({ error: InternalServerError });
  }
});

// used to upload scene when saving a design in the editor
router.post('/:id/scene', async (req, res) => {
  const { id } = req.params;
  const { scene } = req.body;
  if (!id || !scene) return res.status(400).json({ error: MissingRequiredParametersError });

  try {
    await prisma.$transaction(async (prisma) => {
      const design = await prisma.design.findUnique({
        where: { id },
      });

      if (!design) {
        return res.status(404).json({ error: DesignNotFoundError });
      }

      const newSceneUUID = `${id}-scene`;
      await s3.send(new PutObjectCommand({
        Bucket: 'scenes',
        Key: newSceneUUID,
        Body: scene,
        ContentType: 'text/plain',
      }));

      await prisma.design.update({
        where: { id },
        data: { scene: newSceneUUID },
      });

      return res.status(200).json({ success: 'Designet blev gemt' });
    });
  } catch (error: any) {
    logtail.error("Error uploading scene in editor", error);
    return res.status(500).json({ error: InternalServerError });
  }
});

const upload = multer();
// used for uploads in the editor
router.post('/:id/upload', upload.single('file'), async (req, res) => {
  const { id } = req.params;
  const { name, format, width, height } = req.body;
  const file = req.file;

  if (!id || !name || !format || !width || !height || !file) {
    return res.status(400).json({ error: MissingRequiredParametersError });
  }

  try {
    await prisma.$transaction(async (prisma) => {
      const design = await prisma.design.findUnique({
        where: { id },
      });

      if (!design) {
        return res.status(404).json({ error: DesignNotFoundError });
      }

      const s3Params = {
        Bucket: 'uploads',
        Key: `${id}/${name}`,
        Body: file.buffer,
        ContentType: format,
      };
      await s3.send(new PutObjectCommand(s3Params));

      const newUpload = await prisma.upload.create({
        data: {
          name,
          url: `https://rkjrflfwfqhhpwafimbe.supabase.co/storage/v1/object/public/uploads/${id}/${name}`,
          user_id: design.user_id,
          format,
          height,
          width,
        },
      });

      res.status(201).json({ success: 'Upload created successfully', upload: newUpload });
    });
  } catch (error: any) {
    logtail.error("Error uploading file in editor", error);
    return res.status(500).json({ error: InternalServerError });
  }
});

// used for updating thumbnails in the editor
router.post('/:id/thumbnail', upload.single('file'), async (req, res) => {
  const { id } = req.params;
  const file = req.file;

  if (!id || !file) {
    return res.status(400).json({ error: MissingRequiredParametersError });
  }

  try {
    await prisma.$transaction(async (prisma) => {
      const design = await prisma.design.findUnique({
        where: { id },
      });

      if (!design) {
        return res.status(404).json({ error: DesignNotFoundError });
      }

      const s3Params = {
        Bucket: 'thumbnails',
        Key: `${id}-thumbnail.jpg`,
        Body: file.buffer,
        ContentType: 'image/jpeg',
      };
      await s3.send(new PutObjectCommand(s3Params));

      await prisma.design.update({
        where: { id },
        data: {
          thumbnail: `https://rkjrflfwfqhhpwafimbe.supabase.co/storage/v1/object/public/thumbnails/${id}-thumbnail.jpg`,
        },
      });

      return res.status(200).json({ success: 'Thumbnail updated' });
    });
  } catch (error: any) {
    logtail.error("Error updating thumbnail in editor", error);
    return res.status(500).json({ error: InternalServerError });
  }
});

export default router;