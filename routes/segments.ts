import { Router } from "express";
import { logtail, prisma } from "../app";
import {
  InsufficientRightsError,
  IntegrationNotFoundError,
  InternalServerError,
  MISSING_HEADERS_ERROR,
  MissingRequiredParametersError,
  ParsingError,
  PROFILE_NOT_FOUND_ERROR,
  SegmentNotFoundError,
  UserNotFoundError,
} from "../errors";
import { SegmentDeletedSuccess, SegmentUpdatedSuccess } from "../success";
import { Profile } from "@prisma/client";
import {
  generateUniqueFiveDigitId,
  getKlaviyoSegmentProfilesBySegmentId,
  returnProfilesInRobinson,
} from "../functions";
import { authenticateToken } from "./middleware";
import formidable from "formidable";
import fs from "fs";
import Papa from "papaparse";

const router = Router();

// USED FOR SEGMENTS PAGE (to fetch all segments)
router.get("/", authenticateToken, async (req, res) => {
  try {
    const userId = req.body.user_id;

    const user = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      return res.status(404).json({ error: UserNotFoundError });
    }

    // Fetch all segments for the user
    const segments = await prisma.segment.findMany({
      where: {
        user_id: userId,
        demo: user.demo,
      },
      orderBy: {
        created_at: "desc",
      },
    });

    if (segments.length === 0) {
      return res.status(200).json([]);
    }

    // Fetch all profiles and campaigns related to these segments
    const segmentIds = segments.map((segment) => segment.id);

    // Fetch profile counts for these segments
    const profileCounts = await prisma.profile.groupBy({
      by: ["segment_id"],
      where: {
        segment_id: {
          in: segmentIds,
        },
      },
      _count: {
        _all: true,
      },
    });

    // Fetch in_robinson profile counts for these segments
    const inRobinsonCounts = await prisma.profile.groupBy({
      by: ["segment_id"],
      where: {
        segment_id: {
          in: segmentIds,
        },
        in_robinson: true,
      },
      _count: {
        _all: true,
      },
    });

    // Fetch all campaigns related to these segments
    const campaigns = await prisma.campaign.findMany({
      where: {
        segment_id: {
          in: segmentIds,
        },
      },
    });

    // Create a map for campaign lookups
    const campaignMap = new Map(
      campaigns.map((campaign) => [campaign.segment_id, campaign]),
    );

    // Create a map for profile counts
    const profileCountMap = new Map(
      profileCounts.map((count) => [count.segment_id, count._count._all]),
    );

    // Create a map for in_robinson counts
    const inRobinsonCountMap = new Map(
      inRobinsonCounts.map((count) => [count.segment_id, count._count._all]),
    );

    // Process segments
    const resultSegments = segments.map((segment) => {
      const profile_count = profileCountMap.get(segment.id) || 0;
      const in_robinson_count = inRobinsonCountMap.get(segment.id) || 0;
      const connected = campaignMap.has(segment.id);

      return {
        ...segment,
        profile_count,
        in_robinson_count,
        connected,
      };
    });

    return res.status(200).json(resultSegments);
  } catch (error: any) {
    logtail.error(error + "GET /segments");
    return res.status(500).json({ error: InternalServerError });
  }
});

// USED FOR SEGMENT DETAILS PAGE (to fetch a single segment)
router.get("/:id", authenticateToken, async (req, res) => {
  const segment = (await prisma.segment.findUnique({
    where: { id: req.params.id },
    include: { campaign: true },
  })) as any;

  if (!segment) {
    return res.status(404).json({ error: SegmentNotFoundError });
  }

  if (segment.user_id !== req.body.user_id) {
    return res.status(403).json({ error: InsufficientRightsError });
  }

  const profileCount = await prisma.profile.count({
    where: { segment_id: req.params.id },
  });

  segment.profile_count = profileCount;
  segment.connected = !!segment.campaign;

  return res.status(200).json(segment);
});

