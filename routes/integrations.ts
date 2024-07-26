import { Router } from 'express';
import { logError, logWarn, prisma } from '../app';
import { IntegrationNotFoundError, InternalServerError, MissingRequiredParametersError, UserNotFoundError } from '../errors';
import { extractQueryWithoutHMAC, validateHMAC } from '../functions';
import { authenticateToken } from './middleware';
import { API_URL, supabase, WEB_URL } from '../constants';
import { Resend } from 'resend';

const router = Router();

router.get('/klaviyo', authenticateToken, async (req, res) => {
  const { data, error } = await supabase
    .from('integrations')
    .select('*')
    .eq('user_id', req.body.user_id)
    .eq('type', 'klaviyo')

  if (error) {
    console.error(error);
    return res.status(500).json({ error: InternalServerError });
  }

  if (data.length === 0) {
    return res.status(204)
  } else {
    return res.json(data[0]);
  }
})

router.get('/', authenticateToken, async (req, res) => {
  const user_id = req.body.user_id;
  const integrationType = req.body.integrationType;
  if (!user_id) return res.status(400).json({ error: MissingRequiredParametersError });

  const user = await prisma.user.findUnique({
    where: { id: user_id },
  });
  if (!user) return res.status(404).json({ error: UserNotFoundError });

  if (integrationType) {
    const integration = await prisma.integration.findFirst({
      where: { type: integrationType },
    });

    return res.json(integration);
  }

  const integrations = await prisma.integration.findMany({
    where: { user_id: user.id },
  });

  res.json(integrations);
})

router.get('/shopify/connect', authenticateToken, async (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: MissingRequiredParametersError });

  const user = await prisma.user.findUnique({
    where: { id: user_id },
  });
  if (!user) {
    logWarn(UserNotFoundError, "GET /shopify/connect", { user_id });
    return res.status(404).json({ error: UserNotFoundError });
  }

  // Check if user already has a Shopify integration
  const integration = await prisma.integration.findFirst({
    where: {
      user_id: user.id,
      type: "shopify",
    },
  });

  if (integration) {
    logWarn("Du har allerede integreret med Shopify", "GET /shopify/connect", { user_id });
    return res.status(400).json({ error: "Du har allerede integreret med Shopify" });
  }

  const redirectUrl =
    "https://shopify.com/admin/oauth/authorize?" +
    new URLSearchParams({
      client_id: "54ab0548747300abd0847fd2fc81587c",
      redirect_uri: `${API_URL}/integrations/shopify/callback`,
      state: user.id,
      scopes: "customer_read_markets,customer_read_orders,read_all_orders,read_customers,read_orders",
    }).toString();

  return res.status(200).json({ redirectUrl });
})

router.get('/shopify/disconnect', authenticateToken, async (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: MissingRequiredParametersError });

  const user = await prisma.user.findUnique({
    where: { id: user_id },
  });
  if (!user) {
    logWarn(UserNotFoundError, "GET /shopify/disconnect", { user_id });
    return res.status(404).json({ error: UserNotFoundError });
  }

  const integration = await prisma.integration.findFirst({
    where: {
      user_id: user.id,
      type: "shopify",
    },
  });

  if (!integration || !integration.token) {
    logWarn(IntegrationNotFoundError, "GET /shopify/disconnect", { user_id });
    return res.status(404).json({ error: IntegrationNotFoundError });
  }

  try {
    const revokeUrl = `https://${integration?.shop}.myshopify.com/admin/api_permissions/current.json`;
    const options = {
      method: "DELETE",
      headers: {
        "X-Shopify-Access-Token": integration.token,
      },
    };

    await fetch(revokeUrl, options);

    await prisma.integration.deleteMany({
      where: {
        user_id: user.id,
        type: "shopify",
      },
    });

    return res.status(200).json({ success: "Shopify-integrationen blev slettet" });
  } catch (error) {
    logError(error, { user_id: req.body.user_id });
    return res.status(500).json({ error: InternalServerError });
  }
})

