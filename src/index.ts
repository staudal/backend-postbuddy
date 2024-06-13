import { PrismaClient } from '@prisma/client'
import express from 'express'
import { Order } from './types'

require('dotenv').config()
const prisma = new PrismaClient()
const app = express()

app.use(express.json())

app.listen(3000, () =>
  console.log(`
🚀 Server ready at: http://localhost:3000`))

// ENDPOINT TO TRIGGER SHOPIFY BULK QUERY
app.get('/shopify-bulk-query-trigger', async (req, res) => {
  console.log("HIT: /shopify-bulk-query-trigger")
  const users = await prisma.user.findMany({
    where: {
      integrations: {
        some: {
          type: "shopify",
        },
      },
    },
    include: {
      integrations: true,
      campaigns: true,
    },
  });

  if (users.length === 0) {
    return res.status(404).send('No users found with Shopify integration');
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

  const userPromises = users.map((user) => {
    const shopifyIntegration = user.integrations.find(
      (integration) => integration.type === 'shopify',
    );

    if (!shopifyIntegration || !shopifyIntegration.token) {
      console.error(`User ${user.id} does not have a valid Shopify integration`);
      return Promise.resolve();
    }

    const shopifyApiUrl = `https://${shopifyIntegration.shop}.myshopify.com/admin/api/${shopifyApiVersion}/graphql.json`;
    const shopifyApiHeaders = {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': shopifyIntegration.token,
    };

    return fetch(shopifyApiUrl, {
      method: 'POST',
      headers: shopifyApiHeaders,
      body: JSON.stringify({ query: shopifyBulkOperationQuery }),
    })
      .then(async (response) => {
        const data: any = await response.json();
        if (!response.ok) {
          console.error(`Failed to create bulk query for user ${user.id}: ${data.errors}`);
        } else {
          console.log(
            `Created bulk query for user ${user.id}: ${data.data.bulkOperationRunQuery.bulkOperation.id}`,
          );
        }
      })
      .catch((error) => {
        console.error(`Error creating bulk query for user ${user.id}: ${error}`);
      });
  });

  await Promise.allSettled(userPromises);

  res.status(200).send('Shopify bulk queries triggered');
});

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

    const orders = await fetchBulkOperationData(url);

    await saveOrders(user.id, orders);

    await processOrdersForCampaigns(user, orders);

    return res.status(200).json({ message: "ok" });

  } catch (error) {
    console.error("Error processing bulk query finished:", error);
    return res.status(500).json({ error: "Internal server error" });
  }
});


const loadUserWithShopifyIntegration = async (userId: string) => {
  return await prisma.user.findUnique({
    where: { id: userId },
    include: {
      integrations: true,
      campaigns: {
        include: { segment: true },
      },
    },
  });
};