// USED FOR SEGMENT DETAILS PAGE (to fetch all profiles in a segment)
router.get("/:id/profiles", authenticateToken, async (req, res) => {
  const page = req.query.page ? parseInt(req.query.page as string) : 1;
  const limit = req.query.limit ? parseInt(req.query.limit as string) : 10;
  const offset = (page - 1) * limit;
  const sort = req.query.sort
    ? (req.query.sort as any).split(":")
    : ["created_at", "desc"];

  const profiles = await prisma.profile.findMany({
    where: {
      segment_id: req.params.id,
    },
    skip: offset,
    take: limit,
    distinct: ["id"], // Ensure uniqueness of profiles
    orderBy: {
      [sort[0]]: sort[1],
    },
  });

  profiles.forEach((profile: any) => {
    profile.name = `${profile.first_name} ${profile.last_name}`;
  });

  return res.status(200).json(profiles);
});

// USED FOR SEGMENTS PAGE (to delete a segment)
router.delete("/:id", authenticateToken, async (req, res) => {
  try {
    // Validate that the user has the rights to delete the segment
    const segment = await prisma.segment.findUnique({
      where: { id: req.params.id },
    });

    if (!segment) {
      return res.status(404).json({ error: SegmentNotFoundError });
    }

    if (segment.user_id !== req.body.user_id) {
      return res.status(403).json({ error: InsufficientRightsError });
    }

    await prisma.$transaction(async (prisma) => {
      await prisma.profile.deleteMany({
        where: {
          segment_id: req.params.id,
        },
      });

      await prisma.segment.delete({
        where: {
          id: req.params.id,
        },
      });
    });
    return res.status(200).json({ success: SegmentDeletedSuccess });
  } catch (error) {
    logtail.error(error + "DELETE /segments/:id");
    return res.status(500).json({ error: InternalServerError });
  }
});

// USED FOR SEGMENT DETAILS PAGE (to delete a segment profile)
router.delete("/profile/:id", authenticateToken, async (req, res) => {
  try {
    // Validate that the user has the rights to delete the segment
    const profile = await prisma.profile.findUnique({
      where: { id: req.params.id },
    });

    if (!profile) {
      return res.status(404).json({ error: SegmentNotFoundError });
    }

    // Validate that the segment is not connected to a campaign
    const segment = await prisma.segment.findUnique({
      where: { id: profile.segment_id },
      include: {
        campaign: true,
      },
    });

    if (!segment) {
      return res.status(404).json({ error: SegmentNotFoundError });
    }

    if (segment.user_id !== req.body.user_id) {
      return res.status(403).json({ error: InsufficientRightsError });
    }

    if (segment.campaign) {
      return res.status(400).json({
        error: "Cannot delete a profile in a segment connected to a campaign",
      });
    }

    await prisma.$transaction(async (prisma) => {
      await prisma.profile.delete({
        where: {
          id: req.params.id,
        },
      });
    });
    return res.status(200).json({ success: SegmentDeletedSuccess });
  } catch (error) {
    logtail.error(error + "DELETE /segments/profile/:id");
    return res.status(500).json({ error: InternalServerError });
  }
});

// USED FOR SEGMENTS PAGE (to update a segment name)
router.put("/:id", authenticateToken, async (req, res) => {
  try {
    // validate that the user has the rights to update the segment
    const segment = await prisma.segment.findUnique({
      where: { id: req.params.id },
    });

    if (!segment) {
      return res.status(404).json({ error: SegmentNotFoundError });
    }

    if (segment.user_id !== req.body.user_id) {
      return res.status(403).json({ error: InsufficientRightsError });
    }

    await prisma.segment.update({
      where: { id: req.params.id },
      data: { name: req.body.segment_name },
    });
    return res.status(200).json({ success: SegmentUpdatedSuccess });
  } catch (error) {
    logtail.error(error + "PUT /segments/:id");
    return res.status(500).json({ error: InternalServerError });
  }
});