router.get('/shopify/callback', async (req, res) => {
  const fullUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  const url = new URL(fullUrl);
  const { code, state, hmac, host } = req.query;
  let shop = req.query.shop as string;

  if (!code || !state || !hmac || !host || !shop) {
    return res.status(400).json({ error: MissingRequiredParametersError });
  }

  const queryWithoutHmac = extractQueryWithoutHMAC(url);
  const user = await prisma.user.findUnique({ where: { id: state as string } });
  if (!user) {
    logWarn(UserNotFoundError, "GET /shopify/callback", { user_id: state });
    return res.status(404).json({ error: UserNotFoundError });
  }

  const sameHMAC = validateHMAC(queryWithoutHmac, hmac as string);
  if (!sameHMAC) {
    logWarn("HMAC validation failed", "GET /shopify/callback", { user_id: state });
    return res.status(400).json({ error: "HMAC validation failed" });
  }

  // Validate shop
  const shopRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;
  if (!shopRegex.test(shop)) {
    logWarn("Invalid shop parameter", "GET /shopify/callback", { user_id: state });
    return res.status(400).json({ error: 'Invalid shop parameter' });
  }

  if (shop != null) {
    shop = shop.replace('.myshopify.com', '');
  }

  try {
    // Exchange code for access token
    const response = await fetch(`https://${shop}.myshopify.com/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: '54ab0548747300abd0847fd2fc81587c',
        client_secret: process.env.SHOPIFY_CLIENT_SECRET,
        code,
      }),
    });

    if (!response.ok) {
      logWarn("Failed to exchange code for access token", "GET /shopify/callback", { user_id: state });
      return res.status(400).json({ error: 'Failed to exchange code for access token' });
    }

    const data: any = await response.json();

    await prisma.integration.create({
      data: {
        type: 'shopify',
        token: data.access_token,
        token_created_at: new Date(),
        scopes: data.scope,
        shop: shop,
        user_id: user.id,
      },
    });

    // Fetch existing webhooks
    const webhooksResponse = await fetch(`https://${shop}.myshopify.com/admin/api/2024-01/webhooks.json`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': data.access_token,
      },
    });

    if (!webhooksResponse.ok) {
      logWarn("Failed to fetch webhooks", "GET /shopify/callback", { user_id: state });
      return res.status(400).json({ error: 'Failed to fetch webhooks' });
    }

    const webhooksData: any = await webhooksResponse.json();

    // Delete existing bulk_operations/finish webhooks
    for (const webhook of webhooksData.webhooks) {
      if (webhook.topic === 'bulk_operations/finish') {
        const deleteResponse = await fetch(`https://${shop}.myshopify.com/admin/api/2024-01/webhooks/${webhook.id}.json`, {
          method: 'DELETE',
          headers: {
            'Content-Type': 'application/json',
            'X-Shopify-Access-Token': data.access_token,
          },
        });

        if (!deleteResponse.ok) {
          logWarn("Failed to delete existing bulk operations webhook", "GET /shopify/callback", { user_id: state });
          return res.status(400).json({ error: 'Failed to delete existing bulk operations webhook' });
        }
      }
    }

    // Create new bulk_operations/finish webhook
    const webhookResponse = await fetch(`https://${shop}.myshopify.com/admin/api/2021-10/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': data.access_token,
      },
      body: JSON.stringify({
        query: `
        mutation {
          webhookSubscriptionCreate(
            topic: BULK_OPERATIONS_FINISH,
            webhookSubscription: {
              format: JSON,
              callbackUrl: "https://api.postbuddy.dk/shopify/bulk-query-finished?shop=${shop}&state=${user.id}",
            }
          ) {
            userErrors { field, message }
            webhookSubscription { id }
          }
        }
      `,
      }),
    });

    if (!webhookResponse.ok) {
      logWarn("Failed to subscribe to the bulk_operations/finish webhook", "GET /shopify/callback", { user_id: state });
      return res.status(400).json({ error: 'Failed to subscribe to the bulk_operations/finish webhook' });
    }

    const webhookData: any = await webhookResponse.json();
    if (webhookData.data.webhookSubscriptionCreate.userErrors.length > 0) {
      logWarn("Failed to create the bulk_operations/finish webhook", "GET /shopify/callback", { user_id: state });
      return res.status(400).json({ error: 'Failed to create the bulk_operations/finish webhook' });
    }

    // Create APP_UNINSTALLED webhook
    const webhookUninstallApp = await fetch(`https://${shop}.myshopify.com/admin/api/2021-10/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': data.access_token,
      },
      body: JSON.stringify({
        query: `
    mutation {
      webhookSubscriptionCreate(
        topic: APP_UNINSTALLED,
        webhookSubscription: {
          format: JSON,
          callbackUrl: "${API_URL}/webhooks/shopify/uninstall?shop=${shop}&state=${user.id}",
        }
      ) {
        userErrors { field, message }
        webhookSubscription { id }
      }
    }
  `,
      }),
    });

    if (!webhookUninstallApp.ok) {
      logWarn("Failed to subscribe to the app/uninstall webhook", "GET /shopify/callback", { user_id: state });
      return res.status(400).json({ error: 'Failed to subscribe to the app/uninstall webhook' });
    }

    // Trigger the bulk query for orders
    const ordersWebhookResponse = await fetch(API_URL + '/shopify/bulk-query-trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: user.id }),
    });

    if (!ordersWebhookResponse.ok) {
      const data: any = await ordersWebhookResponse.json();
      logWarn("Failed to trigger the bulk query for orders", "GET /shopify/callback", { user_id: state });
      return res.status(400).json({ error: data.error });
    }

    const resend = new Resend(process.env.RESEND_API_KEY);
    (async function () {
      const { error } = await resend.emails.send({
        from: 'Postbuddy <noreply@postbuddy.dk>',
        to: ['jakob@postbuddy.dk', 'christian@postbuddy.dk'],
        subject: `Ny bruger har integreret med Shopify`,
        html: `En ny bruger med følgende oplysninger har integreret med Shopify:
      <br>
      <br>
      <strong>Navn:</strong> ${user.first_name} ${user.last_name}
      <br>
      <strong>Virksomhed:</strong> ${user.company}
      <br>
      <strong>Email:</strong> ${user.email}
      <br>
      <strong>Shop:</strong> ${shop}`,
      });

      if (error) {
        logWarn("Failed to send new user shopify integration email", "GET /shopify/callback", { user_id: state });
        return console.error({ error });
      }
    })();
  } catch (error) {
    logError(error, { user_id: state });
    return res.status(500).json({ error: InternalServerError });
  }

  return res.redirect(WEB_URL + '/integrations');
})

