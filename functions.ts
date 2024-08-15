import { Campaign, Design, PrismaClient, Profile, User } from "@prisma/client";
import { KlaviyoSegmentProfile, Order, ProfileToAdd } from "./types";
import { Order as PrismaOrder } from "@prisma/client";
import Stripe from "stripe";
import {
  ErrorWithStatusCode,
  FailedToBillUserError,
  FailedToGeneratePdfError,
  FailedToSendPdfToPrintPartnerError,
  FailedToUpdateProfilesToSentError,
  MissingSubscriptionError,
} from "./errors";
import CreativeEngine, * as CESDK from "@cesdk/node";
import { MimeType } from "@cesdk/node";
import { PDFDocument } from "pdf-lib";
import Client from "ssh2-sftp-client";
import { createHmac } from "node:crypto";
import { config } from "./constants";
import { logtail } from "./app";
import { subDays } from "date-fns";
import { S3Client } from "@aws-sdk/client-s3";
import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

export const prisma = new PrismaClient({
  transactionOptions: {
    timeout: 10000,
  },
});

export const s3 = new S3Client({
  forcePathStyle: true,
  region: "eu-central-1",
  endpoint: "https://rkjrflfwfqhhpwafimbe.supabase.co/storage/v1/s3",
  credentials: {
    accessKeyId: "317fb0867435e048caf40891fe400b38",
    secretAccessKey:
      "8e2d04c347e7c863edeebb42a1e7db32bae73d6ee922103b24e61d2b7d5d4b50",
  },
});

export async function billUserForLettersSent(
  profilesLength: number,
  user_id: string,
) {
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  if (!STRIPE_SECRET_KEY) {
    throw new ErrorWithStatusCode("Stripe secret key is missing", 500);
  }

  const stripe = new Stripe(STRIPE_SECRET_KEY);
  const subscription = await prisma.subscription.findFirst({
    where: { user_id },
  });
  if (!subscription) {
    logtail.error(
      `User ${user_id} does not have an active subscription and cannot be billed for letters sent`,
    );
    throw new ErrorWithStatusCode(MissingSubscriptionError, 400);
  }

  const usageRecord = await stripe.subscriptionItems.createUsageRecord(
    subscription.subscription_item_id,
    {
      quantity: profilesLength,
      timestamp: Math.floor(Date.now() / 1000),
      action: "increment",
    },
  );

  if (!usageRecord) {
    logtail.error(
      `User with id ${user_id} has a subscription but could not be billed for letters sent`,
    );
    throw new ErrorWithStatusCode(FailedToBillUserError, 500);
  }
}

