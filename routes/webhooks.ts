import { Router } from "express";
import { logtail, prisma } from "../app";
import {
  CountryNotSupportedError,
  InternalServerError,
  MissingRequiredParametersError,
  MissingShopifyIntegrationError,
  MissingSubscriptionError,
  SegmentNotFoundError,
  UserNotFoundError,
} from "../errors";
import { checkIfProfileIsInRobinson, validateCountry } from "../functions";
import { ProfileToAdd } from "../types";
import Stripe from "stripe";
import { createHmac } from "node:crypto";
import { Resend } from "resend";
import { LoopsClient } from "loops";

const router = Router();

router.post("/segment", async (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: "Unauthorized" });

  const user = await prisma.user.findUnique({
    where: { access_token: auth },
  });
  if (!user) return res.status(401).json({ error: "Unauthorized" });

  const {
    segment_id,
    first_name,
    last_name,
    email,
    address,
    zip,
    city,
    country,
    custom_variable,
  } = req.body;
  if (
    !segment_id ||
    !first_name ||
    !last_name ||
    !email ||
    !address ||
    !zip ||
    !city ||
    !country
  )
    return res.status(400).json({ error: MissingRequiredParametersError });

  const segment = await prisma.segment.findUnique({
    where: { id: segment_id },
  });
  if (!segment) return res.status(404).json({ error: SegmentNotFoundError });

  // Return error if country is not supported
  const validCountry = validateCountry(country);
  if (!validCountry)
    return res.status(400).json({ error: CountryNotSupportedError });

  const profile: ProfileToAdd = {
    first_name,
    last_name,
    email,
    address,
    city,
    zip_code: zip,
    in_robinson: false,
    segment_id: segment_id,
  };

  const isInRobinson = await checkIfProfileIsInRobinson(profile);
  if (isInRobinson) {
    profile.in_robinson = true;
  }

  await prisma.profile.create({
    data: {
      first_name: profile.first_name,
      last_name: profile.last_name,
      email: profile.email,
      address: profile.address,
      city: profile.city,
      zip_code: profile.zip_code,
      in_robinson: profile.in_robinson,
      segment_id: profile.segment_id,
      custom_variable: custom_variable || null,
      demo: segment.demo,
    },
  });

  return res.status(201).json({ success: "Profile added successfully" });
});

router.post("/stripe", async (req, res) => {
  const payload = req.body;
  switch (payload.type) {
    case "checkout.session.completed": {
      if (payload.data.object.payment_status === "paid") {
        try {
          const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

          if (STRIPE_SECRET_KEY == null) {
            return res.status(500).json({ error: InternalServerError });
          }

          const stripe = new Stripe(STRIPE_SECRET_KEY);

          const subscriptionItems = await stripe.subscriptionItems.list({
            limit: 3,
            subscription: payload.data.object.subscription,
          });

          const user = await prisma.user.findUnique({
            where: {
              id: payload.data.object.client_reference_id,
            },
          });
          if (!user) return res.status(404).json({ error: UserNotFoundError });

          await prisma.subscription.create({
            data: {
              subscription_id: payload.data.object.subscription,
              customer_id: payload.data.object.customer,
              user_id: user.id,
              subscription_item_id: subscriptionItems.data[0].id,
              status: "active",
            },
          });

          const resend = new Resend(process.env.RESEND_API_KEY);
          (async function () {
            const { error } = await resend.emails.send({
              from: "Postbuddy <noreply@postbuddy.dk>",
              to: ["jakob@postbuddy.dk", "christian@postbuddy.dk"],
              subject: `Ny bruger har købt et abonnement`,
              html: `En ny bruger med følgende oplysninger har købt et abonnement:
              <br>
              <br>
              <strong>Navn:</strong> ${user.first_name} ${user.last_name}
              <br>
              <strong>Virksomhed:</strong> ${user.company}
              <br>
              <strong>Email:</strong> ${user.email}
              <br>
              <strong>Abonnement:</strong> ${subscriptionItems.data[0].price.product}
              <br>
              <strong>Pris:</strong> ${subscriptionItems.data[0].price.unit_amount} kr.`,
            });

            if (error) {
              return console.error({ error });
            }
          })();
        } catch (error: any) {
          logtail.error(error + "POST /webhooks/stripe");
          return res.status(500).json({ error: InternalServerError });
        }
      }
      break;
    }
    case "customer.subscription.deleted": {
      try {
        const subscription = await prisma.subscription.update({
          where: {
            subscription_id: payload.data.object.id,
          },
          data: {
            status: "canceled",
          },
        });
        if (subscription == null) {
          return res.status(404).json({ error: MissingSubscriptionError });
        }

        // stop all campaigns
        const user = await prisma.user.findUnique({
          where: {
            id: subscription.user_id,
          },
        });
        if (!user) return res.status(404).json({ error: UserNotFoundError });

        await prisma.campaign.updateMany({
          where: {
            user_id: user.id,
            demo: false,
          },
          data: {
            status: "paused",
          },
        });
        break;
      } catch (error: any) {
        logtail.error(error + "POST /webhooks/stripe");
        return res.status(500).json({ error: InternalServerError });
      }
    }
  }
  return res.status(200).json({ success: "Webhook received" });
});