router.post('/klaviyo/connect', authenticateToken, async (req, res) => {
  const { user_id, api_key } = req.body;
  if (!user_id || !api_key) return res.status(400).json({ error: MissingRequiredParametersError });

  const klaviyoResponse = await fetch("https://a.klaviyo.com/api/segments/", {
    method: "GET",
    headers: {
      accept: "application/json",
      revision: "2024-02-15",
      Authorization: `Klaviyo-API-Key ${api_key}`,
    },
  });

  const klaviyoData: any = await klaviyoResponse.json();
  if (!klaviyoData.data) {
    logWarn("Ugyldig API key. Er du sikker på, den har read-access til segmenter?", "POST /klaviyo/connect", { user_id });
    return res.status(400).json({ error: "Ugyldig API key. Er du sikker på, den har read-access til segmenter?" });
  }

  const klaviyoResponseTwo = await fetch("https://a.klaviyo.com/api/profiles/", {
    method: "GET",
    headers: {
      accept: "application/json",
      revision: "2024-02-15",
      Authorization: `Klaviyo-API-Key ${api_key}`,
    },
  });

  const klaviyoDataTwo: any = await klaviyoResponseTwo.json();
  if (!klaviyoDataTwo.data) {
    logWarn("Ugyldig API key. Er du sikker på, den har read-access til profiler?", "POST /klaviyo/connect", { user_id });
    return res.status(400).json({ error: "Ugyldig API key. Er du sikker på, den har read-access til profiler?" });
  }

  // Check that user doesn't already have a Klaviyo integration
  const existingIntegration = await prisma.integration.findFirst({
    where: {
      user_id: user_id,
      type: "klaviyo",
    },
  });

  if (existingIntegration) {
    logWarn("Du har allerede integreret med Klaviyo", "POST /klaviyo/connect", { user_id });
    return res.status(400).json({ error: "Du har allerede integreret med Klaviyo" });
  }

  const klaviyoIntegration = await prisma.integration.create({
    data: {
      type: "klaviyo",
      klaviyo_api_key: api_key,
      user_id,
    },
  });

  return res.status(200).json(klaviyoIntegration);
})

router.get('/klaviyo/disconnect', authenticateToken, async (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: MissingRequiredParametersError });

  const user = await prisma.user.findUnique({
    where: { id: user_id },
  });
  if (!user) return res.status(404).json({ error: UserNotFoundError });

  await prisma.integration.deleteMany({
    where: {
      user_id: user.id,
      type: "klaviyo",
    },
  });

  return res.status(200).json({ success: "Klaviyo-integrationen blev slettet" });
})

export default router;