export function generateBleedLines(
  engine: CreativeEngine,
  pages: number[],
  pageWidth: number,
  pageHeight: number,
) {
  for (const page of pages) {
    const bottomRightHorizontalBlackBleedLine = engine.block.create("graphic");
    engine.block.setShape(
      bottomRightHorizontalBlackBleedLine,
      engine.block.createShape("rect"),
    );
    engine.block.setFill(
      bottomRightHorizontalBlackBleedLine,
      engine.block.createFill("color"),
    );
    engine.block.setWidth(bottomRightHorizontalBlackBleedLine, 5);
    engine.block.setHeight(bottomRightHorizontalBlackBleedLine, 0.25);
    engine.block.setPositionX(bottomRightHorizontalBlackBleedLine, pageWidth);
    engine.block.setPositionY(bottomRightHorizontalBlackBleedLine, pageHeight);
    engine.block.setFillSolidColor(
      bottomRightHorizontalBlackBleedLine,
      0,
      0,
      0,
      1,
    );
    engine.block.appendChild(page, bottomRightHorizontalBlackBleedLine);
    const bottomRightVerticalBlackBleedLine = engine.block.duplicate(
      bottomRightHorizontalBlackBleedLine,
    );
    engine.block.setWidth(bottomRightVerticalBlackBleedLine, 0.25);
    engine.block.setHeight(bottomRightVerticalBlackBleedLine, 5);
    engine.block.setPositionX(bottomRightVerticalBlackBleedLine, pageWidth);
    engine.block.setPositionY(bottomRightVerticalBlackBleedLine, pageHeight);
    const bottomRightHorizontalWhiteBleedLine = engine.block.duplicate(
      bottomRightHorizontalBlackBleedLine,
    );
    engine.block.setWidth(bottomRightHorizontalWhiteBleedLine, 5);
    engine.block.setHeight(bottomRightHorizontalWhiteBleedLine, 0.25);
    engine.block.setPositionX(bottomRightHorizontalWhiteBleedLine, pageWidth);
    engine.block.setPositionY(
      bottomRightHorizontalWhiteBleedLine,
      pageHeight - 0.25,
    );
    engine.block.setFillSolidColor(
      bottomRightHorizontalWhiteBleedLine,
      1,
      1,
      1,
      1,
    );
    const bottomRightVerticalWhiteBleedLine = engine.block.duplicate(
      bottomRightHorizontalBlackBleedLine,
    );
    engine.block.setWidth(bottomRightVerticalWhiteBleedLine, 0.25);
    engine.block.setHeight(bottomRightVerticalWhiteBleedLine, 5);
    engine.block.setPositionX(
      bottomRightVerticalWhiteBleedLine,
      pageWidth - 0.25,
    );
    engine.block.setPositionY(bottomRightVerticalWhiteBleedLine, pageHeight);
    engine.block.setFillSolidColor(
      bottomRightVerticalWhiteBleedLine,
      1,
      1,
      1,
      1,
    );

    // Top left
    const topLeftHorizontalBlackBleedLine = engine.block.duplicate(
      bottomRightHorizontalBlackBleedLine,
    );
    engine.block.setWidth(topLeftHorizontalBlackBleedLine, 5);
    engine.block.setHeight(topLeftHorizontalBlackBleedLine, 0.25);
    engine.block.setPositionX(topLeftHorizontalBlackBleedLine, -5);
    engine.block.setPositionY(topLeftHorizontalBlackBleedLine, -0.25);
    const topLeftVerticalBlackBleedLine = engine.block.duplicate(
      bottomRightHorizontalBlackBleedLine,
    );
    engine.block.setWidth(topLeftVerticalBlackBleedLine, 0.25);
    engine.block.setHeight(topLeftVerticalBlackBleedLine, 5);
    engine.block.setPositionX(topLeftVerticalBlackBleedLine, -0.25);
    engine.block.setPositionY(topLeftVerticalBlackBleedLine, -5);
    const topLeftHorizontalWhiteBleedLine = engine.block.duplicate(
      bottomRightHorizontalBlackBleedLine,
    );
    engine.block.setWidth(topLeftHorizontalWhiteBleedLine, 5);
    engine.block.setHeight(topLeftHorizontalWhiteBleedLine, 0.25);
    engine.block.setPositionX(topLeftHorizontalWhiteBleedLine, -5);
    engine.block.setPositionY(topLeftHorizontalWhiteBleedLine, 0);
    engine.block.setFillSolidColor(topLeftHorizontalWhiteBleedLine, 1, 1, 1, 1);
    const topLeftVerticalWhiteBleedLine = engine.block.duplicate(
      bottomRightHorizontalBlackBleedLine,
    );
    engine.block.setWidth(topLeftVerticalWhiteBleedLine, 0.25);
    engine.block.setHeight(topLeftVerticalWhiteBleedLine, 5);
    engine.block.setPositionX(topLeftVerticalWhiteBleedLine, 0);
    engine.block.setPositionY(topLeftVerticalWhiteBleedLine, -5);
    engine.block.setFillSolidColor(topLeftVerticalWhiteBleedLine, 1, 1, 1, 1);

    // Top right
    const topRightHorizontalBlackBleedLine = engine.block.duplicate(
      bottomRightHorizontalBlackBleedLine,
    );
    engine.block.setWidth(topRightHorizontalBlackBleedLine, 5);
    engine.block.setHeight(topRightHorizontalBlackBleedLine, 0.25);
    engine.block.setPositionX(topRightHorizontalBlackBleedLine, pageWidth);
    engine.block.setPositionY(topRightHorizontalBlackBleedLine, -0.25);
    const topRightVerticalBlackBleedLine = engine.block.duplicate(
      bottomRightHorizontalBlackBleedLine,
    );
    engine.block.setWidth(topRightVerticalBlackBleedLine, 0.25);
    engine.block.setHeight(topRightVerticalBlackBleedLine, 5);
    engine.block.setPositionX(topRightVerticalBlackBleedLine, pageWidth);
    engine.block.setPositionY(topRightVerticalBlackBleedLine, -5);
    const topRightHorizontalWhiteBleedLine = engine.block.duplicate(
      bottomRightHorizontalBlackBleedLine,
    );
    engine.block.setWidth(topRightHorizontalWhiteBleedLine, 5);
    engine.block.setHeight(topRightHorizontalWhiteBleedLine, 0.25);
    engine.block.setPositionX(topRightHorizontalWhiteBleedLine, pageWidth);
    engine.block.setPositionY(topRightHorizontalWhiteBleedLine, 0);
    engine.block.setFillSolidColor(
      topRightHorizontalWhiteBleedLine,
      1,
      1,
      1,
      1,
    );
    const topRightVerticalWhiteBleedLine = engine.block.duplicate(
      bottomRightHorizontalBlackBleedLine,
    );
    engine.block.setWidth(topRightVerticalWhiteBleedLine, 0.25);
    engine.block.setHeight(topRightVerticalWhiteBleedLine, 5);
    engine.block.setPositionX(topRightVerticalWhiteBleedLine, pageWidth - 0.25);
    engine.block.setPositionY(topRightVerticalWhiteBleedLine, -5);
    engine.block.setFillSolidColor(topRightVerticalWhiteBleedLine, 1, 1, 1, 1);

    // Bottom left
    const bottomLeftHorizontalBlackBleedLine = engine.block.duplicate(
      bottomRightHorizontalBlackBleedLine,
    );
    engine.block.setWidth(bottomLeftHorizontalBlackBleedLine, 5);
    engine.block.setHeight(bottomLeftHorizontalBlackBleedLine, 0.25);
    engine.block.setPositionX(bottomLeftHorizontalBlackBleedLine, -5);
    engine.block.setPositionY(bottomLeftHorizontalBlackBleedLine, pageHeight);
    const bottomLeftVerticalBlackBleedLine = engine.block.duplicate(
      bottomRightHorizontalBlackBleedLine,
    );
    engine.block.setWidth(bottomLeftVerticalBlackBleedLine, 0.25);
    engine.block.setHeight(bottomLeftVerticalBlackBleedLine, 5);
    engine.block.setPositionX(bottomLeftVerticalBlackBleedLine, -0.25);
    engine.block.setPositionY(bottomLeftVerticalBlackBleedLine, pageHeight);
    const bottomLeftHorizontalWhiteBleedLine = engine.block.duplicate(
      bottomRightHorizontalBlackBleedLine,
    );
    engine.block.setWidth(bottomLeftHorizontalWhiteBleedLine, 5);
    engine.block.setHeight(bottomLeftHorizontalWhiteBleedLine, 0.25);
    engine.block.setPositionX(bottomLeftHorizontalWhiteBleedLine, -5);
    engine.block.setPositionY(
      bottomLeftHorizontalWhiteBleedLine,
      pageHeight - 0.25,
    );
    engine.block.setFillSolidColor(
      bottomLeftHorizontalWhiteBleedLine,
      1,
      1,
      1,
      1,
    );
    const bottomLeftVerticalWhiteBleedLine = engine.block.duplicate(
      bottomRightHorizontalBlackBleedLine,
    );
    engine.block.setWidth(bottomLeftVerticalWhiteBleedLine, 0.25);
    engine.block.setHeight(bottomLeftVerticalWhiteBleedLine, 5);
    engine.block.setPositionX(bottomLeftVerticalWhiteBleedLine, 0);
    engine.block.setPositionY(bottomLeftVerticalWhiteBleedLine, pageHeight);
    engine.block.setFillSolidColor(
      bottomLeftVerticalWhiteBleedLine,
      1,
      1,
      1,
      1,
    );
  }
}

