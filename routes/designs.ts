import { Router } from 'express';
import { logError, logtail, logWarn, prisma } from '../app';
import { DesignNotFoundError, InsufficientRightsError, InternalServerError, MissingRequiredParametersError, SceneNotFoundError, UserNotFoundError } from '../errors';
import { s3, generatePdf } from '../functions';
import { Profile } from '@prisma/client';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import multer from 'multer';
import { authenticateToken } from './middleware';

const router = Router();

// USED FOR DESIGNS PAGE (to fetch all designs)
router.get('/', authenticateToken, async (req, res) => {
  try {
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
      orderBy: {
        created_at: 'desc',
      },
    }) as any[];

    for (const design of designs) {
      design.connected = design.campaigns.length > 0;
    }

    return res.status(200).json(designs);
  } catch (error) {
    logError(error, { user_id: req.body.user_id });
    return res.status(500).json({ error: InternalServerError });
  }
});

// USED FOR DESIGNS PAGE (to update a design name)
router.put('/:id', authenticateToken, async (req, res) => {

  // validate that the user has the rights to update the design
  const design = await prisma.design.findUnique({
    where: { id: req.params.id },
  });

  if (!design) {
    logWarn(DesignNotFoundError, "PUT /designs/:id", { user_id: req.body.user_id });
    return res.status(404).json({ error: DesignNotFoundError });
  }

  if (design.user_id !== req.body.user_id) {
    logWarn(InsufficientRightsError, "PUT /designs/:id", { user_id: req.body.user_id });
    return res.status(403).json({ error: InsufficientRightsError });
  }

  try {
    await prisma.design.update({
      where: { id: req.params.id },
      data: { name: req.body.design_name },
    });
    return res.status(200).json({ success: "Design name updated" });
  } catch (error) {
    logError(error, { user_id: req.body.user_id });
    return res.status(500).json({ error: InternalServerError });
  }
})

// USED FOR DESIGNS PAGE (to create a design)
router.post('/', authenticateToken, async (req, res) => {
  const { user_id, name, format } = req.body;

  const user = await prisma.user.findUnique({
    where: { id: user_id },
  });

  if (!user) {
    logWarn(UserNotFoundError, "POST /designs", { user_id });
    return res.status(404).json({ error: UserNotFoundError });
  }

  try {
    const newDesign = await prisma.design.create({
      data: {
        name,
        format,
        user_id,
        demo: user.demo,
      }
    });
    return res.status(200).json(newDesign);
  } catch (error) {
    logError(error, { user_id: req.body.user_id });
    return res.status(500).json({ error: InternalServerError });
  }
})

// USED FOR DESIGNS PAGE (to export a design)
router.get('/export/:id', async (req, res) => {
  // Validate that the user has the rights to export the design
  const design = await prisma.design.findUnique({
    where: { id: req.params.id },
  });

  if (!design) {
    logWarn(DesignNotFoundError, "GET /designs/export/:id", { user_id: req.body.user_id });
    return res.status(404).json({ error: DesignNotFoundError });
  }

  if (!design.scene) {
    logWarn(SceneNotFoundError, "GET /designs/export/:id", { user_id: req.body.user_id });
    return res.status(404).json({ error: SceneNotFoundError });
  }

  if (design.user_id !== req.body.user_id) {
    logWarn(InsufficientRightsError, "GET /designs/export/:id", { user_id: req.body.user_id });
    return res.status(403).json({ error: InsufficientRightsError });
  }

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

  try {
    const pdf = await generatePdf([dummyProfile], design.scene);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename=export.pdf');
    res.end(pdf, 'binary');
  } catch (error) {
    logError(error, { user_id: req.body.user_id });
    return res.status(500).json({ error: InternalServerError });
  }
});

// USED FOR DESIGNS PAGE (to duplicate a design)
router.get('/duplicate/:id', async (req, res) => {
  // Validate that the user has the rights to duplicate the design
  const design = await prisma.design.findUnique({
    where: { id: req.params.id },
  });

  if (!design) {
    logWarn(DesignNotFoundError, "GET /designs/duplicate/:id", { user_id: req.body.user_id });
    return res.status(404).json({ error: DesignNotFoundError });
  }

  if (design.user_id !== req.body.user_id) {
    logWarn(InsufficientRightsError, "GET /designs/duplicate/:id", { user_id: req.body.user_id });
    return res.status(403).json({ error: InsufficientRightsError });
  }

  try {
    const newDesign = await prisma.design.create({
      data: {
        name: design.name,
        scene: design.scene,
        user_id: design.user_id,
        thumbnail: design.thumbnail,
        format: design.format,
        demo: design.demo,
      },
    });

    return res.status(200).json(newDesign);
  } catch (error) {
    logError(error, { user_id: req.body.user_id });
    return res.status(500).json({ error: InternalServerError });
  }
});

// USED FOR DESIGNS PAGE (to delete a design)
router.delete('/:id', authenticateToken, async (req, res) => {
  // Validate that the user has the rights to delete the design
  const design = await prisma.design.findUnique({
    where: { id: req.params.id },
  });

  if (!design) {
    logWarn(DesignNotFoundError, "DELETE /designs/:id", { user_id: req.body.user_id });
    return res.status(404).json({ error: DesignNotFoundError });
  }

  try {
    await prisma.$transaction(async (prisma) => {
      await prisma.design.delete({
        where: {
          id: req.params.id,
        },
      });
    });
    return res.status(200).json({ success: "Design deleted" });
  } catch (error) {
    logError(error, { user_id: req.body.user_id });
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