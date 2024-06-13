import { PrismaClient } from '@prisma/client'
import { Order } from './types'
import { Order as PrismaOrder } from '@prisma/client'
const prisma = new PrismaClient()

export const loadUserWithShopifyIntegration = async (userId: string) => {
  try {
    return await prisma.user.findUnique({
      where: { id: userId },
      include: {
        integrations: true,
        campaigns: {
          include: { segment: true },
        },
      },
    });
  } catch (error) {
    console.error(`Failed to load user with Shopify integration: ${error}`);
    throw new Error(`Failed to load user with Shopify integration: ${error}`);
  }
};

export const getBulkOperationUrl = async (shop: string, token: string, apiId: string) => {
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
    console.error(`Failed to fetch bulk operation URL: ${data.errors}`);
    throw new Error(`Failed to fetch bulk operation URL: ${data.errors}`);
  }

  return data.data.node.url;
};

export const fetchBulkOperationData = async (url: string) => {
  const orderResponse = await fetch(url);

  if (!orderResponse.ok || !orderResponse.body) {
    console.error(`Failed to fetch bulk operation data: ${orderResponse.statusText}`);
    throw new Error(`Failed to fetch bulk operation data: ${orderResponse.statusText}`);
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
        console.error(`Failed to parse order: ${error}`);
      }
    }
  }

  return orders;
};

export const saveOrders = async (userId: string, shopifyOrders: Order[]) => {
  const existingDbOrders = await prisma.order.findMany({
    where: {
      user_id: userId,
      order_id: { in: shopifyOrders.map(shopifyOrder => shopifyOrder.id) },
    },
  });

  const newShopifyOrders = shopifyOrders.filter(
    (shopifyOrder) => !existingDbOrders.some((existingDbOrder) => existingDbOrder.order_id === shopifyOrder.id),
  );

  if (newShopifyOrders.length > 0) {
    await prisma.order.createMany({
      data: newShopifyOrders.map(newShopifyOrder => formatOrderData(newShopifyOrder, userId)),
      skipDuplicates: true,
    });
  }

  return newShopifyOrders;
};

export const processOrdersForCampaigns = async (user: any, allOrders: PrismaOrder[]) => {
  const campaigns = user.campaigns;
  const profilePromises = allOrders.map(allOrder => findAndUpdateProfile(allOrder, campaigns));
  return await Promise.all(profilePromises);
};

export const findAndUpdateProfile = async (allOrder: PrismaOrder, campaigns: any[]) => {
  for (const campaign of campaigns) {

    const campaignStartDate = new Date(campaign.start_date);
    const campaignEndDate = new Date(campaignStartDate);
    campaignEndDate.setDate(campaignEndDate.getDate() + 60);

    const shopifyOrderCreatedAt = new Date(allOrder.created_at);

    if (shopifyOrderCreatedAt >= campaignStartDate && shopifyOrderCreatedAt <= campaignEndDate) {
      const profiles = await prisma.profile.findMany({
        where: buildProfileWhereClause(allOrder, campaign.segment_id),
        include: { orders: true },
      });

      if (profiles.length > 0) {
        // check if the profiles has already been associated with the order

        for (const profile of profiles) {
          const existingDbOrder = await prisma.orderProfile.findFirst({
            where: {
              order_id: allOrder.id,
              profile_id: profile.id,
            }
          });

          if (existingDbOrder) {
            continue;
          }

          // Update the order to connect with the profileId
          await prisma.orderProfile.create({
            data: {
              order_id: allOrder.id,
              profile_id: profile.id,
            },
          });
        }
      }
    }
  }
};

export const buildProfileWhereClause = (allOrder: PrismaOrder, segmentId: string) => {
  const firstName = allOrder.first_name.toLowerCase();
  const lastName = allOrder.last_name.toLowerCase();
  const email = allOrder.email.toLowerCase();
  const zip = allOrder.zip_code;
  const addressFull = allOrder.address;
  const discountCodes = allOrder.discount_codes;
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

export const formatOrderData = (newShopifyOrder: Order, userId: string) => ({
  created_at: newShopifyOrder.createdAt,
  order_id: newShopifyOrder.id,
  user_id: userId,
  amount: newShopifyOrder.totalPriceSet ? parseFloat(newShopifyOrder.totalPriceSet.shopMoney.amount) : 0,
  discount_codes: newShopifyOrder.discountCodes,
  first_name: newShopifyOrder.customer?.firstName?.toLowerCase() || "",
  last_name: newShopifyOrder.customer?.lastName?.toLowerCase() || "",
  email: newShopifyOrder.customer?.email?.toLowerCase() || "",
  zip_code: newShopifyOrder.customer?.addresses?.[0]?.zip || "",
  address: newShopifyOrder.customer?.addresses?.[0]?.address1?.toLowerCase() || "",
});

export const getAddressComponents = (addressFull: string) => {
  const addressMatch = addressFull.match(/^(\D*\d+)/) || [];
  return addressMatch[0] || addressFull;
};

export async function triggerShopifyBulkQueries() {
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
    console.error("No users found with Shopify integration");
    return;
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
}