export function updateFirstName(engine: CreativeEngine, profile: Profile) {
  const firstName = profile.first_name.split(" ")[0];
  const formattedFirstName =
    firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase();
  engine.variable.setString("Fornavn", formattedFirstName);
}

export function updateLastName(engine: CreativeEngine, profile: Profile) {
  const nameParts = profile.last_name.split(" ");
  const lastName = nameParts[nameParts.length - 1];
  const formattedLastName =
    lastName.charAt(0).toUpperCase() + lastName.slice(1).toLowerCase();
  engine.variable.setString("Efternavn", formattedLastName);
}

export function updateEmail(engine: CreativeEngine, profile: Profile) {
  engine.variable.setString("Email", profile.email);
}

export function updateAddress(engine: CreativeEngine, profile: Profile) {
  const formattedAddress = profile.address
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
  engine.variable.setString("Adresse", formattedAddress);
}

export function updateCity(engine: CreativeEngine, profile: Profile) {
  const city =
    profile.city.charAt(0).toUpperCase() + profile.city.slice(1).toLowerCase();
  engine.variable.setString("By", city);
}

export function updateZipCode(engine: CreativeEngine, profile: Profile) {
  engine.variable.setString("Postnummer", profile.zip_code);
}

export function updateCountry(engine: CreativeEngine, profile: Profile) {
  const country =
    profile.country.charAt(0).toUpperCase() +
    profile.country.slice(1).toLowerCase();
  engine.variable.setString("Land", country);
}

export function updateCustomVariable(engine: CreativeEngine, profile: Profile) {
  if (profile.custom_variable) {
    engine.variable.setString("Custom", profile.custom_variable);
  }
}

export function updateCompany(engine: CreativeEngine, profile: Profile) {
  if (profile.company) {
    engine.variable.setString("Virksomhed", profile.company);
  }
}

export function updateVariables(engine: CreativeEngine, profile: Profile) {
  updateFirstName(engine, profile);
  updateLastName(engine, profile);
  updateEmail(engine, profile);
  updateAddress(engine, profile);
  updateCity(engine, profile);
  updateZipCode(engine, profile);
  updateCountry(engine, profile);
  updateCustomVariable(engine, profile);
  updateCompany(engine, profile);
}

export function generateIdBlock(
  idText: number,
  engine: CreativeEngine,
  pageWidth: number,
  pageHeight: number,
  pages: number[] = [],
  profile?: Profile,
) {
  if (pages[1]) {
    // Add background to id text
    const idBackground = engine.block.create("graphic");
    engine.block.setShape(idBackground, engine.block.createShape("rect"));
    engine.block.setFill(idBackground, engine.block.createFill("color"));
    engine.block.setWidth(idBackground, 11);
    engine.block.setHeight(idBackground, 5);
    engine.block.setPositionX(idBackground, pageWidth - 11);
    engine.block.setPositionY(idBackground, pageHeight - 5);
    engine.block.setFillSolidColor(idBackground, 1, 1, 1, 1);
    engine.block.appendChild(pages[1], idBackground);

    // Add text to id text
    engine.block.setFloat(idText, "text/fontSize", 6);
    engine.block.setWidthMode(idText, "Auto");
    engine.block.setHeightMode(idText, "Auto");
    engine.block.setTextColor(idText, {
      r: 0,
      g: 0,
      b: 0,
      a: 1,
    });
    engine.block.setAlwaysOnTop(idBackground, true);
    engine.block.setAlwaysOnTop(idText, true);

    if (pages[1]) {
      if (profile) {
        engine.block.replaceText(idText, profile.id.slice(-5).toUpperCase());
      }
      engine.block.appendChild(idBackground, idText);
      engine.block.setWidth(idText, 11);
      engine.block.setHeight(idText, 5);
      engine.block.setEnum(idText, "text/verticalAlignment", "Center");
      engine.block.setEnum(idText, "text/horizontalAlignment", "Center");
    }
  }
}

export async function validateKlaviyoApiKeyForUser(user: User) {
  const integration = await prisma.integration.findFirst({
    where: {
      user_id: user.id,
      type: "klaviyo",
    },
  });

  if (integration && integration.klaviyo_api_key) {
    const response: any = await fetchKlaviyoSegments(
      integration.klaviyo_api_key,
    );
    if (response.errors) {
      return false;
    } else {
      return true;
    }
  } else {
    return false;
  }
}

export async function fetchKlaviyoSegments(apiKey: string) {
  const options = {
    method: "GET",
    headers: {
      accept: "application/json",
      revision: "2024-02-15",
      Authorization: `Klaviyo-API-Key ${apiKey}`,
    },
  };
  const response = await fetch("https://a.klaviyo.com/api/segments", options);
  const data = await response.json();
  return data;
}

export async function getKlaviyoSegmentProfiles(
  klaviyoSegmentId: string | null,
  userId: string,
) {
  const integration = await prisma.integration.findFirst({
    where: {
      user_id: userId,
      type: "klaviyo",
    },
  });

  if (!integration || !integration.klaviyo_api_key) {
    throw new Error("Klaviyo API key not found");
  }

  const url = `https://a.klaviyo.com/api/segments/${klaviyoSegmentId}/profiles/?page[size]=100`;
  const options = {
    method: "GET",
    headers: {
      Authorization: `Klaviyo-API-Key ${integration.klaviyo_api_key}`,
      revision: "2024-02-15",
    },
  };

  let allProfiles: KlaviyoSegmentProfile[] = [];
  let nextUrl: string | null = url;

  while (nextUrl) {
    const response = await fetch(nextUrl, options);
    const data: any = await response.json();

    if (data.data) {
      const validProfiles = data.data.filter((profile: any) => {
        const { id } = profile;
        const { first_name, last_name, email, location } = profile.attributes;
        const { address1, city, zip, country } = location || {};

        return (
          id &&
          first_name &&
          last_name &&
          address1 &&
          city &&
          zip &&
          country &&
          (country.toLowerCase() === "denmark" ||
            country.toLowerCase() === "danmark" ||
            country.toLowerCase() === "sweden" ||
            country.toLowerCase() === "sverige" ||
            country.toLowerCase() === "germany" ||
            country.toLowerCase() === "tyskland")
        );
      });

      allProfiles = [...allProfiles, ...validProfiles];
    }

    nextUrl = data.links ? data.links.next : null;

    // Respect the rate limit
    await new Promise((resolve) => setTimeout(resolve, 1000 / 75));
  }

  return allProfiles;
}

