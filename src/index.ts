import * as Sentry from "@sentry/node";
import { nodeProfilingIntegration } from "@sentry/profiling-node";

Sentry.init({
  dsn: "https://65d3e283420a03a763042d0b2d669bdc@o4507426520760320.ingest.de.sentry.io/4507426522398800",
  integrations: [
    nodeProfilingIntegration(),
  ],
  tracesSampleRate: 1.0, //  Capture 100% of the transactions
  profilesSampleRate: 1.0,
});

import "dotenv/config";
import express from "express";
import { PrismaClient } from "@prisma/client";
import cron from "node-cron";

// Import your functions
import { fetchBulkOperationData, getBulkOperationUrl, loadUserWithShopifyIntegration, processOrdersForCampaigns, saveOrders, triggerShopifyBulkQueries } from "./functions";

// Initialize Prisma and Express
const prisma = new PrismaClient();
const app = express();

// Use JSON parser middleware
app.use(express.json());

// Trigger Shopify bulk queries every day at midnight
cron.schedule('0 0 * * *', triggerShopifyBulkQueries)

app.get('/', async (req, res) => {
  return res.status(200).json({ message: "Hello Worlds!" });
});

app.post('/shopify-bulk-query-trigger-user', async (req, res) => {
  const requestBody = req.body;
  let user_id;

  try {
    user_id = requestBody.user_id;
  } catch (error) {
    return res.status(400).json({ error: 'Mangler user_id i request body' });
  }

  const user = await prisma.user.findUnique({
    where: { id: user_id },
    include: {
      integrations: true,
      campaigns: true,
    },
  });

  if (user === null || user === undefined) {
    return res.status(404).json({ error: `Bruger med id ${user_id} findes ikke` });
  }

  const shopifyIntegration = user.integrations.find(
    (integration) => integration.type === 'shopify',
  );

  if (!shopifyIntegration || !shopifyIntegration.token) {
    return res.status(400).json({ error: `Bruger med id ${user_id} har ikke en gyldig Shopify-integration` });
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
      return res.status(500).json({ error: `Der opstod en fejl under oprettelse af bulk query for bruger ${user.id}: ${data.errors}` });
    }

    return res.status(200).json({ message: `Bulk query oprettet for bruger ${user.id}` });
  } catch (error) {
    throw new Error(`Der opstod en fejl under oprettelse af bulk query for bruger ${user.id}: ${error}`);
  }
});

app.post('/shopify-bulk-query-finished', async (req, res) => {

  let admin_graphql_api_id;
  let shop;
  let state;

  try {
    admin_graphql_api_id = req.body.admin_graphql_api_id;
    shop = req.query.shop as string;
    state = req.query.state as string;
  } catch (error) {
    return res.status(400).json({ error: 'Mangler påkrævede parametre' });
  }

  try {
    const user = await loadUserWithShopifyIntegration(state);

    if (user === null || user === undefined) {
      return res.status(404).json({ error: `Bruger med user_id ${state} findes ikke` });
    }

    const shopifyToken = user.integrations.find(
      (integration) => integration.type === 'shopify'
    )?.token;

    if (shopifyToken === null || shopifyToken === undefined) {
      return res.status(404).json({ error: `Bruger med user_id ${state} har ikke en gyldig Shopify-integration` });
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
    throw new Error(`Der opstod en fejl under behandling af bulk query for bruger ${state}: ${error}`);
  }
});

Sentry.setupExpressErrorHandler(app);

app.listen(3000, () =>
  console.log(`
🚀 Server ready at: http://localhost:3000`))