// USED FOR SEGMENT DETAILS PAGE (to update a segment profile)
router.put("/profile/:id", authenticateToken, async (req, res) => {
  try {
    // validate that the user has the rights to update the segment
    const profile = await prisma.profile.findUnique({
      where: { id: req.params.id },
    });

    if (!profile) {
      return res.status(404).json({ error: PROFILE_NOT_FOUND_ERROR });
    }

    // Validate that the segment is not connected to a campaign
    const segment = await prisma.segment.findUnique({
      where: { id: profile.segment_id },
      include: {
        campaign: true,
      },
    });

    if (!segment) {
      return res.status(404).json({ error: SegmentNotFoundError });
    }

    if (segment.user_id !== req.body.user_id) {
      return res.status(403).json({ error: InsufficientRightsError });
    }

    if (segment.campaign) {
      return res.status(400).json({
        error: "Cannot update a profile in a segment connected to a campaign",
      });
    }

    await prisma.profile.update({
      where: { id: req.params.id },
      data: {
        first_name: req.body.first_name,
        last_name: req.body.last_name,
        email: req.body.email,
        address: req.body.address,
        city: req.body.city,
        zip_code: req.body.zip_code,
        country: req.body.country,
        custom_variable: req.body.custom_variable,
      },
    });
    return res.status(200).json({ success: SegmentUpdatedSuccess });
  } catch (error) {
    logtail.error(error + "PUT /segments/profile/:id");
    return res.status(500).json({ error: InternalServerError });
  }
});

// USED FOR SEGMENTS PAGE (to import a segment from Klaviyo)
router.post("/klaviyo", async (req, res) => {
  try {
    const { user_id, selected_segment } = req.body;

    if (!user_id || !selected_segment) {
      return res.status(400).json({ error: MissingRequiredParametersError });
    }

    // Step 1: Fetch necessary data outside the transaction
    const user = await prisma.user.findUnique({
      where: { id: user_id },
    });
    if (!user) {
      return res.status(404).json({ error: UserNotFoundError });
    }

    const integration = await prisma.integration.findFirst({
      where: {
        user_id: user.id,
        type: "klaviyo",
      },
    });
    if (!integration || !integration.klaviyo_api_key) {
      return res.status(400).json({ error: IntegrationNotFoundError });
    }

    const klaviyoSegmentProfiles = await getKlaviyoSegmentProfilesBySegmentId(
      selected_segment.id,
      integration.klaviyo_api_key,
    );

    let profilesToAdd = klaviyoSegmentProfiles.validProfiles.map((profile) => ({
      klaviyo_id: profile.id,
      first_name: profile.attributes.first_name,
      last_name: profile.attributes.last_name,
      email: profile.attributes.email,
      address: profile.attributes.location.address1,
      city: profile.attributes.location.city,
      zip_code: profile.attributes.location.zip,
      country: profile.attributes.location.country,
      segment_id: "temp", // Set to temporary value
      in_robinson: false,
      custom_variable: profile.attributes.properties.custom_variable || null,
    }));

    // Step 2: Check profiles against Robinson list
    const profilesInRobinson = await returnProfilesInRobinson(profilesToAdd);

    profilesToAdd = profilesToAdd.map((profile) => ({
      ...profile,
      in_robinson: profilesInRobinson.some(
        (robinsonProfile) => robinsonProfile.email === profile.email,
      ),
    }));

    // Step 3: Perform database operations within a transaction
    let newSegment: any;
    await prisma.$transaction(async (transaction) => {
      newSegment = await transaction.segment.create({
        data: {
          name: selected_segment.attributes.name,
          type: "klaviyo",
          user_id: user.id,
          klaviyo_id: selected_segment.id,
          demo: user.demo,
        },
      });

      // Update the profiles to have the new segment_id
      profilesToAdd = profilesToAdd.map((profile) => ({
        ...profile,
        segment_id: newSegment.id,
      }));

      await transaction.profile.createMany({
        data: profilesToAdd,
      });
    });

    newSegment.profile_count = profilesToAdd.length;
    newSegment.in_robinson_count = profilesToAdd.filter(
      (profile) => profile.in_robinson,
    ).length;

    return res.status(200).json(newSegment);
  } catch (error: any) {
    logtail.error(error + "POST /segments/klaviyo");
    return res.status(500).json({ error: InternalServerError });
  }
});

