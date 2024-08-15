import { Router } from "express";
import { logtail, prisma } from "../app";
import {
  DesignNotFoundError,
  InsufficientRightsError,
  InternalServerError,
  MissingRequiredParametersError,
  SceneNotFoundError,
  UserNotFoundError,
} from "../errors";
import { s3, generatePdf } from "../functions";
import { Profile } from "@prisma/client";
import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import multer from "multer";
import { authenticateToken } from "./middleware";
import { testProfile } from "../constants";

const router = Router();

// USED FOR DESIGNS PAGE (to fetch all designs)
router.get("/", authenticateToken, async (req, res) => {
  try {
    const user_id = req.body.user_id;
    if (!user_id)
      return res.status(400).json({ error: MissingRequiredParametersError });

    const dbUser = await prisma.user.findUnique({
      where: { id: user_id },
    });

    if (!dbUser) return res.status(404).json({ error: UserNotFoundError });

    const designs = (await prisma.design.findMany({
      where: {
        user_id: dbUser.id,
        demo: dbUser.demo,
      },
      include: {
        campaigns: true,
      },
      orderBy: {
        created_at: "desc",
      },
    })) as any[];

    for (const design of designs) {
      design.connected = design.campaigns.length > 0;
    }

    return res.status(200).json(designs);
  } catch (error) {
    logtail.error(error + "GET /designs");
    return res.status(500).json({ error: InternalServerError });
  }
});

// USED FOR DESIGNS PAGE (to update a design name)
router.put("/:id", authenticateToken, async (req, res) => {
  try {
    // validate that the user has the rights to update the design
    const design = await prisma.design.findUnique({
      where: { id: req.params.id },
    });

    if (!design) {
      return res.status(404).json({ error: DesignNotFoundError });
    }

    if (design.user_id !== req.body.user_id) {
      return res.status(403).json({ error: InsufficientRightsError });
    }

    await prisma.design.update({
      where: { id: req.params.id },
      data: { name: req.body.design_name },
    });
    return res.status(200).json({ success: "Design name updated" });
  } catch (error) {
    logtail.error(error + "PUT /designs/:id");
    return res.status(500).json({ error: InternalServerError });
  }
});

// USED FOR DESIGNS PAGE (to create a design)
router.post("/", authenticateToken, async (req, res) => {
  try {
    const { user_id, name, format } = req.body;

    const user = await prisma.user.findUnique({
      where: { id: user_id },
    });

    if (!user) {
      return res.status(404).json({ error: UserNotFoundError });
    }

    const newDesign = await prisma.design.create({
      data: {
        name,
        format,
        user_id,
        demo: user.demo,
      },
    });
    return res.status(200).json(newDesign);
  } catch (error) {
    logtail.error(error + "POST /designs");
    return res.status(500).json({ error: InternalServerError });
  }
});

// USED FOR DESIGNS PAGE (to export a design)
router.get("/export/:id", async (req, res) => {
  try {
    // Validate that the user has the rights to export the design
    const design = await prisma.design.findUnique({
      where: { id: req.params.id },
    });

    if (!design) {
      return res.status(404).json({ error: DesignNotFoundError });
    }

    if (!design.scene) {
      return res.status(404).json({ error: SceneNotFoundError });
    }

    const pdf = await generatePdf([testProfile], design.scene, design.format);
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=export.pdf");
    res.end(pdf, "binary");
  } catch (error) {
    logtail.error(error + "GET /designs/export/:id");
    return res.status(500).json({ error: InternalServerError });
  }
});

// USED FOR DESIGNS PAGE (to duplicate a design)
router.get("/duplicate/:id", async (req, res) => {
  try {
    // Validate that the user has the rights to duplicate the design
    const design = await prisma.design.findUnique({
      where: { id: req.params.id },
    });

    if (!design) {
      return res.status(404).json({ error: DesignNotFoundError });
    }

    if (design.user_id !== req.body.user_id) {
      return res.status(403).json({ error: InsufficientRightsError });
    }

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
    logtail.error(error + "GET /designs/duplicate/:id");
    return res.status(500).json({ error: InternalServerError });
  }
});

// USED FOR DESIGNS PAGE (to delete a design)
router.delete("/:id", authenticateToken, async (req, res) => {
  try {
    // Validate that the user has the rights to delete the design
    const design = await prisma.design.findUnique({
      where: { id: req.params.id },
    });

    if (!design) {
      return res.status(404).json({ error: DesignNotFoundError });
    }

    await prisma.$transaction(async (prisma) => {
      await prisma.design.delete({
        where: {
          id: req.params.id,
        },
      });
    });
    return res.status(200).json({ success: "Design deleted" });
  } catch (error) {
    logtail.error(error + "DELETE /designs/:id");
    return res.status(500).json({ error: InternalServerError });
  }
});

router.get("/:id", async (req, res) => {
  const user_id = req.body.user_id;
  const { id } = req.params;
  if (!user_id)
    return res.status(400).json({ error: MissingRequiredParametersError });

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
router.post("/:id/upload", upload.single("file"), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, format, width, height } = req.body;
    const file = req.file;

    if (!id || !name || !format || !width || !height || !file) {
      return res.status(400).json({ error: MissingRequiredParametersError });
    }

    const sanitizedName = name.replace(/æ/g, "ae").replace(/ø/g, "oe").replace(/å/g, "aa");

    await prisma.$transaction(async (prisma) => {
      const design = await prisma.design.findUnique({
        where: { id },
      });

      if (!design) {
        return res.status(404).json({ error: DesignNotFoundError });
      }

      const s3Params = {
        Bucket: "uploads",
        Key: `${id}/${sanitizedName}`,
        Body: file.buffer,
        ContentType: format,
      };
      await s3.send(new PutObjectCommand(s3Params));

      const newUpload = await prisma.upload.create({
        data: {
          name: sanitizedName,
          url: `https://rkjrflfwfqhhpwafimbe.supabase.co/storage/v1/object/public/uploads/${id}/${sanitizedName}`,
          user_id: design.user_id,
          format,
          height,
          width,
        },
      });

      res
        .status(201)
        .json({ success: "Upload created successfully", upload: newUpload });
    });
  } catch (error: any) {
    logtail.error(error + "POST /designs/:id/upload");
    return res.status(500).json({ error: InternalServerError });
  }
});

// used for updating thumbnails in the editor
router.post("/:id/thumbnail", upload.single("file"), async (req, res) => {
  try {
    const { id } = req.params;
    const file = req.file;

    if (!id || !file) {
      return res.status(400).json({ error: MissingRequiredParametersError });
    }

    await prisma.$transaction(async (prisma) => {
      const design = await prisma.design.findUnique({
        where: { id },
      });

      if (!design) {
        return res.status(404).json({ error: DesignNotFoundError });
      }

      const s3Params = {
        Bucket: "thumbnails",
        Key: `${id}-thumbnail.jpg`,
        Body: file.buffer,
        ContentType: "image/jpeg",
      };
      await s3.send(new PutObjectCommand(s3Params));

      await prisma.design.update({
        where: { id },
        data: {
          thumbnail: `https://rkjrflfwfqhhpwafimbe.supabase.co/storage/v1/object/public/thumbnails/${id}-thumbnail.jpg`,
        },
      });

      return res.status(200).json({ success: "Thumbnail updated" });
    });
  } catch (error: any) {
    logtail.error(error + "POST /designs/:id/thumbnail");
    return res.status(500).json({ error: InternalServerError });
  }
});

export default router;
