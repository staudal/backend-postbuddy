import { PrismaClient } from '@prisma/client'
import express from 'express'
import { fetchBulkOperationData, getBulkOperationUrl, loadUserWithShopifyIntegration, processOrdersForCampaigns, saveOrders, triggerShopifyBulkQueries } from './functions'
import cron from 'node-cron'

require('dotenv').config()
const prisma = new PrismaClient()
const app = express()

app.use(express.json())

app.listen(3000, () =>
  console.log(`
🚀 Server ready at: http://localhost:3000`))

// Trigger Shopify bulk queries every day at midnight
cron.schedule('0 0 * * *', triggerShopifyBulkQueries)

app.post('/shopify-bulk-query-trigger-user', async (req, res) => {
  console.log("HIT: /shopify-bulk-query-trigger-user")
  console.log("HIT: /shopify-bulk-query-trigger-user")
  const { user_id } = req.body;

  if (!user_id) {
    return res.status(400).send('Missing user_id in request body');
  }

  const user = await prisma.user.findUnique({
    where: { id: user_id },
    include: {
      integrations: true,
      campaigns: true,
    },
  });

  if (!user) {
    return res.status(404).send(`User not found for user_id: ${user_id}`);
  }

  const shopifyIntegration = user.integrations.find(
    (integration) => integration.type === 'shopify',
  );

  if (!shopifyIntegration || !shopifyIntegration.token) {
    return res.status(400).send(`User ${user.id} does not have a valid Shopify integration`);
  }

  const currentDate = new Date();
  const currentDateMinus365Days = new Date(currentDate);
  currentDateMinus365Days.setDate(currentDate.getDate() - 365);
  const dateOnly = currentDateMinus365Days.toISOString().split('T')[0];
  const shopifyApiVersion = '2021-10'; // Ideally, this should be a configurable constant

  const shopifyBulkOperationQuery = `
    mutation {
      bulkOperationRunQuery(
        query: """
          {
            orders(query: "created_at:>${dateOnly}") {
              edges {
                node {
                  id
                  totalPriceSet {
                    shopMoney {
                      amount
                      currencyCode
                    }
                  }
                  customer {
                    firstName
                    lastName
                    email
                    addresses(first: 1) {
                      address1
                      zip
                      city
                      country
                    }
                  }
                  createdAt
                  discountCodes
                }
              }
            }
          }
        """
      ) {
        bulkOperation {
          id
          status
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const shopifyApiUrl = `https://${shopifyIntegration.shop}.myshopify.com/admin/api/${shopifyApiVersion}/graphql.json`;
  const shopifyApiHeaders = {
    'Content-Type': 'application/json',
    'X-Shopify-Access-Token': shopifyIntegration.token,
  };

  try {
    const response = await fetch(shopifyApiUrl, {
      method: 'POST',
      headers: shopifyApiHeaders,
      body: JSON.stringify({ query: shopifyBulkOperationQuery }),
    });

    const data: any = await response.json();

    if (!response.ok) {
      console.error(`Failed to create bulk query for user ${user.id}: ${data.errors}`);
      return res.status(500).json({ error: `Failed to create bulk query for user ${user.id}` });
    }

    console.log(`Created bulk query for user ${user.id}: ${data.data.bulkOperationRunQuery.bulkOperation.id}`);
    res.status(200).json({ message: `Bulk query triggered for user ${user.id}`, bulkOperationId: data.data.bulkOperationRunQuery.bulkOperation.id });
  } catch (error) {
    console.error(`Error creating bulk query for user ${user.id}:`, error);
    return res.status(500).json({ error: `Internal server error` });
  }
});

app.post('/shopify-bulk-query-finished', async (req, res) => {
  console.log("HIT: /shopify-bulk-query-finished")
  const { admin_graphql_api_id } = req.body;
  const shop = req.query.shop as string;
  const state = req.query.state as string;

  if (!admin_graphql_api_id || !shop || !state) {
    return res.status(400).send('Missing required parameters');
  }

  try {
    const user = await loadUserWithShopifyIntegration(state);

    if (!user) {
      return res.status(404).send('User not found');
    }

    const shopifyToken = user.integrations.find(
      (integration) => integration.type === 'shopify'
    )?.token;

    if (!shopifyToken) {
      return res.status(400).send('User does not have a valid Shopify integration');
    }

    const url = await getBulkOperationUrl(shop, shopifyToken, admin_graphql_api_id);

    const shopifyOrders = await fetchBulkOperationData(url);

    await saveOrders(user.id, shopifyOrders);

    const allOrders = await prisma.order.findMany({
      where: { user_id: user.id },
    });

    await processOrdersForCampaigns(user, allOrders);

    return res.status(200).json({ message: "ok" });

  } catch (error) {
    console.error("Error processing bulk query finished:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});