// USED FOR SEGMENTS PAGE (to import a segment from CSV)
router.post("/csv", async (req, res) => {
  const { user_id } = req.body;

  // Set max file size to 20MB
  const form = formidable({
    multiples: false,
    keepExtensions: true,
    maxFileSize: 20 * 1024 * 1024,
  }); // 20 MB

  form.parse(req, async (err, fields, files) => {
    if (err) {
      return res.status(500).json({ error: ParsingError });
    }

    const segmentName = getSegmentName(fields);
    if (!user_id || !segmentName) {
      return res.status(400).json({ error: MissingRequiredParametersError });
    }

    try {
      const user = await getUser(user_id);
      if (!user) {
        return res.status(404).json({ error: UserNotFoundError });
      }

      if (!files.file) {
        return res.status(400).json({ error: MissingRequiredParametersError });
      }

      const file = Array.isArray(files.file) ? files.file[0] : files.file;
      const fileText = await readFile(file.filepath);
      if (fileText.includes("�")) {
        return res.status(400).json({ error: ParsingError });
      }

      const { data, errors, meta } = parseCSV(fileText);
      if (errors.length) {
        return res.status(400).json({ error: ParsingError });
      }

      const headers = meta.fields;
      if (!headers) {
        return res.status(400).json({ error: ParsingError });
      }

      // Validate the headers and make sure it contains the necessary fields
      const missingHeaders = validateHeaders(headers);
      if (missingHeaders.length > 0) {
        return res.status(400).json({
          error: MISSING_HEADERS_ERROR(missingHeaders),
        });
      }

      // Process the rows and filter out invalid profiles (lowercase, duplicates, unique, etc.)
      const rows = processRows(data);

      // Prepare the profiles to be added to the database
      const profilesToAdd = prepareProfiles(rows);

      // Check the profiles against the Robinson list and mark them accordingly
      const profilesInRobinson = await returnProfilesInRobinson(profilesToAdd);
      markProfilesInRobinson(profilesToAdd, profilesInRobinson);

      // Create the segment and add the profiles to the database
      const newSegmentWithProfiles = await createSegmentWithProfiles(
        user,
        segmentName,
        profilesToAdd,
      );

      return res.status(200).json(newSegmentWithProfiles);
    } catch (error: any) {
      logtail.error(error + "POST /segments/csv");
      return res.status(500).json({ error: InternalServerError });
    }
  });
});

function getSegmentName(fields: any) {
  return Array.isArray(fields.segmentName)
    ? fields.segmentName[0]
    : fields.segmentName;
}

async function getUser(user_id: string) {
  return await prisma.user.findUnique({
    where: { id: user_id },
  });
}

async function readFile(filepath: string) {
  const fileBuffer = await fs.promises.readFile(filepath);
  return new TextDecoder("UTF-8").decode(fileBuffer);
}

function parseCSV(fileText: string) {
  return Papa.parse(fileText, {
    header: true,
    skipEmptyLines: true,
  });
}

function validateHeaders(headers: string[]) {
  const expectedHeaders = [
    "first_name",
    "last_name",
    "address",
    "zip_code",
    "city",
    "email",
    "country",
    "custom_variable",
  ];

  const requiredHeaders = expectedHeaders.filter(
    (header) => header !== "custom_variable",
  );
  return requiredHeaders.filter((header) => !headers.includes(header));
}

