import { Router } from 'express';
import { logtail, prisma } from '../app';
import { fetchBulkOperationData, getBulkOperationUrl, loadUserWithShopifyIntegration, processOrdersForCampaigns, saveOrders } from '../functions';

const router = Router();

router.post('/bulk-query-trigger', async (req, res) => {
  try {
    const { user_id } = req.body;

    if (!user_id) {
      return res.status(400).json({ error: 'Mangler user_id i request body' });
    }

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
                refunds {
                  id
                  createdAt
                  refundLineItems {
                    id
                    lineItemId
                    quantity
                    subtotalSet {
                      shopMoney {
                        amount
                        currencyCode
                      }
                    }
                    totalTaxSet {
                      shopMoney {
                        amount
                        currencyCode
                      }
                    }
                  }
                }
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

    if (!response.ok) {
      return res.status(500).json({ error: `Der opstod en fejl under oprettelse af bulk query for bruger ${user.id}: ${data.errors}` });
    }

    logtail.info(`Triggered bulk query for user with email ${user.email}`);

    return res.status(200).json({ message: `Bulk query oprettet for bruger ${user.id}` });
  } catch (error: any) {
    logtail.error(error.message);
    return res.status(500).json({ error: error.message });
  }
});

router.post('/bulk-query-finished', async (req, res) => {
  const { admin_graphql_api_id } = req.body;
  const { shop, state } = req.query;

  if (!admin_graphql_api_id || !shop || !state) {
    return res.status(400).json({ error: 'Mangler påkrævede parametre' });
  }

  const user = await prisma.user.findUnique({
    where: { id: state as string },
    include: {
      integrations: true,
      campaigns: {
        include: { segment: true },
      },
    },
  });

  if (!user) {
    logtail.error(`Processing bulk query failed because user with user_id ${state} does not exist`);
    return res.status(404).json({ error: `Bruger med user_id ${state} findes ikke` });
  }

  const shopifyToken = user.integrations.find((integration: any) => integration.type === 'shopify')?.token;

  if (!shopifyToken) {
    logtail.error(`Processing bulk query failed because user with user_id ${state} does not have a valid Shopify integration`);
    return res.status(404).json({ error: `Bruger med user_id ${state} har ikke en gyldig Shopify-integration` });
  }

  let url: string;
  try {
    url = await getBulkOperationUrl(shop as string, shopifyToken, admin_graphql_api_id, user.id);
  } catch (error: any) {
    logtail.error(error.message);
    return res.status(error.statusCode).json({ error: error.message });
  }

  let shopifyOrders: any;
  try {
    shopifyOrders = await fetchBulkOperationData(url, user.id);
  } catch (error: any) {
    logtail.error(error.message);
    return res.status(error.statusCode).json({ error: error.message });
  }

  try {
    await saveOrders(user, shopifyOrders);
  } catch (error: any) {
    logtail.error(error.message);
    return res.status(error.statusCode).json({ error: error.message });
  }

  let allOrders: any[] = [];
  const batchSize = 10000;
  let skip = 0;

  while (true) {
    const ordersBatch = await prisma.order.findMany({
      where: { user_id: user.id },
      skip,
      take: batchSize,
    });

    if (ordersBatch.length === 0) {
      break;
    }

    allOrders = allOrders.concat(ordersBatch);
    skip += batchSize;
  }

  try {
    await processOrdersForCampaigns(user, allOrders);
  } catch (error: any) {
    logtail.error(error.message);
    return res.status(error.statusCode).json({ error: error.message });
  }

  logtail.info(`Processed bulk query for user with email ${user.email}`);

  return res.status(200).json({ message: "ok" });
});

export default router;