export function returnNewKlaviyoSegmentProfiles(
  klaviyoSegmentProfiles: KlaviyoSegmentProfile[],
  existingSegmentProfiles: Profile[],
) {
  const newSegmentProfiles = klaviyoSegmentProfiles.filter(
    (klaviyoSegmentProfile) =>
      !existingSegmentProfiles.some(
        (existingProfile) =>
          existingProfile.klaviyo_id === klaviyoSegmentProfile.id,
      ),
  );

  return newSegmentProfiles;
}

export async function returnProfilesInRobinson(profiles: ProfileToAdd[]) {
  const profilesMap = new Map();

  for (const profile of profiles) {
    const streetName = profile.address.split(" ")[0].toLowerCase();
    const firstNameParts = profile.first_name.toLowerCase().split(" ");
    const lastNameParts = profile.last_name.toLowerCase().split(" ");
    const zip = profile.zip_code;

    // Generate all combinations of first name and last name parts
    const firstNameCombinations = firstNameParts.reduce<string[]>(
      (combinations, _, i) => [
        ...combinations,
        ...firstNameParts
          .slice(i)
          .map((_, j) => firstNameParts.slice(i, i + j + 1).join(" ")),
      ],
      [],
    );
    const lastNameCombinations = lastNameParts.reduce<string[]>(
      (combinations, _, i) => [
        ...combinations,
        ...lastNameParts
          .slice(i)
          .map((_, j) => lastNameParts.slice(i, i + j + 1).join(" ")),
      ],
      [],
    );

    // Generate unique identifiers for all combinations of first name and last name combinations
    for (const firstName of firstNameCombinations) {
      for (const lastName of lastNameCombinations) {
        const uniqueIdentifier = `${firstName},${lastName},${streetName},${zip}`;
        profilesMap.set(uniqueIdentifier, profile);
      }
    }
  }

  const foundProfiles: ProfileToAdd[] = [];
  const response = await fetch(
    "https://rkjrflfwfqhhpwafimbe.supabase.co/storage/v1/object/public/robinson/robinson-modified.csv?t=2024-07-22T07%3A38%3A39.872Z",
  );

  if (!response || !response.body) {
    logtail.error("Failed to fetch Robinson data");
    throw new Error("Failed to fetch Robinson data");
  } else {
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");

    let result = "";
    let done = false;

    while (!done) {
      const { value, done: readerDone } = await reader.read();
      result += decoder.decode(value || new Uint8Array(), {
        stream: !readerDone,
      });
      done = readerDone;
    }

    const lines = result.split("\n");
    for (const line of lines) {
      const fields = line.split(",");
      if (fields.length < 4) {
        continue; // Skip lines with less than 4 fields
      }
      const [firstName, lastName, streetName, zip] = fields;
      const uniquePerson = `${firstName.trim().toLowerCase()},${lastName
        .trim()
        .toLowerCase()},${streetName.split(" ")[0].trim().toLowerCase()},${zip.trim()}`;
      const profileToAdd = profilesMap.get(uniquePerson);
      if (profileToAdd) {
        foundProfiles.push(profileToAdd);
      }
    }

    return foundProfiles;
  }
}

if (!config.license) {
  throw new Error("Missing IMGLY license key");
}

export function generateIdText(
  engine: CreativeEngine,
  profile: Profile,
  idText: number,
  pages: number[],
) {
  if (pages[1]) {
    engine.block.replaceText(idText, profile.id.slice(-5).toUpperCase());
    engine.block.setEnum(idText, "text/verticalAlignment", "Center");
    engine.block.setEnum(idText, "text/horizontalAlignment", "Center");
  }
}

export async function generatePdf(profiles: Profile[], designBlob: string, format: string) {
  try {
    const mergedPdf = await PDFDocument.create();
    await CreativeEngine.init(config).then(async (engine) => {
      const scene = await engine.scene.loadFromURL(designBlob);
      const pages = engine.scene.getPages();
      const pageWidth = engine.block.getWidth(pages[0]);
      const pageHeight = engine.block.getHeight(pages[0]);
      const idText = engine.block.create("text");
      generateIdBlock(idText, engine, pageWidth, pageHeight, pages);
      if (format === "a5-horizontal" || format === "a5-vertical") {
        generateBleedLines(engine, pages, pageWidth, pageHeight)
      }
      for (const profile of profiles) {
        updateVariables(engine, profile);
        generateIdText(engine, profile, idText, pages);
        const pdfBlob = await engine.block.export(scene, MimeType.Pdf);
        const pdfBuffer = Buffer.from(await pdfBlob.arrayBuffer());
        const pdf = await PDFDocument.load(pdfBuffer);
        const copiedPages = await mergedPdf.copyPages(
          pdf,
          pdf.getPageIndices(),
        );
        copiedPages.forEach((page) => mergedPdf.addPage(page));
      }
    });
    const pdfArray = await mergedPdf.save();
    const pdf = Buffer.from(pdfArray);
    return pdf;
  } catch (error: any) {
    throw new ErrorWithStatusCode(error.message, 500);
  }
}

export async function sendPdfToPrintPartner(
  pdf: Buffer,
  campaign_id: string,
  dateString: string,
) {
  try {
    const client = new Client();
    await client.connect({
      host: process.env.SFTP_HOST,
      port: parseInt(process.env.SFTP_PORT as string),
      username: process.env.SFTP_USER,
      password: process.env.SFTP_PASSWORD,
    });

    // Create folder if not exists
    await client.mkdir(`/files/til-distplus/${dateString}`, true);
    await client.put(
      pdf,
      `/files/til-distplus/${dateString}/kampagne-${campaign_id}.pdf`,
    );

    await client.end();
  } catch (error: any) {
    throw new ErrorWithStatusCode(error.message, 500);
  }
}

