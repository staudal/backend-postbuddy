import { Router } from "express";
import { logtail, prisma } from "../app";
import {
  DuplicateEmailSegmentError,
  DuplicateProfileSegmentError,
  InternalServerError,
  MissingAuthorizationHeaderError,
  MissingRequiredParametersError,
  ProfilesNotFoundError,
  SegmentNotFoundError,
  UserNotFoundError,
} from "../errors";
import { checkIfProfileIsInRobinson } from "../functions";

const router = Router();

router.get("/", async (req, res) => {
  const { user_id } = req.body;
  if (!user_id)
    return res.status(400).json({ error: MissingRequiredParametersError });

  const segments = await prisma.segment.findMany({
    where: {
      user_id,
    },
    select: {
      id: true,
      name: true,
      profiles: {
        select: {
          id: true,
          email: true,
          first_name: true,
          last_name: true,
          address: true,
          zip_code: true,
          city: true,
          country: true,
        },
      },
    },
  });

  res.json(segments);
});

router.delete("/:id", async (req, res) => {
  try {
    const { user_id } = req.body;
    const { id } = req.params;

    if (!user_id)
      return res.status(400).json({ error: MissingRequiredParametersError });

    // validate that the profile belongs to a segment that belongs to the user
    const profile = await prisma.profile.findFirst({
      where: {
        id,
        segment: {
          user_id,
        },
      },
    });

    if (!profile) return res.status(404).json({ error: ProfilesNotFoundError });

    await prisma.profile.delete({
      where: { id },
    });

    res.status(200).json({ success: "Profilen blev slettet" });
  } catch (error: any) {
    logtail.error(error + "DELETE /profiles/:id");
    return res.status(500).json({ error: InternalServerError });
  }
});

router.put("/:id", async (req, res) => {
  try {
    const {
      user_id,
      email,
      first_name,
      last_name,
      address,
      zip_code,
      city,
      country,
      custom_variable,
    } = req.body;
    if (!user_id)
      return res.status(400).json({ error: MissingRequiredParametersError });
    const { id } = req.params;

    // validate that the profile belongs to a segment that belongs to the user
    const profile = await prisma.profile.findFirst({
      where: {
        id,
        segment: {
          user_id,
        },
      },
    });

    if (!profile) return res.status(404).json({ error: ProfilesNotFoundError });

    await prisma.profile.update({
      where: { id },
      data: {
        email,
        first_name,
        last_name,
        address,
        zip_code,
        city,
        country,
        custom_variable,
      },
    });

    res.status(200).json({ success: "Profilen blev opdateret" });
  } catch (error: any) {
    logtail.error(error + "PUT /profiles/:id");
    return res.status(500).json({ error: InternalServerError });
  }
});

router.get("/webhook", async (req, res) => {
  try {
    const {
      segment_id,
      first_name,
      last_name,
      email,
      address,
      city,
      zip,
      country,
      custom_variable,
    } = req.body;
    if (
      !segment_id ||
      !first_name ||
      !last_name ||
      !email ||
      !address ||
      !city ||
      !zip ||
      !country
    )
      return res.status(400).json({ error: MissingRequiredParametersError });

    const authHeader = req.headers.authorization;
    if (!authHeader)
      return res.status(401).json({ error: MissingAuthorizationHeaderError });

    const user = await prisma.user.findFirst({
      where: { access_token: authHeader.split(" ")[1] },
    });
    if (!user) return res.status(401).json({ error: UserNotFoundError });

    const segment = await prisma.segment.findUnique({
      where: { id: segment_id, type: "webhook" },
      include: { campaign: true },
    });
    if (!segment) return res.status(404).json({ error: SegmentNotFoundError });

    // check if segment is connected to a campaign and campaign type is one-off
    if (segment.campaign && segment.campaign.type === "one-off") {
      return res.status(400).json({
        error:
          "Segmentet er tilknyttet en kampagne af typen one-off og kan derfor ikke opdateres",
      });
    }

    // Check if there is already a profile with that email in the segment
    const existingProfile = await prisma.profile.findFirst({
      where: {
        segment_id,
        email,
      },
    });
    if (existingProfile) {
      return res.status(400).json({ error: DuplicateEmailSegmentError });
    }

    // Check if there is already a profile with the same information in the segment
    const duplicateProfile = await prisma.profile.findFirst({
      where: {
        segment_id,
        first_name,
        last_name,
        address,
        zip_code: zip,
      },
    });
    if (duplicateProfile) {
      return res.status(400).json({ error: DuplicateProfileSegmentError });
    }

    try {
      const profile = await prisma.profile.create({
        data: {
          segment_id,
          email,
          first_name,
          last_name,
          address,
          zip_code: zip,
          city,
          country,
          custom_variable: custom_variable || null,
          in_robinson: true,
        },
      });

      const inRobinson = await checkIfProfileIsInRobinson(profile);
      if (!inRobinson) {
        await prisma.profile.update({
          where: { id: profile.id },
          data: {
            in_robinson: false,
          },
        });
      }
    } catch (error: any) {
      logtail.error(`Failed to create profile from webhook: ${error.message}`);
      return res
        .status(500)
        .json({ error: "Der opstod en fejl under oprettelsen af profilen" });
    }

    return res.status(200).json({ success: "Profilen blev oprettet" });
  } catch (error: any) {
    logtail.error(error + "GET /profiles/webhook");
    return res.status(500).json({ error: InternalServerError });
  }
});

export default router;