router.post("/shopify/customer-deletion", async (req, res) => {
  const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET as string;
  const hmacHeader = req.headers["X-Shopify-Hmac-SHA256"];
  const body = await req.body.text();

  const calculatedHmac = createHmac("sha256", CLIENT_SECRET)
    .update(body)
    .digest("base64");

  if (calculatedHmac !== hmacHeader) {
    return res.status(400).json({ error: "Invalid HMAC" });
  }

  return res.status(200).json({ success: "Webhook received" });
});

router.post("/shopify/customer-request", async (req, res) => {
  const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET as string;
  const hmacHeader = req.headers["X-Shopify-Hmac-SHA256"];
  const body = await req.body.text();

  const calculatedHmac = createHmac("sha256", CLIENT_SECRET)
    .update(body)
    .digest("base64");

  if (calculatedHmac !== hmacHeader) {
    return res.status(400).json({ error: "Invalid HMAC" });
  }

  return res.status(200).json({ success: "Webhook received" });
});

router.post("/shopify/deletion", async (req, res) => {
  const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET as string;
  const hmacHeader = req.headers["X-Shopify-Hmac-SHA256"];
  const body = await req.body.text();

  const calculatedHmac = createHmac("sha256", CLIENT_SECRET)
    .update(body)
    .digest("base64");

  if (calculatedHmac !== hmacHeader) {
    return res.status(400).json({ error: "Invalid HMAC" });
  }

  return res.status(200).json({ success: "Webhook received" });
});

router.post("/shopify/uninstall", async (req, res) => {
  const state = req.query.state;
  if (!state)
    return res.status(400).json({ error: "Missing required parameters" });

  const shopifyIntegration = await prisma.integration.findFirst({
    where: { user_id: state as string },
  });
  if (!shopifyIntegration)
    return res.status(404).json({ error: MissingShopifyIntegrationError });

  await prisma.integration.delete({
    where: { id: shopifyIntegration.id },
  });

  return res.status(200).json({ success: "Webhook received" });
});

router.post("/email-upon-signup", async (req, res) => {
  const { record } = await req.body;
  const { first_name, last_name, email, marketing } = record;

  logtail.info("Received webhook from Supabase upon signup", record);

  const resend = new Resend(process.env.RESEND_API_KEY);

  const { error } = await resend.emails.send({
    from: "Postbuddy <noreply@postbuddy.dk",
    to: ["jakob@postbuddy.dk", "christian@postbuddy.dk"],
    subject: "Ny bruger har oprettet sig på app.postbuddy.dk",
    html: `En ny bruger med følgende oplysninger har oprettet sig på app.postbuddy.dk:
    <br>
    <br>
    <strong>Navn:</strong> ${first_name} ${last_name}
    <br>
    <strong>Email:</strong> ${email}
    <br>
    <strong>Marketing:</strong> ${marketing}`,
  });

  if (error) {
    logtail.error("An error occured while sending email upon signup", error);
    return console.error({ error });
  }

  if (marketing) {
    const loops = new LoopsClient("af768fbee93981bf78f9c5b6306eb013");
    const response = await loops.createContact(email, {
      firstName: first_name,
      lastName: last_name,
    });

    if (response.success === false) {
      logtail.error("Error creating contact in Loops:", response);
      console.error("Error creating contact in Loops:", response.message);
    }
  }

  return res.status(200).json({ success: "Webhook received" });
})

export default router;