export async function generateCsvAndSendToPrintPartner(
  profiles: Profile[],
  campaign_id: string,
  dateString: string,
) {
  try {
    const client = new Client();
    await client.connect({
      host: process.env.SFTP_HOST,
      port: parseInt(process.env.SFTP_PORT as string),
      username: process.env.SFTP_USER,
      password: process.env.SFTP_PASSWORD,
    });

    // Create folder if not exists
    await client.mkdir(`/files/til-distplus/${dateString}`, true);

    let csvData = "id,company,navn,adresse,postnummer_og_by\n"; // CSV headers
    profiles.forEach((profile) => {
      const firstName = capitalizeWords(profile.first_name);
      const lastName = capitalizeWords(profile.last_name);
      const address = capitalizeWords(profile.address);
      const city = capitalizeWords(profile.city);
      const company = profile.company ? capitalizeWords(profile.company) : "";

      if (company === "") {
        csvData += `"${profile.id.slice(-5)}","","${firstName} ${lastName}","${address}","${profile.zip_code} ${city}"\n`;
      } else {
        csvData += `"${profile.id.slice(-5)}","${company}","Att. ${firstName} ${lastName}","${address}","${profile.zip_code} ${city}"\n`;
      }
    });
    // Convert the CSV data to a Buffer
    const csvBuffer = Buffer.from(csvData);

    // Upload the CSV data to the SFTP server
    await client.put(
      csvBuffer,
      `/files/til-distplus/${dateString}/kampagne-${campaign_id}.csv`,
    );

    await client.end();
  } catch (error: any) {
    throw new ErrorWithStatusCode(error.message, 500);
  }
}

