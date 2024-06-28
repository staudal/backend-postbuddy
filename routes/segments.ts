import { Router } from 'express';
import { logtail, prisma } from '../app';
import { DuplicateEmailSegmentError, DuplicateProfileSegmentError, IntegrationNotFoundError, InternalServerError, MissingRequiredParametersError, SegmentNotFoundError, UserNotFoundError } from '../errors';
import { Profile } from '@prisma/client';
import { detectDelimiter, generateUniqueFiveDigitId, getKlaviyoSegmentProfilesBySegmentId, returnProfilesInRobinson, splitCSVLine } from '../functions';
import fs from 'fs';
import formidable from 'formidable';
import { KlaviyoSegment } from '../types';

const router = Router();

router.get('/', async (req, res) => {
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

router.get('/admin', async (req, res) => {
  const segments = await prisma.segment.findMany({
    include: { campaign: true, profiles: true },
    orderBy: {
      created_at: 'desc',
    },
  });

  return res.status(200).json(segments);
})

router.delete('/:id', async (req, res) => {
  const user_id = req.body.user_id;
  if (!user_id) return res.status(400).json({ error: MissingRequiredParametersError });

  const segment = await prisma.segment.findUnique({
    where: { id: req.params.id },
  });

  if (!segment) return res.status(404).json({ error: 'Segment not found' });

  if (segment.user_id !== user_id) return res.status(403).json({ error: 'Forbidden' });

  await prisma.profile.deleteMany({
    where: { segment_id: req.params.id },
  });
  await prisma.segment.delete({
    where: { id: req.params.id },
  });

  res.json({ success: 'Segment deleted successfully' });
})

router.put('/:id', async (req, res) => {
  const user_id = req.body.user_id;
  const newName = req.body.segmentName;
  if (!user_id || !newName) return res.status(400).json({ error: MissingRequiredParametersError });

  const segment = await prisma.segment.findUnique({
    where: { id: req.params.id },
  });

  if (!segment) return res.status(404).json({ error: 'Segment not found' });

  if (segment.user_id !== user_id) return res.status(403).json({ error: 'Forbidden' });

  await prisma.segment.update({
    where: { id: req.params.id },
    data: { name: newName },
  });

  res.json({ success: 'Segment updated successfully' });
})

router.get('/export/:id', async (req, res) => {
  const { user_id } = req.body;
  const { id } = req.params;
  if (!user_id) return res.status(400).json({ error: MissingRequiredParametersError });

  const segment = await prisma.segment.findUnique({
    where: {
      id,
      user_id,
    },
    include: {
      profiles: true,
    },
  });
  if (!segment) return res.status(404).json({ error: SegmentNotFoundError });

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
    "custom_variable"
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
  res.setHeader("Content-Disposition", `attachment; filename=${segment.name}.csv`);
  res.send(csvContent);
})

router.get('/klaviyo', async (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: MissingRequiredParametersError });

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
    return res.status(400).json({ error: "You need to connect your Klaviyo account first" });
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
})

