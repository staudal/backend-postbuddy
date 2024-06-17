import { Router } from 'express';
import { prisma } from '../app';
import { InternalServerError, MissingRequiredParametersError, UserNotFoundError } from '../errors';
import { extractQueryWithoutHMAC, validateHMAC } from '../functions';
import authenticateToken from './middleware';

const router = Router();

router.get('/', authenticateToken, async (req, res) => {
  const user_id = req.body.user_id;
  const integrationType = req.body.integrationType;
  if (!user_id) return res.status(400).json({ error: MissingRequiredParametersError });

  const user = await prisma.user.findUnique({
    where: { id: user_id },
  });
  if (!user) return res.status(404).json({ error: UserNotFoundError });

  if (integrationType) {
    try {
      const integration = await prisma.integration.findFirst({
        where: { type: integrationType },
      });

      return res.json(integration);
    } catch (error: any) {
      console.error(error);
      return res.status(500).json({ error: InternalServerError });
    }
  }

  try {
    const integrations = await prisma.integration.findMany({
      where: { user_id: user.id },
    });

    res.json(integrations);
  } catch (error: any) {
    console.error(error);
    return res.status(500).json({ error: InternalServerError });
  }
})

router.get('/shopify/connect', authenticateToken, async (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: MissingRequiredParametersError });

  const user = await prisma.user.findUnique({
    where: { id: user_id },
  });
  if (!user) return res.status(404).json({ error: UserNotFoundError });

  try {
    const redirectUrl =
      "https://shopify.com/admin/oauth/authorize?" +
      new URLSearchParams({
        client_id: "54ab0548747300abd0847fd2fc81587c",
        redirect_uri: "http://localhost:8000/integrations/shopify/callback",
        state: user.id,
        scopes: "customer_read_markets,customer_read_orders,read_all_orders,read_customers,read_orders",
      }).toString();

    return res.status(200).json({ redirectUrl });
  } catch (error: any) {
    console.error(error);
    return res.status(500).json({ error: InternalServerError });
  }
})

router.get('/shopify/disconnect', authenticateToken, async (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: MissingRequiredParametersError });

  const user = await prisma.user.findUnique({
    where: { id: user_id },
  });
  if (!user) return res.status(404).json({ error: UserNotFoundError });

  try {
    const integration = await prisma.integration.findFirst({
      where: {
        user_id: user.id,
        type: "shopify",
      },
    });

    const token = integration?.token;
    if (token == null) {
      throw new Error("Access token is not defined");
    }
    const revokeUrl = `https://${integration?.shop}.myshopify.com/admin/api_permissions/current.json`;
    const options = {
      method: "DELETE",
      headers: {
        "X-Shopify-Access-Token": token,
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
  } catch (error: any) {
    console.error(error);
    return res.status(500).json({ error: InternalServerError });
  }
})

router.get('/shopify/callback', async (req, res) => {
  try {
    const fullUrl = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
    const url = new URL(fullUrl);
    const { code, state, hmac, host } = req.query;
    let shop = req.query.shop as string;
    if (!code || !state || !hmac || !host || !shop)
      return res.status(400).json({ error: 'MissingRequiredParametersError' });

    const queryWithoutHmac = extractQueryWithoutHMAC(url);
    const user = await prisma.user.findUnique({ where: { id: state as string } });
    if (!user) return res.status(404).json({ error: 'UserNotFoundError' });

    const sameHMAC = validateHMAC(queryWithoutHmac, hmac as string);
    if (!sameHMAC) return res.status(400).json({ error: 'Invalid HMAC' });

    // Validate shop
    const shopRegex = /^[a-zA-Z0-9][a-zA-Z0-9-]*\.myshopify\.com$/;
    if (!shopRegex.test(shop)) {
      return res.status(400).json({ error: 'Invalid shop parameter' });
    }

    if (shop != null) {
      shop = shop.replace('.myshopify.com', '');
    }

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
      const errorText = await webhooksResponse.text();
      console.error(`Failed to fetch webhooks: ${errorText}`);
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
          const errorText = await deleteResponse.text();
          console.error(`Failed to delete webhook: ${errorText}`);
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
      const errorText = await webhookResponse.text();
      console.error(`Failed to subscribe to the bulk_operations/finish webhook: ${errorText}`);
      return res.status(400).json({ error: 'Failed to subscribe to the bulk_operations/finish webhook' });
    }

    const webhookData: any = await webhookResponse.json();
    if (webhookData.data.webhookSubscriptionCreate.userErrors.length > 0) {
      console.error(webhookData.data.webhookSubscriptionCreate.userErrors);
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
              callbackUrl: "http://localhost:8000/webhooks/shopify/uninstall?shop=${shop}&state=${user.id}",
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
      const errorText = await webhookUninstallApp.text();
      console.error(`Failed to subscribe to the app/uninstall webhook: ${errorText}`);
      return res.status(400).json({ error: 'Failed to subscribe to the app/uninstall webhook' });
    }

    // Trigger the bulk query for orders
    const ordersWebhookResponse = await fetch('http://localhost:8000/shopify/bulk-query-trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: user.id }),
    });

    if (!ordersWebhookResponse.ok) {
      const data: any = await ordersWebhookResponse.json();
      return res.status(400).json({ error: data.error });
    }

    console.log('Successfully triggered the bulk query for orders');
    console.log(await ordersWebhookResponse.json());

    return res.redirect('http://localhost:3000/dashboard/integrations');
  } catch (error: any) {
    console.error(error);
    return res.status(500).json({ error: InternalServerError });
  }
})

router.post('/klaviyo/connect', authenticateToken, async (req, res) => {
  const { user_id, api_key } = req.body;
  if (!user_id || !api_key) return res.status(400).json({ error: MissingRequiredParametersError });

  const user = await prisma.user.findUnique({
    where: { id: user_id },
  });
  if (!user) return res.status(404).json({ error: UserNotFoundError });

  try {
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
      return res.status(400).json({ error: "Ugyldig API key. Er du sikker på, den har read-access til segmenter?" });
    }

    await prisma.integration.create({
      data: {
        type: "klaviyo",
        user_id: user.id,
        klaviyo_api_key: api_key,
      },
    });

    return res.status(200).json({ success: "Klaviyo-integrationen blev oprettet" });
  } catch (error: any) {
    console.error(error);
    return res.status(500).json({ error: InternalServerError });
  }
})

router.get('/klaviyo/disconnect', authenticateToken, async (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: MissingRequiredParametersError });

  const user = await prisma.user.findUnique({
    where: { id: user_id },
  });
  if (!user) return res.status(404).json({ error: UserNotFoundError });

  try {
    await prisma.integration.deleteMany({
      where: {
        user_id: user.id,
        type: "klaviyo",
      },
    });

    return res.status(200).json({ success: "Klaviyo-integrationen blev slettet" });
  } catch (error: any) {
    console.error(error);
    return res.status(500).json({ error: InternalServerError });
  }
})

export default router;