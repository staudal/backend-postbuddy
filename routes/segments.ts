import { Router } from 'express';
import { logtail, prisma } from '../app';
import { InsufficientRightsError, IntegrationNotFoundError, InternalServerError, MissingRequiredParametersError, ParsingError, SegmentNotFoundError, UserNotFoundError } from '../errors';
import { SegmentCreatedSuccess, SegmentDeletedSuccess, SegmentImportedSuccess, SegmentUpdatedSuccess } from '../success';
import { Profile } from '@prisma/client';
import { detectDelimiter, generateUniqueFiveDigitId, getKlaviyoSegmentProfilesBySegmentId, returnProfilesInRobinson, splitCSVLine } from '../functions';
import { KlaviyoSegment } from '../types'; import { supabase } from '../constants';
import { authenticateToken } from './middleware';
import formidable from 'formidable';
import fs from 'fs';

const router = Router();

// USED FOR SEGMENTS PAGE (to fetch all segments)
router.get('/', authenticateToken, async (req, res) => {
  // Fetch the segments
  const { data: segments, error: segmentsError } = await supabase
    .from('segments')
    .select('*')
    .order('created_at', { ascending: false })
    .eq('user_id', req.body.user_id);

  if (segmentsError) {
    console.error(segmentsError);
    return res.status(500).json({ error: 'InternalServerError' });
  }

  // Fetch profile counts and in_robinson counts for each segment
  const segmentsWithCounts = await Promise.all(segments.map(async (segment) => {
    const { count: profileCount, error: profileCountError } = await supabase
      .from('profiles')
      .select('id', { count: 'exact' })
      .eq('segment_id', segment.id);

    const { count: robinsonCount, error: robinsonCountError } = await supabase
      .from('profiles')
      .select('id', { count: 'exact' })
      .eq('segment_id', segment.id)
      .eq('in_robinson', true);

    if (profileCountError || robinsonCountError) {
      console.error(profileCountError || robinsonCountError);
      return { ...segment, profile_count: 0, in_robinson_count: 0 };
    }

    return {
      ...segment,
      profile_count: profileCount,
      in_robinson_count: robinsonCount,
    };
  }));

  return res.status(200).json(segmentsWithCounts);
});

// USED FOR SEGMENT DETAILS PAGE (to fetch a single segment)
router.get('/:id', authenticateToken, async (req, res) => {
  const { data, error } = await supabase
    .from('segments')
    .select('*')
    .eq('id', req.params.id)
    .single()

  // Add profile_count to the segment (used for the segment details page)
  if (data) {
    const { data: profiles, error: profilesError } = await supabase
      .from('profiles')
      .select('id')
      .eq('segment_id', req.params.id)

    if (profilesError) {
      console.error(profilesError);
      return res.status(500).json({ error: InternalServerError });
    }

    (data as any).profile_count = profiles.length;
  }

  if (error) {
    console.error(error);
    return res.status(500).json({ error: InternalServerError });
  }

  return res.status(200).json(data);
})

// USED FOR SEGMENTS PAGE (to fetch all profiles in a segment)
router.get('/:id/profiles', authenticateToken, async (req, res) => {
  const page = req.query.page ? parseInt(req.query.page as string) : 1;
  const limit = req.query.limit ? parseInt(req.query.limit as string) : 10;
  const offset = (page - 1) * limit;

  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('segment_id', req.params.id)
    .range(offset, offset + limit - 1)
    .order('created_at', { ascending: false })

  if (error) {
    console.error(error);
    return res.status(500).json({ error: InternalServerError });
  }

  return res.status(200).json(data);
})

// USED FOR SEGMENTS PAGE (to delete a segment)
router.delete('/:id', authenticateToken, async (req, res) => {
  const { error } = await supabase
    .from('segments')
    .delete()
    .eq('id', req.params.id)

  if (error) {
    console.error(error);
    return res.status(500).json({ error: InternalServerError });
  }

  return res.status(200).json({ success: SegmentDeletedSuccess });
})

// USED FOR SEGMENTS PAGE (to update a segment name)
router.put('/:id', authenticateToken, async (req, res) => {
  const { error } = await supabase
    .from('segments')
    .update({ name: req.body.segment_name })
    .eq('id', req.params.id)

  if (error) {
    console.error(error);
    return res.status(500).json({ error: InternalServerError });
  }

  return res.status(200).json({ success: SegmentUpdatedSuccess });
})