router.post('/csv', (req, res) => {
  const { user_id } = req.body;
  const form = formidable({ multiples: false, keepExtensions: true });

  form.parse(req, async (err, fields, files) => {
    if (err) {
      return res.status(500).json({ error: 'Error parsing the file' });
    }

    const segmentName = Array.isArray(fields.segmentName) ? fields.segmentName[0] : fields.segmentName;

    if (!user_id || !segmentName) {
      return res.status(400).json({ error: 'MissingRequiredParametersError' });
    }

    const user = await prisma.user.findUnique({
      where: { id: user_id },
    });
    if (!user) return res.status(404).json({ error: 'UserNotFoundError' });

    if (!files.file) {
      return res.status(400).json({ error: 'File is missing' });
    }

    const file = Array.isArray(files.file) ? files.file[0] : files.file;
    fs.readFile(file.filepath, async (err, fileBuffer) => {
      if (err) {
        return res.status(500).json({ error: 'Error reading the file' });
      }

      const fileText = new TextDecoder("UTF-8").decode(fileBuffer);
      if (fileText.includes('�')) {
        return res.status(400).json({
          error: 'Filen indeholder ugyldige tegn. Prøv at gemme filen som UTF-8 og prøv igen.'
        });
      }

      const expectedHeaders = [
        "first_name",
        "last_name",
        "address",
        "zip",
        "city",
        "email",
        "country",
        "custom_variable"
      ];

      const lines = fileText.split("\n");
      const delimiter = detectDelimiter(lines[0]);
      const headers = splitCSVLine(lines[0], delimiter);

      const missingHeaders = expectedHeaders.filter(
        (header) => !headers.includes(header)
      );

      if (missingHeaders.includes("custom_variable")) {
        missingHeaders.splice(missingHeaders.indexOf("custom_variable"), 1);
      }

      if (missingHeaders.length > 0) {
        return res.status(400).json({
          error: `Ugyldig CSV format. Følgende kolonner mangler: ${missingHeaders.join(", ")}`
        });
      }

      const headerIndices = new Map(
        headers.map((header, index) => [header, index])
      );

      let rows = lines.slice(1) // Start processing after the header line
        .map((line) => splitCSVLine(line, delimiter))
        .map((row) => ({
          first_name: row[headerIndices.get("first_name") || 0]?.toLowerCase(),
          last_name: row[headerIndices.get("last_name") || 0]?.toLowerCase(),
          email: row[headerIndices.get("email") || 0]?.toLowerCase(),
          address: row[headerIndices.get("address") || 0]?.toLowerCase(),
          zip: row[headerIndices.get("zip") || 0]?.toLowerCase(),
          city: row[headerIndices.get("city") || 0]?.toLowerCase(),
          country: row[headerIndices.get("country") || 0]?.toLowerCase(),
          custom_variable: headerIndices.has("custom_variable") ? row[headerIndices.get("custom_variable") || 0]?.toLowerCase() : null
        }))
        .filter((row) =>
          Object.values(row).every((cell) => cell !== "" && cell !== undefined)
        );

      const wrongCountries = rows.filter((row) => row.country !== "denmark" && row.country !== "danmark" && row.country !== "sweden" && row.country !== "sverige" && row.country !== "germany" && row.country !== "tyskland");
      rows = rows.filter((row) => row.country === "denmark" || row.country === "danmark" || row.country === "sweden" || row.country === "sverige" || row.country === "germany" || row.country === "tyskland");

      // Filter out duplicate emails
      const emailSet = new Set();
      rows = rows.filter((profile) => {
        if (emailSet.has(profile.email)) {
          return false;
        } else {
          emailSet.add(profile.email);
          return true;
        }
      });

      // Filter out duplicate address + zip + first name + last name
      const uniqueProfilesSet = new Set();
      rows = rows.filter((profile) => {
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

      const newSegment = await prisma.segment.create({
        data: {
          name: segmentName,
          type: "csv",
          user_id: user.id,
          demo: user.demo,
        },
      });

      const profilesToAdd = rows.map((row) => ({
        first_name: row.first_name,
        last_name: row.last_name,
        email: row.email,
        address: row.address,
        city: row.city,
        zip_code: row.zip,
        country: row.country,
        segment_id: newSegment.id,
        in_robinson: false,
        custom_variable: row.custom_variable
      }));

      const uniqueProfilesToAdd = Array.from(
        profilesToAdd.reduce((map, profile) => map.set(JSON.stringify(profile), profile), new Map()).values()
      );

      const profilesInRobinson = await returnProfilesInRobinson(uniqueProfilesToAdd);

      uniqueProfilesToAdd.forEach((profile) => {
        if (profilesInRobinson.some((robinsonProfile) => robinsonProfile === profile)) {
          profile.in_robinson = true;
        }
      });

      await prisma.profile.createMany({
        data: uniqueProfilesToAdd.map((profile) => ({
          first_name: profile.first_name.toLowerCase(),
          last_name: profile.last_name.toLowerCase(),
          email: profile.email.toLowerCase(),
          address: profile.address.toLowerCase(),
          city: profile.city.toLowerCase(),
          zip_code: profile.zip_code.toLowerCase(),
          country: profile.country.toLowerCase(),
          segment_id: newSegment.id,
          in_robinson: profile.in_robinson,
          custom_variable: profile.custom_variable || null,
          demo: newSegment.demo,
        })),
      });

      if (wrongCountries.length > 0) {
        return res.status(201).json({
          response: `Segmentet blev importeret, men ${wrongCountries.length} profil(er) blev sprunget over, da de ikke er fra Danmark, Sverige eller Tyskland.`
        });
      } else {
        return res.status(201).json({
          response: "Segmentet blev importeret!"
        });
      }
    });
  });
});


router.post('/klaviyo', async (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: MissingRequiredParametersError });

  const selected_segment = req.body.selected_segment as KlaviyoSegment

  if (!selected_segment) return res.status(400).json({ error: MissingRequiredParametersError });

  const user = await prisma.user.findUnique({
    where: { id: user_id },
  });
  if (!user) return res.status(404).json({ error: UserNotFoundError });

  const integration = await prisma.integration.findFirst({
    where: {
      user_id: user.id,
      type: "klaviyo",
    },
  });
  if (!integration || !integration.klaviyo_api_key) return res.status(400).json({ error: IntegrationNotFoundError });

  const klaviyoSegmentProfiles = await getKlaviyoSegmentProfilesBySegmentId(
    selected_segment.id,
    integration.klaviyo_api_key
  );

  const newSegment = await prisma.segment.create({
    data: {
      name: selected_segment.attributes.name,
      type: "klaviyo",
      user_id: user.id,
      klaviyo_id: selected_segment.id,
      demo: user.demo,
    },
  });

  let profilesToAdd = klaviyoSegmentProfiles.validProfiles.map((profile) => ({
    id: profile.id,
    first_name: profile.attributes.first_name,
    last_name: profile.attributes.last_name,
    email: profile.attributes.email,
    address: profile.attributes.location.address1,
    city: profile.attributes.location.city,
    zip_code: profile.attributes.location.zip,
    country: profile.attributes.location.country,
    segment_id: newSegment.id,
    in_robinson: false,
    custom_variable: profile.attributes.properties.custom_variable || null,
  }));

  const profilesInRobinson = await returnProfilesInRobinson(profilesToAdd);

  // filter the profiles in robinson into the profilesToAdd array and set in_robinson to true
  profilesToAdd.forEach((profile) => {
    if (
      profilesInRobinson.some((robinsonProfile) => robinsonProfile === profile)
    ) {
      profile.in_robinson = true;
    }
  });

  // create the new profiles
  await prisma.profile.createMany({
    data: profilesToAdd.map((profile) => ({
      klaviyo_id: profile.id,
      first_name: profile.first_name.toLowerCase(),
      last_name: profile.last_name.toLowerCase(),
      email: profile.email.toLowerCase(),
      address: profile.address.toLowerCase(),
      city: profile.city.toLowerCase(),
      zip_code: profile.zip_code,
      country: profile.country.toLowerCase(),
      segment_id: newSegment.id,
      in_robinson: profile.in_robinson,
      custom_variable: profile.custom_variable || null,
      demo: newSegment.demo,
    })),
  });

  await prisma.segment.findUnique({
    where: { id: newSegment.id },
    include: { profiles: true, campaign: true },
  });

  res.status(200).json({ success: 'Segment created successfully', skipped_profiles: klaviyoSegmentProfiles.skippedProfiles, reason: klaviyoSegmentProfiles.reason });
})


router.post('/webhook', async (req, res) => {
  const { user_id, name } = req.body;
  if (!user_id || !name) return res.status(400).json({ error: MissingRequiredParametersError });

  const user = await prisma.user.findUnique({
    where: { id: user_id },
  });
  if (!user) return res.status(404).json({ error: UserNotFoundError });

  await prisma.segment.create({
    data: {
      name,
      type: "webhook",
      user_id: user.id,
      demo: user.demo,
    },
  });

  return res.status(200).json({ success: 'Segment created successfully' });
})

export default router;