const getBulkOperationUrl = async (shop: string, token: string, apiId: string) => {
  const response = await fetch(
    `https://${shop}.myshopify.com/admin/api/2021-10/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({
        query: `
        query {
          node(id: "${apiId}") {
            ... on BulkOperation {
              url
              partialDataUrl
            }
          }
        }
      `,
      }),
    },
  );

  const data: any = await response.json();

  if (!response.ok || !data.data?.node?.url) {
    throw new Error('Failed to retrieve bulk operation data URL');
  }

  console.log(`Bulk operation URL: ${data.data.node.url}`);
  return data.data.node.url;
};

const fetchBulkOperationData = async (url: string) => {
  const orderResponse = await fetch(url);

  if (!orderResponse.ok || !orderResponse.body) {
    throw new Error('Failed to retrieve bulk operation data');
  }

  const reader = orderResponse.body.getReader();
  const decoder = new TextDecoder();
  let orders: Order[] = [];
  let responseBody = '';

  while (true) {
    const { done, value } = await reader.read();
    responseBody += decoder.decode(value, { stream: !done });

    if (done) break;
  }

  const lines = responseBody.trim().split('\n');

  for (const line of lines) {
    if (line) {
      try {
        const order: Order = JSON.parse(line);
        orders.push(order);
      } catch (error) {
        console.error("Failed to parse line as JSON:", line, error);
      }
    }
  }

  return orders;
};

const saveOrders = async (userId: string, orders: Order[]) => {
  const savedOrders = await prisma.order.findMany({
    where: {
      user_id: userId,
      order_id: { in: orders.map(order => order.id) },
    },
  });

  const newOrders = orders.filter(
    (order) => !savedOrders.some((savedOrder) => savedOrder.order_id === order.id),
  );

  if (newOrders.length > 0) {
    await prisma.order.createMany({
      data: newOrders.map(order => formatOrderData(order, userId)),
      skipDuplicates: true,
    });
  }

  console.log(`Saved ${newOrders.length} new orders`);
  return newOrders;
};

const processOrdersForCampaigns = async (user: any, orders: any[]) => {
  const campaigns = user.campaigns;
  const profilePromises = orders.map(order => findAndUpdateProfile(order, campaigns));
  console.log(`Processing ${profilePromises.length} orders for ${campaigns.length} campaigns`);
  return await Promise.all(profilePromises);
};

const findAndUpdateProfile = async (order: Order, campaigns: any[]) => {
  for (const campaign of campaigns) {
    console.log(`Processing order ${order.id} for campaign ${campaign.id}`);
    const campaignStartDate = new Date(campaign.start_date);
    console.log(`Campaign start date: ${campaignStartDate}`);
    const campaignEndDate = new Date(campaignStartDate);
    console.log(`Campaign end date: ${campaignEndDate}`);
    campaignEndDate.setDate(campaignEndDate.getDate() + 60);

    const orderCreatedAt = new Date(order.createdAt);
    if (orderCreatedAt >= campaignStartDate && orderCreatedAt <= campaignEndDate) {
      console.log(`Order ${order.id} falls within campaign ${campaign.id} date range`);
      const profile = await prisma.profile.findFirst({
        where: buildProfileWhereClause(order, campaign.segment_id),
        include: { orders: true },
      });

      if (profile) {

        // if the order is already connected to the profile, skip
        if (profile.orders.some((profileOrder) => profileOrder.order_id === order.id)) {
          return;
        }

        await prisma.profile.update({
          where: { id: profile.id },
          data: { orders: { connect: { id: order.id } } },
        });
        console.log(`Updated profile for order ${order.id}`);
      }
    }
  }
};

const buildProfileWhereClause = (order: Order, segmentId: string) => {
  const firstName = order.customer?.firstName?.toLowerCase() || "";
  const lastName = order.customer?.lastName?.toLowerCase() || "";
  const email = order.customer?.email?.toLowerCase() || "";
  const zip = order.customer?.addresses?.[0]?.zip || "";
  const addressFull = order.customer?.addresses?.[0]?.address1?.toLowerCase() || "";
  const discountCodes = order.discountCodes;
  const address = getAddressComponents(addressFull);
  const lastWordOfLastName = lastName.split(" ").pop() || "";

  return {
    OR: [
      { email },
      { address: { contains: address }, zip_code: zip, first_name: firstName, last_name: lastWordOfLastName },
      { segment: { campaign: { discount_codes: { hasSome: discountCodes } } } },
    ],
    letter_sent: true,
    segment_id: segmentId,
  };
};

const formatOrderData = (order: Order, userId: string) => ({
  created_at: order.createdAt,
  order_id: order.id,
  user_id: userId,
  amount: order.totalPriceSet ? parseFloat(order.totalPriceSet.shopMoney.amount) : 0,
  discount_codes: order.discountCodes,
  first_name: order.customer?.firstName?.toLowerCase() || "",
  last_name: order.customer?.lastName?.toLowerCase() || "",
  email: order.customer?.email?.toLowerCase() || "",
  zip_code: order.customer?.addresses?.[0]?.zip || "",
  address: order.customer?.addresses?.[0]?.address1?.toLowerCase() || "",
});

const getAddressComponents = (addressFull: string) => {
  const addressMatch = addressFull.match(/^(\D*\d+)/) || [];
  return addressMatch[0] || addressFull;
};