export function capitalizeWords(str: string) {
  return str
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

export async function sendLettersForNonDemoUser(
  user: User,
  profiles: Profile[],
  design: Design,
  campaign_id: string,
) {
  // Try to bill the user for the letters sent
  try {
    await billUserForLettersSent(profiles.length, user.id);

    // Send resend mail
    await resend.emails.send({
      from: 'Postbuddy <noreply@postbuddy.dk>',
      to: ['jakob@postbuddy.dk', 'christian@postbuddy.dk'],
      subject: `Bruger er blevet opkrævet for breve sendt - ${user.email}`,
      html: `Bruger med id ${user.id} og email ${user.email} er blevet opkrævet for ${profiles.length} breve sendt, for kampagne med id ${campaign_id}`,
    });
  } catch (error: any) {
    await resend.emails.send({
      from: 'Postbuddy <noreply@postbuddy.dk>',
      to: ['jakob@postbuddy.dk'],
      subject: `Fejl ved opkrævning af bruger - ${user.email}`,
      html: `Der skete en fejl ved opkrævning af bruger med id ${user.id} og email ${user.email} for kampagne med id ${campaign_id}`,
    });
    throw new ErrorWithStatusCode(error.message, error.statusCode);
  }

  // Generate pdf
  let pdf;
  try {
    if (!design.scene) {
      throw new ErrorWithStatusCode("Design blob is missing", 400);
    }
    pdf = await generatePdf(profiles, design.scene, design.format);

    // Send resend mail
    await resend.emails.send({
      from: 'Postbuddy <noreply@postbuddy.dk>',
      to: ['jakob@postbuddy.dk', 'christian@postbuddy.dk'],
      subject: `PDF genereret for bruger - ${user.email}`,
      html: `Der er blevet genereret en pdf for bruger med id ${user.id} og email ${user.email} og kampagne med id ${campaign_id}`,
    });

    logtail.info(
      `Successfully generated a pdf for user ${user.id} and campaign ${campaign_id}`,
    );
  } catch (error: any) {
    logtail.error(
      `An error occured while trying to generate a pdf for user ${user.id} and campaign ${campaign_id}`,
    );
    await resend.emails.send({
      from: 'Postbuddy <noreply@postbuddy.dk>',
      to: ['jakob@postbuddy.dk'],
      subject: `Fejl ved generering af pdf for bruger - ${user.email}`,
      html: `Der skete en fejl ved generering af pdf for bruger med id ${user.id} og email ${user.email} for kampagne med id ${campaign_id}`,
    });
    throw new ErrorWithStatusCode(FailedToGeneratePdfError, 500);
  }

  // Send pdf to print partner with datestring e.g. 15-05-2024
  const date = new Date();
  const dateString = `${date.getDate()}-${date.getMonth() + 1}-${date.getFullYear()}`;

  try {
    logtail.info(
      `Sending a pdf to the print partner for user ${user.id} and campaign ${campaign_id}`,
    );
    await sendPdfToPrintPartner(pdf, user.id, dateString);
    await resend.emails.send({
      from: 'Postbuddy <noreply@postbuddy.dk>',
      to: ['jakob@postbuddy.dk', 'christian@postbuddy.dk'],
      subject: `PDF sendt til printpartner for bruger - ${user.email}`,
      html: `Der er blevet sendt en pdf med ${profiles.length} x 2 sider til printpartner for bruger med id ${user.id} og email ${user.email} og kampagne med id ${campaign_id}`,
    });
    logtail.info(
      `Successfully sent a pdf to the print partner for user ${user.id} and campaign ${campaign_id}`,
    );
  } catch (error: any) {
    logtail.error(
      `An error occured while trying to send a pdf to the print partner for user ${user.id} and campaign ${campaign_id}`,
    );
    await resend.emails.send({
      from: 'Postbuddy <noreply@postbuddy.dk>',
      to: ['jakob@postbuddy.dk'],
      subject: `Fejl ved afsendelse af pdf til printpartner for bruger - ${user.email}`,
      html: `Der skete en fejl ved afsendelse af pdf til printpartner for bruger med id ${user.id} og email ${user.email} for kampagne med id ${campaign_id}`,
    });
    throw new ErrorWithStatusCode(FailedToSendPdfToPrintPartnerError, 500);
  }

  try {
    logtail.info(
      `Generating a csv and sending it to the print partner for user ${user.id} and campaign ${campaign_id}`,
    );
    await generateCsvAndSendToPrintPartner(profiles, user.id, dateString);
    await resend.emails.send({
      from: 'Postbuddy <noreply@postbuddy.dk>',
      to: ['jakob@postbuddy.dk', 'christian@postbuddy.dk'],
      subject: `CSV sendt til printpartner for bruger - ${user.email}`,
      html: `Der er blevet sendt en csv med ${profiles.length} rækker til printpartner for bruger med id ${user.id} og email ${user.email} og kampagne med id ${campaign_id}`,
    });
    logtail.info(
      `Successfully generated a csv and sent it to the print partner for user ${user.id} and campaign ${campaign_id}`,
    );
  } catch (error: any) {
    logtail.error(
      `An error occured while trying to generate a csv and send it to the print partner for user ${user.id} and campaign ${campaign_id}`,
    );
    await resend.emails.send({
      from: 'Postbuddy <noreply@postbuddy.dk>',
      to: ['jakob@postbuddy.dk'],
      subject: `Fejl ved generering af csv og afsendelse til printpartner for bruger - ${user.email}`,
      html: `Der skete en fejl ved generering af csv og afsendelse til printpartner for bruger med id ${user.id} og email ${user.email} for kampagne med id ${campaign_id}`,
    });
    throw new ErrorWithStatusCode(FailedToSendPdfToPrintPartnerError, 500);
  }

  try {
    // Update profiles to sent
    await prisma.profile.updateMany({
      where: {
        id: {
          in: profiles.map((profile) => profile.id),
        },
      },
      data: {
        letter_sent: true,
        letter_sent_at: new Date(),
      },
    });
    logtail.info(
      `Successfully updated profiles to sent for user ${user.id} and campaign ${campaign_id}`,
    );
  } catch (error: any) {
    await resend.emails.send({
      from: 'Postbuddy <noreply@postbuddy.dk>',
      to: ['jakob@postbuddy.dk'],
      subject: `Fejl ved opdatering af profiles til sent for bruger - ${user.email}`,
      html: `Der skete en fejl ved opdatering af profiles til sent for bruger med id ${user.id} og email ${user.email} for kampagne med id ${campaign_id}`,
    });
    logtail.error(
      `An error occured while trying to update profiles to sent for user ${user.id} and campaign ${campaign_id}`,
    );
    throw new ErrorWithStatusCode(FailedToUpdateProfilesToSentError, 500);
  }
}

export async function sendLettersForDemoUser(
  profiles: Profile[],
  campaign_id: string,
  user: User
) {
  try {
    // Update profiles to sent
    await prisma.profile.updateMany({
      where: {
        id: {
          in: profiles.map((profile) => profile.id),
        },
      },
      data: {
        letter_sent: true,
        letter_sent_at: new Date(),
      },
    });

    await resend.emails.send({
      from: 'Postbuddy <noreply@postbuddy.dk>',
      to: ['jakob@postbuddy.dk'],
      subject: `Demo bruger har sendt breve - ${user.email}`,
      html: `Demo bruger med id ${user.id} har sendt ${profiles.length} breve for kampagne med id ${campaign_id}`,
    });
  } catch (error: any) {
    await resend.emails.send({
      from: 'Postbuddy <noreply@postbuddy.dk>',
      to: ['jakob@postbuddy.dk'],
      subject: `Fejl ved opdatering af profiles til sent for bruger - ${user.id}`,
      html: `Der skete en fejl ved opdatering af profiles til sent for bruger med id ${user.id} for kampagne med id ${campaign_id}`,
    });
    throw new ErrorWithStatusCode(FailedToUpdateProfilesToSentError, 500);
  }
}

export async function activateScheduledCampaigns() {
  const campaigns = await prisma.campaign.findMany({
    where: {
      status: "scheduled",
    },
    include: {
      design: true,
    },
  });

  const activatedCampaigns = [];
  for (const campaign of campaigns) {
    // Check if campaign start date is in the past
    const startDate = new Date(campaign.start_date);
    const currentDate = new Date();
    if (startDate > currentDate) {
      continue;
    }
    // if user does not have subscription and it's not a demo campaign, then pause the campaign
    const subscription = await prisma.subscription.findFirst({
      where: { user_id: campaign.user_id },
    });

    if (!subscription && !campaign.demo) {
      await prisma.campaign.update({
        where: { id: campaign.id },
        data: { status: "paused" },
      });
      continue;
    }

    await prisma.campaign.update({
      where: { id: campaign.id },
      data: { status: "active" },
    });

    activatedCampaigns.push(campaign);
  }

  if (activatedCampaigns.length > 0) {
    // Send resend mail
    await resend.emails.send({
      from: 'Postbuddy <noreply@postbuddy.dk>',
      to: ['jakob@postbuddy.dk'],
      subject: `Scheduled campaigns activated`,
      html: `The following campaigns have been activated: ${activatedCampaigns
        .map((campaign) => campaign.id)
        .join(", ")}`,
    });
  }

  logtail.info("Scheduled campaigns activated");
}

export async function updateKlaviyoProfiles() {
  logtail.info("Updating Klaviyo profiles");
  const users = await prisma.user.findMany({
    where: {
      integrations: {
        some: {
          type: "klaviyo",
        },
      },
    },
    include: {
      integrations: true,
    }
  });

  try {
    for (const user of users) {
      const isValid = await validateKlaviyoApiKeyForUser(user);
      const klaviyoIntegration = user.integrations.find(
        (integration) => integration.type === "klaviyo"
      );
      const klaviyoApiKey = klaviyoIntegration?.klaviyo_api_key;

      if (!klaviyoApiKey) {
        logtail.error(`User with id ${user.id} does not have a Klaviyo API key`);
        continue;
      }

      if (!isValid) {
        logtail.error(`User with id ${user.id} has an invalid Klaviyo API key`);
        continue;
      }

      const campaigns = await prisma.campaign.findMany({
        where: {
          user_id: user.id,
          status: "active",
          type: "automated",
          segment: {
            type: "klaviyo",
          },
        },
        include: {
          segment: true,
        },
      });

      // Loop through each campaign and get the new profiles from Klaviyo
      const profilesToAdd: ProfileToAdd[] = [];
      for (const campaign of campaigns) {
        const klaviyoSegmentProfiles = await getKlaviyoSegmentProfilesBySegmentId(
          campaign.segment.id,
          klaviyoApiKey,
          campaign.segment.klaviyo_custom_variable || undefined,
        );
        const existingSegmentProfiles = await prisma.profile.findMany({
          where: { segment_id: campaign.segment_id },
        });
        const newKlaviyoSegmentProfiles = returnNewKlaviyoSegmentProfiles(
          klaviyoSegmentProfiles,
          existingSegmentProfiles,
        );
        const convertedKlaviyoSegmentProfiles = newKlaviyoSegmentProfiles.map(
          (klaviyoSegmentProfile) => ({
            id: klaviyoSegmentProfile.id,
            first_name:
              klaviyoSegmentProfile.attributes.first_name.toLowerCase(),
            last_name: klaviyoSegmentProfile.attributes.last_name.toLowerCase(),
            email: klaviyoSegmentProfile.attributes.email.toLowerCase(),
            address:
              klaviyoSegmentProfile.attributes.location.address1.toLowerCase(),
            city: klaviyoSegmentProfile.attributes.location.city.toLowerCase(),
            zip_code: klaviyoSegmentProfile.attributes.location.zip,
            country:
              klaviyoSegmentProfile.attributes.location.country.toLowerCase(),
            segment_id: campaign.segment_id,
            in_robinson: false,
            custom_variable: campaign.segment.klaviyo_custom_variable ? klaviyoSegmentProfile.attributes.properties[campaign.segment.klaviyo_custom_variable] : null,
            demo: campaign.segment.demo,
          }),
        );
        let profilesToAddTemp = convertedKlaviyoSegmentProfiles;
        profilesToAdd.push(...profilesToAddTemp);
      }

      // Remove the profiles where the email of the profile is already in the segment
      for (const profile of profilesToAdd) {
        const existingProfile = await prisma.profile.findFirst({
          where: {
            OR: [
              { email: profile.email, segment_id: profile.segment_id },
              {
                zip_code: profile.zip_code,
                address: profile.address,
                first_name: profile.first_name,
                last_name: profile.last_name,
                segment_id: profile.segment_id,
              },
            ],
          },
        });

        if (existingProfile) {
          profilesToAdd.splice(profilesToAdd.indexOf(profile), 1);
        }
      }

      // Check if profiles are in Robinson
      const profilesToAddInRobinson =
        await returnProfilesInRobinson(profilesToAdd);
      profilesToAdd.map((profile) => {
        if (profilesToAddInRobinson.includes(profile)) {
          profile.in_robinson = true;
        }
      });

      // Add profiles to the database
      await prisma.profile.createMany({
        data: profilesToAdd,
      });

      logtail.info("Klaviyo profiles updated");
    }
  } catch (error: any) {
    logtail.error("Error updating Klaviyo profiles" + error);
    throw new Error(error.message);
  }
}

export async function periodicallySendLetters() {
  logtail.info("Periodically sending letters");
  try {
    const users = await prisma.user.findMany();

    for (const user of users) {
      const campaigns = await prisma.campaign.findMany({
        where: {
          status: "active",
          user_id: user.id,
        },
        include: {
          design: true,
          segment: true,
        },
      });

      for (const campaign of campaigns) {
        const unsentProfiles = await getUnsentProfiles(user, campaign);

        // If the campaign does not have a segment or design, then set it to paused
        if (
          !campaign.segment ||
          !campaign.design ||
          !campaign.design.scene
        ) {
          await prisma.campaign.update({
            where: { id: campaign.id },
            data: { status: "paused" },
          });
          continue;
        }

        // If there are no unsent profiles, then continue to the next campaign
        if (
          unsentProfiles.length === 0
        ) {
          continue;
        }

        // if there is a profile with id "additional-revenue-{campaign.id}", then remove it
        const updatedProfiles = unsentProfiles.filter(
          (profile) => profile.id !== `additional-revenue-${campaign.id}`,
        );

        // Make sure all profiles are unique
        const uniqueProfiles = updatedProfiles.filter(
          (profile, index, self) =>
            index ===
            self.findIndex(
              (t) =>
                t.first_name === profile.first_name &&
                t.last_name === profile.last_name &&
                t.email === profile.email &&
                t.zip_code === profile.zip_code
            ),
        );

        try {
          if (!campaign.demo && !campaign.segment.demo) {
            await sendLettersForNonDemoUser(
              user,
              uniqueProfiles,
              campaign.design,
              campaign.id,
            );
          } else {
            await sendLettersForDemoUser(
              uniqueProfiles,
              campaign.id,
              user
            );
          }
        } catch (error: any) {
          logtail.error(
            `An error occured while trying to periodically activate a campaign with id ${campaign.id}`,
          );
          continue;
        }
      }
    }
  } catch (error: any) {
    logtail.error("Error periodically sending letters" + error);
    throw new Error(error.message);
  }
}

export function validateHMAC(query: string, hmac: string) {
  const sharedSecret = process.env.SHOPIFY_CLIENT_SECRET;

  if (!sharedSecret) {
    throw new Error("SHOPIFY_CLIENT_SECRET not set");
  }

  const generatedHmac = createHmac("sha256", sharedSecret)
    .update(query)
    .digest("hex");
  return generatedHmac === hmac;
}

export function extractQueryWithoutHMAC(url: URL) {
  const searchParams = new URLSearchParams(url.search);
  searchParams.delete("hmac");
  return searchParams.toString();
}

export function generateUniqueFiveDigitId() {
  return Math.floor(10000 + Math.random() * 90000);
}

export async function getKlaviyoSegmentProfilesBySegmentId(
  segmentId: string,
  klaviyoApiKey: string,
  custom_variable?: string,
) {
  const url = `https://a.klaviyo.com/api/segments/${segmentId}/profiles/?page[size]=100`;
  const options = {
    method: "GET",
    headers: {
      Authorization: `Klaviyo-API-Key ${klaviyoApiKey}`,
      revision: "2024-02-15",
    },
  };

  let allProfiles: KlaviyoSegmentProfile[] = [];
  let nextUrl: string | null = url;

  while (nextUrl) {
    const response = await fetch(nextUrl, options);
    const data: any = await response.json();

    if (data.data) {
      data.data.forEach((profile: any) => {
        const { first_name, last_name, email, location, properties } = profile.attributes;
        const { address1, city, zip, country } = location || {};

        // Only extract the custom variable if it's provided
        const customValue = custom_variable ? properties[custom_variable] : undefined;

        if (
          first_name &&
          last_name &&
          email &&
          address1 &&
          city &&
          zip &&
          (
            !custom_variable ||
            (customValue !== undefined && customValue !== null && customValue !== "")
          )
        ) {
          allProfiles.push({
            id: profile.id,
            attributes: {
              first_name,
              last_name,
              email,
              location: {
                address1,
                city,
                zip,
                country,
              },
              properties: {
                ...properties,
                ...(custom_variable && { [custom_variable]: customValue }),
              },
            },
          });
        }
      });
    }

    // Check if there's a next page of profiles
    nextUrl = data.links && data.links.next ? data.links.next : null;
  }

  return allProfiles;
}



export function detectDelimiter(line: string): string {
  const delimiters = [",", ";", "\t"];
  for (const delimiter of delimiters) {
    if (line.includes(delimiter)) {
      return delimiter;
    }
  }
  return "";
}

export function splitCSVLine(line: string, delimiter: string): string[] {
  const result = [];
  let startValueIndex = 0;
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') {
      inQuotes = !inQuotes;
    } else if (line[i] === delimiter && !inQuotes) {
      result.push(line.substring(startValueIndex, i).trim());
      startValueIndex = i + 1;
    }
  }

  result.push(line.substring(startValueIndex).trim());

  return result.map((value) =>
    value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value,
  );
}

