import { Router } from 'express';
import { prisma } from '../app';
import { fetchBulkOperationData, getBulkOperationUrl, loadUserWithShopifyIntegration, processOrdersForCampaigns, saveOrders } from '../functions';

const router = Router();

router.post('/bulk-query-trigger', async (req, res) => {
  console.log("TRIGGER")
  const { user_id } = req.body;

  if (!user_id) {
    return res.status(400).json({ error: 'Mangler user_id i request body' });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id: user_id },
      include: { integrations: true, campaigns: true },
    });

    if (!user) {
      return res.status(404).json({ error: `Bruger med id ${user_id} findes ikke` });
    }

    const shopifyIntegration = user.integrations.find(integration => integration.type === 'shopify');

    if (!shopifyIntegration || !shopifyIntegration.token) {
      return res.status(400).json({ error: `Bruger med id ${user_id} har ikke en gyldig Shopify-integration` });
    }

    const currentDate = new Date();
    const currentDateMinus365Days = new Date(
      currentDate.setDate(currentDate.getDate() - 365),
    );
    const dateOnly = currentDateMinus365Days.toISOString().split('T')[0];
    const shopifyApiVersion = '2021-10';

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
    const response = await fetch(shopifyApiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': shopifyIntegration.token },
      body: JSON.stringify({ query: shopifyBulkOperationQuery }),
    });

    const data: any = await response.json();
    console.log(data.data.bulkOperationRunQuery.bulkOperation)

    if (!response.ok) {
      return res.status(500).json({ error: `Der opstod en fejl under oprettelse af bulk query for bruger ${user.id}: ${data.errors}` });
    }

    return res.status(200).json({ message: `Bulk query oprettet for bruger ${user.id}` });
  } catch (error: any) {
    return res.status(500).json({ error: `Der opstod en fejl under oprettelse af bulk query for bruger ${user_id}: ${error.message}` });
  }
});

router.post('/bulk-query-finished', async (req, res) => {
  console.log("FINISHED")
  const { admin_graphql_api_id } = req.body;
  const { shop, state } = req.query;

  if (!admin_graphql_api_id || !shop || !state) {
    return res.status(400).json({ error: 'Mangler påkrævede parametre' });
  }

  try {
    const user = await loadUserWithShopifyIntegration(state as string);

    if (!user) {
      return res.status(404).json({ error: `Bruger med user_id ${state} findes ikke` });
    }

    const shopifyToken = user.integrations.find((integration: any) => integration.type === 'shopify')?.token;

    if (!shopifyToken) {
      return res.status(404).json({ error: `Bruger med user_id ${state} har ikke en gyldig Shopify-integration` });
    }

    const url = await getBulkOperationUrl(shop as string, shopifyToken, admin_graphql_api_id);
    const shopifyOrders = await fetchBulkOperationData(url);

    await saveOrders(user.id, shopifyOrders);

    const allOrders = await prisma.order.findMany({ where: { user_id: user.id } });
    await processOrdersForCampaigns(user, allOrders);

    return res.status(200).json({ message: "ok" });
  } catch (error: any) {
    return res.status(500).json({ error: `Der opstod en fejl under behandling af bulk query for bruger ${state}: ${error.message}` });
  }
});

export default router;