function processRows(data: any) {
  const allowedCountries = new Set([
    "denmark",
    "danmark",
    "sweden",
    "sverige",
    "germany",
    "tyskland",
  ]);

  // Function to split names and adjust first and last names
  const splitNames = (row: any) => {
    const firstNames = row.first_name?.toLowerCase().split(" ") || [];
    const firstName = firstNames.shift() || ""; // Get the first name
    const lastName =
      firstNames.length > 0
        ? `${firstNames.join(" ")} ${row.last_name?.toLowerCase()}`
        : row.last_name?.toLowerCase();

    return {
      ...row,
      first_name: firstName,
      last_name: lastName,
    };
  };

  // Function to filter unique emails
  const uniqueByEmail = (rows: any[]) => {
    const emailSet = new Set();
    return rows.filter((profile) => {
      if (emailSet.has(profile.email)) {
        return false;
      } else {
        emailSet.add(profile.email);
        return true;
      }
    });
  };

  // Function to filter unique profiles by address, zip, first name, and last name
  const uniqueByProfile = (rows: any[]) => {
    const uniqueProfilesSet = new Set();
    return rows.filter((profile) => {
      const uniqueProfileKey = JSON.stringify({
        address: profile.address,
        zip: profile.zip,
        first_name: profile.first_name,
        last_name: profile.last_name,
      });

      if (uniqueProfilesSet.has(uniqueProfileKey)) {
        return false;
      } else {
        uniqueProfilesSet.add(uniqueProfileKey);
        return true;
      }
    });
  };

  return data
    .map((row: any) => splitNames(row)) // Adjust first and last names
    .map((row: any) => ({
      first_name: row.first_name?.toLowerCase(),
      last_name: row.last_name?.toLowerCase(),
      email: row.email?.toLowerCase(),
      address: row.address?.toLowerCase(),
      zip: row.zip_code?.toLowerCase(),
      city: row.city?.toLowerCase(),
      country: row.country?.toLowerCase(),
      custom_variable: row.custom_variable?.toLowerCase() || null,
    }))
    .filter((row: any) =>
      Object.values(row).every(
        (cell) => cell !== "" && cell !== null && cell !== undefined,
      ),
    ) // Remove rows with null or empty data
    .filter((row: any) => allowedCountries.has(row.country)) // Filter out incorrect country rows
    .filter(uniqueByEmail) // Filter out duplicate emails
    .filter(uniqueByProfile); // Filter out duplicate profiles
}

function prepareProfiles(rows: any) {
  return rows.map((row: any) => ({
    first_name: row.first_name,
    last_name: row.last_name,
    email: row.email,
    address: row.address,
    city: row.city,
    zip_code: row.zip,
    country: row.country,
    segment_id: "temp",
    in_robinson: false,
    custom_variable: row.custom_variable,
  }));
}

function markProfilesInRobinson(profilesToAdd: any, profilesInRobinson: any) {
  profilesToAdd.forEach((profile: any) => {
    if (
      profilesInRobinson.some(
        (robinsonProfile: any) => robinsonProfile.email === profile.email,
      )
    ) {
      profile.in_robinson = true;
    }
  });
}

async function createSegmentWithProfiles(
  user: any,
  segmentName: any,
  profilesToAdd: any,
) {
  return await prisma.$transaction(async (prisma) => {
    const newSegment = await prisma.segment.create({
      data: {
        name: segmentName,
        type: "csv",
        user_id: user.id,
        demo: user.demo,
      },
    });

    profilesToAdd.forEach((profile: any) => {
      profile.segment_id = newSegment.id;
    });

    await prisma.profile.createMany({
      data: profilesToAdd,
    });

    const newSegmentWithProfiles = (await prisma.segment.findUnique({
      where: { id: newSegment.id },
      include: { profiles: true },
    })) as any;

    if (newSegmentWithProfiles) {
      const profiles = await prisma.profile.findMany({
        where: { segment_id: newSegment.id },
      });

      newSegmentWithProfiles.profile_count = profiles.length;
      newSegmentWithProfiles.in_robinson_count = profiles.filter(
        (profile) => profile.in_robinson,
      ).length;
    }

    return newSegmentWithProfiles;
  });
}