export function validateCountry(country: string): boolean {
  return (
    country.toLowerCase() === "denmark" ||
    country.toLowerCase() === "danmark" ||
    country.toLowerCase() === "sweden" ||
    country.toLowerCase() === "sverige" ||
    country.toLowerCase() === "germany" ||
    country.toLowerCase() === "tyskland"
  );
}

export async function checkIfProfileIsInRobinson(profile: ProfileToAdd) {
  const streetName = profile.address.match(/\D+/g)?.[0].trim().toLowerCase();
  const firstName = profile.first_name.toLowerCase();
  const lastName = profile.last_name.toLowerCase();
  const zip = profile.zip_code;
  const uniqueIdentifier = `${firstName},${lastName},${streetName},${zip}`;

  const response = await fetch(
    "https://ypvaugzxzbcnyeun.public.blob.vercel-storage.com/robinson-cleaned-modified-jAzirx8qMWVzJ1DPEEIqct82TSyuVU.csv",
  );

  if (!response || !response.body) {
    logtail.error("Failed to fetch Robinson data");
    throw new Error("Failed to fetch Robinson data");
  } else {
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");

    let result = "";
    let done = false;

    while (!done) {
      const { value, done: readerDone } = await reader.read();
      result += decoder.decode(value || new Uint8Array(), {
        stream: !readerDone,
      });
      done = readerDone;
    }

    const lines = result.split("\n");
    for (const line of lines) {
      const fields = line.split(",");
      if (fields.length < 4) {
        continue; // Skip lines with less than 4 fields
      }
      const [firstName, lastName, streetName, zip] = fields;
      const uniquePerson = `${firstName.trim().toLowerCase()},${lastName
        .trim()
        .toLowerCase()},${streetName.trim().toLowerCase()},${zip.trim()}`;
      if (uniquePerson === uniqueIdentifier) {
        return true;
      }
    }

    return false;
  }
}