// USED FOR SEGMENTS PAGE (to import a segment from Klaviyo)
router.post('/klaviyo', async (req, res) => {
  try {
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

    const { data: newSegment, error } = await supabase
      .from('segments')
      .insert({
        name: selected_segment.attributes.name,
        type: "klaviyo",
        user_id: user.id,
        klaviyo_id: selected_segment.id,
        demo: user.demo,
      })
      .select('id, demo')
      .single();

    if (error) {
      console.error(error);
      return res.status(500).json({ error: InternalServerError });
    }

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

    const { error: profilesError } = await supabase
      .from('profiles')
      .insert([
        ...profilesToAdd.map((profile) => ({
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
      ]);

    if (profilesError) {
      console.error(profilesError);
      return res.status(500).json({ error: InternalServerError });
    }

    res.status(200).json({ success: SegmentImportedSuccess, skipped_profiles: klaviyoSegmentProfiles.skippedProfiles, reason: klaviyoSegmentProfiles.reason });
  } catch (error: any) {
    logtail.error(error);
    res.status(500).json({ error: InternalServerError });
  }
})

// USED FOR SEGMENTS PAGE (to import a segment from CSV)
router.post('/csv', (req, res) => {
  const { user_id } = req.body;
  const form = formidable({ multiples: false, keepExtensions: true });

  form.parse(req, async (err, fields, files) => {
    if (err) {
      return res.status(500).json({ error: ParsingError });
    }

    const segmentName = Array.isArray(fields.segmentName) ? fields.segmentName[0] : fields.segmentName;

    if (!user_id || !segmentName) {
      return res.status(400).json({ error: MissingRequiredParametersError });
    }

    const user = await prisma.user.findUnique({
      where: { id: user_id },
    });
    if (!user) return res.status(404).json({ error: UserNotFoundError });

    if (!files.file) {
      return res.status(400).json({ error: MissingRequiredParametersError });
    }

    const file = Array.isArray(files.file) ? files.file[0] : files.file;
    fs.readFile(file.filepath, async (err, fileBuffer) => {
      if (err) {
        return res.status(500).json({ error: ParsingError });
      }

      const fileText = new TextDecoder("UTF-8").decode(fileBuffer);
      if (fileText.includes('�')) {
        return res.status(400).json({
          error: ParsingError
        });
      }

      const expectedHeaders = [
        "first_name",
        "last_name",
        "address",
        "zip_code",
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
          zip: row[headerIndices.get("zip_code") || 0]?.toLowerCase(),
          city: row[headerIndices.get("city") || 0]?.toLowerCase(),
          country: row[headerIndices.get("country") || 0]?.toLowerCase(),
          custom_variable: headerIndices.has("custom_variable") ? row[headerIndices.get("custom_variable") || 0]?.toLowerCase() : null
        }))
        .filter((row) =>
          Object.values(row).every((cell) => cell !== "" && cell !== undefined)
        );

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

      const { data: newSegment, error: newSegmentError } = await supabase
        .from('segments')
        .insert({
          name: segmentName,
          type: "csv",
          user_id: user.id,
          demo: user.demo,
        })
        .select('id, demo')
        .single();

      if (newSegmentError) {
        console.error(newSegmentError);
        return res.status(500).json({ error: InternalServerError });
      }

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

      const { error: profilesError } = await supabase
        .from('profiles')
        .insert([
          ...uniqueProfilesToAdd.map((profile) => ({
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
        ]);

      if (profilesError) {
        console.error(profilesError);
        return res.status(500).json({ error: InternalServerError });
      }

      const { data: newSegmentWithProfiles, error: newSegmentWithProfilesError } = await supabase
        .from('segments')
        .select('*')
        .eq('id', newSegment.id)
        .single() as any;

      if (newSegmentWithProfilesError) {
        console.error(newSegmentWithProfilesError);
        return res.status(500).json({ error: InternalServerError });
      }

      // add profile_count and in_robinson_count to the segment
      const { count: profileCount, error: profileCountError } = await supabase
        .from('profiles')
        .select('id', { count: 'exact' })
        .eq('segment_id', newSegment.id);

      const { count: robinsonCount, error: robinsonCountError } = await supabase
        .from('profiles')
        .select('id', { count: 'exact' })
        .eq('segment_id', newSegment.id)
        .eq('in_robinson', true);

      if (profileCountError || robinsonCountError) {
        console.error(profileCountError || robinsonCountError);
        return res.status(500).json({ error: InternalServerError });
      }

      newSegmentWithProfiles.profile_count = profileCount;
      newSegmentWithProfiles.in_robinson_count = robinsonCount;
      console.log(newSegmentWithProfiles);

      return res.status(201).json(newSegmentWithProfiles);
    });
  });
});

router.get('/admin', async (req, res) => {
  const segments = await prisma.segment.findMany({
    include: { campaign: true, profiles: true },
    orderBy: {
      created_at: 'desc',
    },
  });

  return res.status(200).json(segments);
})

router.put('/:id', async (req, res) => {
  const user_id = req.body.user_id;
  const newName = req.body.segmentName;
  if (!user_id || !newName) return res.status(400).json({ error: MissingRequiredParametersError });

  const segment = await prisma.segment.findUnique({
    where: { id: req.params.id },
  });

  if (!segment) return res.status(404).json({ error: SegmentNotFoundError });

  if (segment.user_id !== user_id) return res.status(403).json({ error: InsufficientRightsError });

  await prisma.segment.update({
    where: { id: req.params.id },
    data: { name: newName },
  });

  res.json({ success: SegmentUpdatedSuccess });
})

// USED FOR SEGMENTS PAGE (to export a segment)
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

// USED FOR SEGMENTS PAGE (to create a segment from a webhook)
router.post('/webhook', async (req, res) => {
  const { user_id, segment_name } = req.body;
  if (!user_id || !segment_name) return res.status(400).json({ error: MissingRequiredParametersError });

  const { data: newSegment, error: newSegmentError } = await supabase
    .from('segments')
    .insert({
      name: segment_name,
      type: "webhook",
      user_id,
      demo: false,
    })
    .select('*')
    .single();

  if (newSegmentError) {
    console.error(newSegmentError);
    return res.status(500).json({ error: InternalServerError });
  }

  return res.status(200).json(newSegment);
})

export default router;