// USED FOR SEGMENTS PAGE (to create a segment from a webhook)
router.post("/webhook", async (req, res) => {
  try {
    const { user_id, segment_name } = req.body;
    if (!user_id || !segment_name)
      return res.status(400).json({ error: MissingRequiredParametersError });

    const user = await prisma.user.findUnique({
      where: { id: user_id },
    });

    if (!user) {
      return res.status(404).json({ error: UserNotFoundError });
    }

    const newSegment = (await prisma.segment.create({
      data: {
        name: segment_name,
        type: "webhook",
        user_id,
        demo: user.demo,
      },
    })) as any;

    // Add profile_count and in_robinson_count to the segment
    const profiles = await prisma.profile.findMany({
      where: { segment_id: newSegment.id },
    });

    newSegment.profile_count = profiles.length;
    newSegment.in_robinson_count = profiles.filter(
      (profile) => profile.in_robinson,
    ).length;

    return res.status(200).json(newSegment);
  } catch (error) {
    logtail.error(error + "POST /segments/webhook");
    return res.status(500).json({ error: InternalServerError });
  }
});

// USED FOR SEGMENTS PAGE (to export a segment)
router.get("/export/:id", async (req, res) => {
  // Validate that the user has the rights to export the segment
  const segment = await prisma.segment.findUnique({
    where: { id: req.params.id },
  });

  if (!segment) {
    return res.status(404).json({ error: SegmentNotFoundError });
  }

  if (segment.user_id !== req.body.user_id) {
    return res.status(403).json({ error: InsufficientRightsError });
  }

  try {
    const { user_id } = req.body;
    const { id } = req.params;
    if (!user_id || !id) {
      return res.status(400).json({ error: MissingRequiredParametersError });
    }

    const segment = await prisma.segment.findUnique({
      where: {
        id,
        user_id,
      },
      include: {
        profiles: true,
      },
    });
    if (!segment) {
      return res.status(404).json({ error: SegmentNotFoundError });
    }

    const headers = [
      "id",
      "first_name",
      "last_name",
      "email",
      "address",
      "city",
      "country",
      "zip_code",
      "in_robinson",
      "custom_variable",
    ];
    let csvContent = headers.join(",") + "\n";

    // Create CSV content
    segment.profiles.forEach((profile: Profile) => {
      const row = [
        generateUniqueFiveDigitId(),
        `"${profile.first_name}"`,
        `"${profile.last_name}"`,
        `"${profile.email}"`,
        `"${profile.address}"`,
        `"${profile.city}"`,
        `"${profile.country}"`,
        `"${profile.zip_code}"`,
        `"${profile.in_robinson ? "Ja" : "Nej"}"`,
        `"${profile.custom_variable}"`,
      ];
      csvContent += row.join(",") + "\n";
    });

    // Return CSV
    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename=${segment.name}.csv`,
    );
    res.send(csvContent);
  } catch (error) {
    logtail.error(error + "GET /segments/export/:id");
    return res.status(500).json({ error: InternalServerError });
  }
});

router.get("/admin", async (req, res) => {
  const segments = await prisma.segment.findMany({
    include: { campaign: true, profiles: true },
    orderBy: {
      created_at: "desc",
    },
  });

  return res.status(200).json(segments);
});

router.get("/klaviyo", async (req, res) => {
  const { user_id } = req.body;
  if (!user_id)
    return res.status(400).json({ error: MissingRequiredParametersError });

  const user = await prisma.user.findUnique({
    where: { id: user_id },
  });
  if (!user) return res.status(404).json({ error: UserNotFoundError });

  const klaviyoIntegration = await prisma.integration.findFirst({
    where: {
      user_id: user.id,
      type: "klaviyo",
    },
  });

  if (klaviyoIntegration?.klaviyo_api_key == null) {
    return res
      .status(400)
      .json({ error: "You need to connect your Klaviyo account first" });
  }

  const options = {
    method: "GET",
    headers: {
      accept: "application/json",
      revision: "2024-02-15",
      Authorization: `Klaviyo-API-Key ${klaviyoIntegration.klaviyo_api_key}`,
    },
  };

  let segments: any = [];
  let nextPageUrl = "https://a.klaviyo.com/api/segments";

  while (nextPageUrl) {
    const response = await fetch(nextPageUrl, options);
    const data: any = await response.json();

    segments = [...segments, ...data.data];

    nextPageUrl = data.links.next;
  }

  return res.status(200).json({ segments });
});

export default router;