async function getUnsentProfiles(user: User, campaign: Campaign): Promise<Profile[]> {
  const bufferDaysAsNumber = Number(user.buffer_days || 10);
  const daysAgo = subDays(new Date(), bufferDaysAsNumber); // Subtract buffer days from today
  const BATCH_SIZE = 10000;
  let sentProfiles: Profile[] = [];
  let skip = 0;
  let hasMore = true;

  // Step 1: Fetch all profiles that have received letters within buffer days
  while (hasMore) {
    const fetchedProfiles = await prisma.profile.findMany({
      where: {
        letter_sent: true,
        letter_sent_at: {
          gte: daysAgo,
        },
        segment_id: campaign.segment_id,
      },
      take: BATCH_SIZE,
      skip: skip,
    });

    sentProfiles = sentProfiles.concat(fetchedProfiles);

    if (fetchedProfiles.length < BATCH_SIZE) {
      hasMore = false;
    }
    skip += BATCH_SIZE;
  }

  // Step 2: Extract the identifying fields from these profiles
  const sentProfileIdentifiers = sentProfiles.map(profile => ({
    first_name: profile.first_name,
    last_name: profile.last_name,
    zip_code: profile.zip_code,
    email: profile.email,
    // Add other identifying fields as necessary
  }));

  // Step 3: Fetch all profiles that do not have these identifying fields
  let unsentProfiles: Profile[] = [];
  skip = 0;
  hasMore = true;

  while (hasMore) {
    const fetchedProfiles = await prisma.profile.findMany({
      where: {
        letter_sent: false,
        in_robinson: false,
        segment_id: campaign.segment_id,
      },
      take: BATCH_SIZE,
      skip: skip,
    });

    const filteredProfiles = fetchedProfiles.filter(profile => {
      return !sentProfileIdentifiers.some(identifier =>
        identifier.first_name === profile.first_name &&
        identifier.last_name === profile.last_name &&
        identifier.zip_code === profile.zip_code &&
        identifier.email === profile.email,
        // Add other identifying fields as necessary
      );
    });

    unsentProfiles = unsentProfiles.concat(filteredProfiles);

    if (fetchedProfiles.length < BATCH_SIZE) {
      hasMore = false;
    }
    skip += BATCH_SIZE;
  }

  return unsentProfiles;
}