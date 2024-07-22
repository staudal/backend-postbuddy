import { PrismaClient, Profile, User } from '@prisma/client';
import { KlaviyoSegmentProfile, Order, ProfileToAdd } from './types';
import { Order as PrismaOrder } from '@prisma/client';
import Stripe from 'stripe';
import { ErrorWithStatusCode, FailedToBillUserError, FailedToGeneratePdfError, FailedToSendPdfToPrintPartnerError, FailedToUpdateProfilesToSentError, MissingSubscriptionError } from './errors';
import CreativeEngine, * as CESDK from '@cesdk/node';
import { MimeType } from '@cesdk/node';
import { PDFDocument } from 'pdf-lib';
import Client from "ssh2-sftp-client";
import { createHmac } from 'node:crypto';
import { config } from './constants';
import { logtail } from './app';
import { subDays } from 'date-fns';
import { S3Client } from '@aws-sdk/client-s3';

export const prisma = new PrismaClient({
  transactionOptions: {
    timeout: 10000,
  }
})

export const s3 = new S3Client({
  forcePathStyle: true,
  region: 'eu-central-1',
  endpoint: 'https://rkjrflfwfqhhpwafimbe.supabase.co/storage/v1/s3',
  credentials: {
    accessKeyId: '317fb0867435e048caf40891fe400b38',
    secretAccessKey: '8e2d04c347e7c863edeebb42a1e7db32bae73d6ee922103b24e61d2b7d5d4b50',
  }
})

export const loadUserWithShopifyIntegration = async (userId: string) => {
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

export const getBulkOperationUrl = async (shop: string, token: string, apiId: string, userId: string) => {
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
    throw new ErrorWithStatusCode(`Failed to fetch bulk operation URL for user with id ${userId}: ${data.errors}`, 500);
  }

  return data.data.node.url;
};

export const fetchBulkOperationData = async (url: string, userId: string) => {
  const orderResponse = await fetch(url);

  if (!orderResponse.ok || !orderResponse.body) {
    throw new ErrorWithStatusCode(`Failed to fetch bulk operation data for user with id ${userId}: ${orderResponse.statusText}`, 500);
  }

  try {
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
        const order: Order = JSON.parse(line);
        orders.push(order);
      }
    }

    return orders;
  } catch (error) {
    throw new ErrorWithStatusCode(`Failed to read bulk operation data for user with id ${userId}: ${error}`, 500);
  }
};

export const saveOrders = async (user: User, shopifyOrders: Order[]) => {
  const BATCH_SIZE = 1000;

  try {
    // Map of order IDs to shopify orders for quick lookup
    const shopifyOrderMap = new Map(shopifyOrders.map(order => [order.id, order]));

    // Split orders into batches
    const batches = [];
    for (let i = 0; i < shopifyOrders.length; i += BATCH_SIZE) {
      batches.push(shopifyOrders.slice(i, i + BATCH_SIZE));
    }

    // Process each batch concurrently
    await Promise.all(batches.map(async (batch) => {
      const orderIds = batch.map(order => order.id);

      // Use a transaction to handle all operations in the batch
      await prisma.$transaction(async (prisma) => {
        // Fetch existing orders in a single query
        const existingDbOrders = await prisma.order.findMany({
          where: {
            user_id: user.id,
            order_id: { in: orderIds },
          },
        });

        // Identify new Shopify orders
        const existingOrderIds = new Set(existingDbOrders.map(order => order.order_id));
        const newShopifyOrders = batch.filter(order => !existingOrderIds.has(order.id));

        // Save new orders if any
        if (newShopifyOrders.length > 0) {
          await prisma.order.createMany({
            data: newShopifyOrders.map(order => formatOrderData(order, user.id)),
            skipDuplicates: true,
          });
        }

        // Identify refunded orders from the existing DB orders
        const refundedOrders = existingDbOrders.filter(dbOrder => {
          const shopifyOrder = shopifyOrderMap.get(dbOrder.order_id);
          return shopifyOrder && shopifyOrder.refunds.length > 0;
        });

        // Handle refunded orders if any
        if (refundedOrders.length > 0) {
          const updates = refundedOrders.map(async (dbOrder) => {
            const shopifyOrder = shopifyOrderMap.get(dbOrder.order_id);

            if (!shopifyOrder) {
              return;
            }

            let refundedAmount = 0;

            // Calculate the total refunded amount from the refunded items
            for (const refund of shopifyOrder.refunds) {
              for (const refundItem of refund.refundLineItems) {
                const subtotal = parseFloat(refundItem.subtotalSet.shopMoney.amount);
                const totalTax = parseFloat(refundItem.totalTaxSet.shopMoney.amount);
                refundedAmount += subtotal + totalTax;
              }
            }

            // Update or delete the order amount in the database
            const updatedAmount = dbOrder.amount - refundedAmount;

            if (updatedAmount <= 0) {
              // Delete the order if the total amount is 0 or negative
              await prisma.orderProfile.deleteMany({
                where: { order_id: dbOrder.id },
              });

              await prisma.order.delete({
                where: { id: dbOrder.id },
              });
            } else {
              // Update the order amount if it's positive
              await prisma.order.update({
                where: { id: dbOrder.id },
                data: { amount: updatedAmount },
              });
            }
          });

          await Promise.all(updates);
        }
      });

    }));

  } catch (error) {
    logtail.error(`Failed to save orders for user ${user.id}: ${error}`);
    throw new ErrorWithStatusCode(`Failed to save orders for user ${user.id}`, 500);
  } finally {
    logtail.info(`Successfully saved/updated orders for user ${user.email}`);
  }

  return shopifyOrders;
};


export const processOrdersForCampaigns = async (user: any, allOrders: PrismaOrder[]) => {
  try {
    const campaigns = user.campaigns;
    for (const allOrder of allOrders) {
      await findAndUpdateProfile(allOrder, campaigns);
    }
    return;
  } catch (error: any) {
    throw new ErrorWithStatusCode(error.message, error.statusCode);
  }
};

export const findAndUpdateProfile = async (allOrder: PrismaOrder, campaigns: any[]) => {
  try {
    for (const campaign of campaigns) {
      let revenueForDiscountCodesWithNoProfile = 0;
      const campaignStartDate = new Date(campaign.start_date);
      const campaignEndDate = new Date(campaignStartDate);
      campaignEndDate.setDate(campaignEndDate.getDate() + 60);

      const shopifyOrderCreatedAt = new Date(allOrder.created_at);

      if (shopifyOrderCreatedAt >= campaignStartDate && shopifyOrderCreatedAt <= campaignEndDate) {
        const profile = await prisma.profile.findFirst({
          where: buildProfileWhereClause(allOrder, campaign.segment_id, revenueForDiscountCodesWithNoProfile),
          include: { orders: true },
        });
        if (profile) {
          const existingDbOrder = await prisma.orderProfile.findFirst({
            where: {
              order_id: allOrder.id,
              profile_id: profile.id,
            },
          });

          if (existingDbOrder) {
            continue;
          }

          await prisma.orderProfile.create({
            data: {
              order_id: allOrder.id,
              profile_id: profile.id,
            },
          });
        } else {
          // If no profile is found but the order discount code matches a campaign discount code, add the revenue to the campaign
          const discountCodes = allOrder.discount_codes;
          const matchingDiscountCode = campaign.discount_codes.find((campaignDiscountCode: string) => discountCodes.includes(campaignDiscountCode));
          if (matchingDiscountCode) {
            const profile = await prisma.profile.findFirst({
              where: {
                id: `additional-revenue-${campaign.id}`,
              },
            });
            if (!profile) {
              await prisma.profile.create({
                data: {
                  id: `additional-revenue-${campaign.id}`,
                  first_name: 'additional-revenue',
                  last_name: 'additional-revenue',
                  address: 'additional-revenue',
                  zip_code: 'additional-revenue',
                  city: 'additional-revenue',
                  country: 'additional-revenue',
                  segment_id: campaign.segment_id,
                  letter_sent: true,
                  email: 'additional-revenue',
                },
              });
            }
            const existingDbOrder = await prisma.orderProfile.findFirst({
              where: {
                order_id: allOrder.id,
                profile_id: `additional-revenue-${campaign.id}`,
              },
            });
            if (!existingDbOrder) {
              await prisma.orderProfile.create({
                data: {
                  order_id: allOrder.id,
                  profile_id: `additional-revenue-${campaign.id}`,
                },
              });
            }
          }
        }
      }
    }
  } catch (error: any) {
    throw new ErrorWithStatusCode(error.message, 500);
  }
};

// REMOVED DISCOUNT CODES BECAUSE OF SCEWED RESULTS: MULTIPLE PROFILES ARE FOUND FOR THE SAME ORDER BECAUSE OF NON-UNIQUE DISCOUNT CODES
export const buildProfileWhereClause = (allOrder: PrismaOrder, segmentId: string, revenueForDiscountCodesWithNoProfile: number) => {
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

export const formatOrderData = (newShopifyOrder: Order, userId: string) => {
  return {
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
  };
};

export const getAddressComponents = (addressFull: string) => {
  const addressMatch = addressFull.match(/^(\D*\d+)/) || [];
  return addressMatch[0] || addressFull;
};

export async function triggerShopifyBulkQueries() {
  const users = await prisma.user.findMany({
    where: {
      integrations: {
        some: {
          type: 'shopify',
        },
      },
    },
    include: {
      integrations: true,
      campaigns: true,
    },
  });

  if (users.length === 0) {
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
              refunds {
                id
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

  for (const user of users) {
    const shopifyIntegration = user.integrations.find(
      (integration) => integration.type === 'shopify'
    );

    if (!shopifyIntegration || !shopifyIntegration.token) {
      continue;
    }

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
        logtail.error(`Failed to trigger Shopify bulk query for user ${user.id}: ${data.errors}`);
      } else {
        logtail.info(`Successfully triggered Shopify bulk query for user ${user.id}`);
      }
    } catch (error: any) {
      logtail.error(`Failed to trigger Shopify bulk query for user ${user.id}: ${error.message}`);
    }
  }
}

export async function billUserForLettersSent(profilesLength: number, user_id: string) {
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  if (!STRIPE_SECRET_KEY) {
    throw new ErrorWithStatusCode('Stripe secret key is missing', 500);
  }

  const stripe = new Stripe(STRIPE_SECRET_KEY)
  const subscription = await prisma.subscription.findFirst({
    where: { user_id },
  });
  if (!subscription) {
    logtail.error(`User ${user_id} does not have an active subscription and cannot be billed for letters sent`);
    throw new ErrorWithStatusCode(MissingSubscriptionError, 400);
  }

  const usageRecord = await stripe.subscriptionItems.createUsageRecord(subscription.subscription_item_id, {
    quantity: profilesLength,
    timestamp: Math.floor(Date.now() / 1000),
    action: 'increment',
  });

  if (!usageRecord) {
    logtail.error(`User with id ${user_id} has a subscription but could not be billed for letters sent`);
    throw new ErrorWithStatusCode(FailedToBillUserError, 500);
  }
}

export async function generateTestDesign(blob: string, format: string): Promise<Buffer> {
  const engine = await CreativeEngine.init(config);
  const scene = await engine.scene.loadFromURL(blob);
  const pages = engine.scene.getPages();
  const pageWidth = engine.block.getWidth(pages[0]);
  const pageHeight = engine.block.getHeight(pages[0])
  let idText = engine.block.create("text");

  if (pageWidth === 210 && pageHeight === 148) {
    format = "A5 horizontal";
  } else if (pageWidth === 297 && pageHeight === 210) {
    format = "A4 horizontal";
  } else if (pageWidth === 148 && pageHeight === 210) {
    format = "A5 vertical";
  } else if (pageWidth === 210 && pageHeight === 297) {
    format = "A4 vertical";
  }

  const profile = {
    id: "kd4jXc9df0DsX",
    first_name: "Jens",
    last_name: "Hansen",
    created_at: new Date(),
    address: "Bredgade 19D, 1.tv.",
    city: "København K",
    zip_code: "1260",
    country: "Danmark",
    in_robinson: false,
    segment_id: "test",
    letter_sent: false,
    revenue: 0,
    klaviyo_id: "test",
    letter_sent_at: new Date(),
    email: "test@test.dk",
    custom_variable: "Dette er en custom variable",
    demo: false,
  }

  generateBleedLines(engine, pages, pageWidth, pageHeight)
  updateVariables(engine, profile)
  generateIdBlock(idText, engine, pageWidth, pageHeight, pages, profile);
  const { MimeType } = CESDK;
  const pdfBlob = await engine.block.export(scene, MimeType.Pdf, {
    exportPdfWithHighCompatibility: true
  });

  // Convert the Blob to a Buffer
  const pdfBuffer = Buffer.from(await pdfBlob.arrayBuffer());

  return pdfBuffer;
}

export function generateBleedLines(engine: CreativeEngine, pages: number[], pageWidth: number, pageHeight: number) {
  for (const page of pages) {
    const bottomRightHorizontalBlackBleedLine = engine.block.create("graphic")
    engine.block.setShape(bottomRightHorizontalBlackBleedLine, engine.block.createShape("rect"))
    engine.block.setFill(bottomRightHorizontalBlackBleedLine, engine.block.createFill("color"))
    engine.block.setWidth(bottomRightHorizontalBlackBleedLine, 5)
    engine.block.setHeight(bottomRightHorizontalBlackBleedLine, 0.25)
    engine.block.setPositionX(bottomRightHorizontalBlackBleedLine, pageWidth)
    engine.block.setPositionY(bottomRightHorizontalBlackBleedLine, pageHeight)
    engine.block.setFillSolidColor(bottomRightHorizontalBlackBleedLine, 0, 0, 0, 1)
    engine.block.appendChild(page, bottomRightHorizontalBlackBleedLine)
    const bottomRightVerticalBlackBleedLine = engine.block.duplicate(bottomRightHorizontalBlackBleedLine)
    engine.block.setWidth(bottomRightVerticalBlackBleedLine, 0.25)
    engine.block.setHeight(bottomRightVerticalBlackBleedLine, 5)
    engine.block.setPositionX(bottomRightVerticalBlackBleedLine, pageWidth)
    engine.block.setPositionY(bottomRightVerticalBlackBleedLine, pageHeight)
    const bottomRightHorizontalWhiteBleedLine = engine.block.duplicate(bottomRightHorizontalBlackBleedLine)
    engine.block.setWidth(bottomRightHorizontalWhiteBleedLine, 5)
    engine.block.setHeight(bottomRightHorizontalWhiteBleedLine, 0.25)
    engine.block.setPositionX(bottomRightHorizontalWhiteBleedLine, pageWidth)
    engine.block.setPositionY(bottomRightHorizontalWhiteBleedLine, pageHeight - 0.25)
    engine.block.setFillSolidColor(bottomRightHorizontalWhiteBleedLine, 1, 1, 1, 1)
    const bottomRightVerticalWhiteBleedLine = engine.block.duplicate(bottomRightHorizontalBlackBleedLine)
    engine.block.setWidth(bottomRightVerticalWhiteBleedLine, 0.25)
    engine.block.setHeight(bottomRightVerticalWhiteBleedLine, 5)
    engine.block.setPositionX(bottomRightVerticalWhiteBleedLine, pageWidth - 0.25)
    engine.block.setPositionY(bottomRightVerticalWhiteBleedLine, pageHeight)
    engine.block.setFillSolidColor(bottomRightVerticalWhiteBleedLine, 1, 1, 1, 1)

    // Top left
    const topLeftHorizontalBlackBleedLine = engine.block.duplicate(bottomRightHorizontalBlackBleedLine)
    engine.block.setWidth(topLeftHorizontalBlackBleedLine, 5)
    engine.block.setHeight(topLeftHorizontalBlackBleedLine, 0.25)
    engine.block.setPositionX(topLeftHorizontalBlackBleedLine, -5)
    engine.block.setPositionY(topLeftHorizontalBlackBleedLine, -0.25)
    const topLeftVerticalBlackBleedLine = engine.block.duplicate(bottomRightHorizontalBlackBleedLine)
    engine.block.setWidth(topLeftVerticalBlackBleedLine, 0.25)
    engine.block.setHeight(topLeftVerticalBlackBleedLine, 5)
    engine.block.setPositionX(topLeftVerticalBlackBleedLine, -0.25)
    engine.block.setPositionY(topLeftVerticalBlackBleedLine, -5)
    const topLeftHorizontalWhiteBleedLine = engine.block.duplicate(bottomRightHorizontalBlackBleedLine)
    engine.block.setWidth(topLeftHorizontalWhiteBleedLine, 5)
    engine.block.setHeight(topLeftHorizontalWhiteBleedLine, 0.25)
    engine.block.setPositionX(topLeftHorizontalWhiteBleedLine, -5)
    engine.block.setPositionY(topLeftHorizontalWhiteBleedLine, 0)
    engine.block.setFillSolidColor(topLeftHorizontalWhiteBleedLine, 1, 1, 1, 1)
    const topLeftVerticalWhiteBleedLine = engine.block.duplicate(bottomRightHorizontalBlackBleedLine)
    engine.block.setWidth(topLeftVerticalWhiteBleedLine, 0.25)
    engine.block.setHeight(topLeftVerticalWhiteBleedLine, 5)
    engine.block.setPositionX(topLeftVerticalWhiteBleedLine, 0)
    engine.block.setPositionY(topLeftVerticalWhiteBleedLine, -5)
    engine.block.setFillSolidColor(topLeftVerticalWhiteBleedLine, 1, 1, 1, 1)

    // Top right
    const topRightHorizontalBlackBleedLine = engine.block.duplicate(bottomRightHorizontalBlackBleedLine)
    engine.block.setWidth(topRightHorizontalBlackBleedLine, 5)
    engine.block.setHeight(topRightHorizontalBlackBleedLine, 0.25)
    engine.block.setPositionX(topRightHorizontalBlackBleedLine, pageWidth)
    engine.block.setPositionY(topRightHorizontalBlackBleedLine, -0.25)
    const topRightVerticalBlackBleedLine = engine.block.duplicate(bottomRightHorizontalBlackBleedLine)
    engine.block.setWidth(topRightVerticalBlackBleedLine, 0.25)
    engine.block.setHeight(topRightVerticalBlackBleedLine, 5)
    engine.block.setPositionX(topRightVerticalBlackBleedLine, pageWidth)
    engine.block.setPositionY(topRightVerticalBlackBleedLine, -5)
    const topRightHorizontalWhiteBleedLine = engine.block.duplicate(bottomRightHorizontalBlackBleedLine)
    engine.block.setWidth(topRightHorizontalWhiteBleedLine, 5)
    engine.block.setHeight(topRightHorizontalWhiteBleedLine, 0.25)
    engine.block.setPositionX(topRightHorizontalWhiteBleedLine, pageWidth)
    engine.block.setPositionY(topRightHorizontalWhiteBleedLine, 0)
    engine.block.setFillSolidColor(topRightHorizontalWhiteBleedLine, 1, 1, 1, 1)
    const topRightVerticalWhiteBleedLine = engine.block.duplicate(bottomRightHorizontalBlackBleedLine)
    engine.block.setWidth(topRightVerticalWhiteBleedLine, 0.25)
    engine.block.setHeight(topRightVerticalWhiteBleedLine, 5)
    engine.block.setPositionX(topRightVerticalWhiteBleedLine, pageWidth - 0.25)
    engine.block.setPositionY(topRightVerticalWhiteBleedLine, -5)
    engine.block.setFillSolidColor(topRightVerticalWhiteBleedLine, 1, 1, 1, 1)

    // Bottom left
    const bottomLeftHorizontalBlackBleedLine = engine.block.duplicate(bottomRightHorizontalBlackBleedLine)
    engine.block.setWidth(bottomLeftHorizontalBlackBleedLine, 5)
    engine.block.setHeight(bottomLeftHorizontalBlackBleedLine, 0.25)
    engine.block.setPositionX(bottomLeftHorizontalBlackBleedLine, -5)
    engine.block.setPositionY(bottomLeftHorizontalBlackBleedLine, pageHeight)
    const bottomLeftVerticalBlackBleedLine = engine.block.duplicate(bottomRightHorizontalBlackBleedLine)
    engine.block.setWidth(bottomLeftVerticalBlackBleedLine, 0.25)
    engine.block.setHeight(bottomLeftVerticalBlackBleedLine, 5)
    engine.block.setPositionX(bottomLeftVerticalBlackBleedLine, -0.25)
    engine.block.setPositionY(bottomLeftVerticalBlackBleedLine, pageHeight)
    const bottomLeftHorizontalWhiteBleedLine = engine.block.duplicate(bottomRightHorizontalBlackBleedLine)
    engine.block.setWidth(bottomLeftHorizontalWhiteBleedLine, 5)
    engine.block.setHeight(bottomLeftHorizontalWhiteBleedLine, 0.25)
    engine.block.setPositionX(bottomLeftHorizontalWhiteBleedLine, -5)
    engine.block.setPositionY(bottomLeftHorizontalWhiteBleedLine, pageHeight - 0.25)
    engine.block.setFillSolidColor(bottomLeftHorizontalWhiteBleedLine, 1, 1, 1, 1)
    const bottomLeftVerticalWhiteBleedLine = engine.block.duplicate(bottomRightHorizontalBlackBleedLine)
    engine.block.setWidth(bottomLeftVerticalWhiteBleedLine, 0.25)
    engine.block.setHeight(bottomLeftVerticalWhiteBleedLine, 5)
    engine.block.setPositionX(bottomLeftVerticalWhiteBleedLine, 0)
    engine.block.setPositionY(bottomLeftVerticalWhiteBleedLine, pageHeight)
    engine.block.setFillSolidColor(bottomLeftVerticalWhiteBleedLine, 1, 1, 1, 1)
  }
}

export function updateFirstName(engine: CreativeEngine, profile: Profile) {
  const firstName = profile.first_name.split(" ")[0];
  const formattedFirstName = firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase();
  engine.variable.setString("Fornavn", formattedFirstName);
}

export function updateLastName(engine: CreativeEngine, profile: Profile) {
  const nameParts = profile.last_name.split(" ");
  const lastName = nameParts[nameParts.length - 1];
  const formattedLastName = lastName.charAt(0).toUpperCase() + lastName.slice(1).toLowerCase();
  engine.variable.setString("Efternavn", formattedLastName);
}

export function updateEmail(engine: CreativeEngine, profile: Profile) {
  engine.variable.setString("Email", profile.email);
}

export function updateAddress(engine: CreativeEngine, profile: Profile) {
  const formattedAddress = profile.address.split(" ").map(word =>
    word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
  ).join(" ");
  engine.variable.setString("Adresse", formattedAddress);
}

export function updateCity(engine: CreativeEngine, profile: Profile) {
  const city = profile.city.charAt(0).toUpperCase() + profile.city.slice(1).toLowerCase();
  engine.variable.setString("By", city);
}

export function updateZipCode(engine: CreativeEngine, profile: Profile) {
  engine.variable.setString("Postnummer", profile.zip_code);
}

export function updateCountry(engine: CreativeEngine, profile: Profile) {
  const country = profile.country.charAt(0).toUpperCase() + profile.country.slice(1).toLowerCase();
  engine.variable.setString("Land", country);
}

export function updateCustomVariable(engine: CreativeEngine, profile: Profile) {
  if (profile.custom_variable) {
    engine.variable.setString("Custom", profile.custom_variable);
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
}

export function generateIdBlock(idText: number, engine: CreativeEngine, pageWidth: number, pageHeight: number, pages: number[] = [], profile?: Profile) {
  if (pages[1]) {
    // Add background to id text
    const idBackground = engine.block.create("graphic")
    engine.block.setShape(idBackground, engine.block.createShape("rect"))
    engine.block.setFill(idBackground, engine.block.createFill("color"))
    engine.block.setWidth(idBackground, 11)
    engine.block.setHeight(idBackground, 5)
    engine.block.setPositionX(idBackground, pageWidth - 11)
    engine.block.setPositionY(idBackground, pageHeight - 5)
    engine.block.setFillSolidColor(idBackground, 1, 1, 1, 1)
    engine.block.appendChild(pages[1], idBackground)

    // Add text to id text
    engine.block.setFloat(idText, "text/fontSize", 6.)
    engine.block.setWidthMode(idText, "Auto");
    engine.block.setHeightMode(idText, "Auto");
    engine.block.setTextColor(idText, {
      r: 0,
      g: 0,
      b: 0,
      a: 1
    });
    engine.block.setAlwaysOnTop(idBackground, true)
    engine.block.setAlwaysOnTop(idText, true)

    if (pages[1]) {
      if (profile) {
        engine.block.replaceText(idText, profile.id.slice(-5).toUpperCase());
      }
      engine.block.appendChild(idBackground, idText);
      engine.block.setWidth(idText, 11)
      engine.block.setHeight(idText, 5)
      engine.block.setEnum(idText, 'text/verticalAlignment', 'Center');
      engine.block.setEnum(idText, 'text/horizontalAlignment', 'Center')
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
    const response: any = await fetchKlaviyoSegments(integration.klaviyo_api_key);
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
  userId: string
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

        return id && first_name && last_name && address1 && city && zip && country && (country.toLowerCase() === "denmark" || country.toLowerCase() === "danmark" || country.toLowerCase() === "sweden" || country.toLowerCase() === "sverige" || country.toLowerCase() === "germany" || country.toLowerCase() === "tyskland");
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
  existingSegmentProfiles: Profile[]
) {
  const newSegmentProfiles = klaviyoSegmentProfiles.filter(
    (klaviyoSegmentProfile) =>
      !existingSegmentProfiles.some(
        (existingProfile) =>
          existingProfile.klaviyo_id === klaviyoSegmentProfile.id
      )
  );

  return newSegmentProfiles;
}

export async function returnProfilesInRobinson(profiles: ProfileToAdd[]) {
  const profilesMap = new Map();

  for (const profile of profiles) {
    const streetName = profile.address.split(' ')[0].toLowerCase();
    const firstNameParts = profile.first_name.toLowerCase().split(" ");
    const lastNameParts = profile.last_name.toLowerCase().split(" ");
    const zip = profile.zip_code;

    // Generate all combinations of first name and last name parts
    const firstNameCombinations = firstNameParts.reduce<string[]>((combinations, _, i) => [...combinations, ...firstNameParts.slice(i).map((_, j) => firstNameParts.slice(i, i + j + 1).join(' '))], []);
    const lastNameCombinations = lastNameParts.reduce<string[]>((combinations, _, i) => [...combinations, ...lastNameParts.slice(i).map((_, j) => lastNameParts.slice(i, i + j + 1).join(' '))], []);

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
    "https://rkjrflfwfqhhpwafimbe.supabase.co/storage/v1/object/public/robinson/robinson-modified.csv?t=2024-07-22T07%3A38%3A39.872Z"
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
        .toLowerCase()},${streetName.split(' ')[0].trim().toLowerCase()},${zip.trim()}`;
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

export function generateIdText(engine: CreativeEngine, profile: Profile, idText: number, pages: number[]) {
  if (pages[1]) {
    engine.block.replaceText(idText, profile.id.slice(-5).toUpperCase());
    engine.block.setEnum(idText, 'text/verticalAlignment', 'Center');
    engine.block.setEnum(idText, 'text/horizontalAlignment', 'Center');
  }
}

export async function generatePdf(profiles: Profile[], designBlob: string) {
  let profilesGenerated = 0;
  try {
    const mergedPdf = await PDFDocument.create();
    await CreativeEngine.init(config).then(async (engine) => {
      const scene = await engine.scene.loadFromURL(designBlob);
      const pages = engine.scene.getPages();
      const pageWidth = engine.block.getWidth(pages[0]);
      const pageHeight = engine.block.getHeight(pages[0]);
      const idText = engine.block.create("text");
      generateIdBlock(idText, engine, pageWidth, pageHeight, pages);
      generateBleedLines(engine, pages, pageWidth, pageHeight);
      for (const profile of profiles) {
        updateVariables(engine, profile);
        generateIdText(engine, profile, idText, pages);
        const pdfBlob = await engine.block.export(scene, MimeType.Pdf);
        const pdfBuffer = Buffer.from(await pdfBlob.arrayBuffer());
        const pdf = await PDFDocument.load(pdfBuffer);
        const copiedPages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
        copiedPages.forEach((page) => mergedPdf.addPage(page));
        logtail.info(`Generated pdf #${profilesGenerated + 1} out of ${profiles.length}`);
        profilesGenerated++;
      }
    });
    const pdfArray = await mergedPdf.save();
    const pdf = Buffer.from(pdfArray);
    return pdf;
  } catch (error: any) {
    throw new ErrorWithStatusCode(error.message, 500);
  }
}

export async function sendPdfToPrintPartner(pdf: Buffer, campaign_id: string, dateString: string) {
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
      `/files/til-distplus/${dateString}/kampagne-${campaign_id}.pdf`
    )

    await client.end();
  } catch (error: any) {
    throw new ErrorWithStatusCode(error.message, 500);
  }
}

export async function generateCsvAndSendToPrintPartner(profiles: Profile[], campaign_id: string, dateString: string) {
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

    let csvData = "fullname,address,zip_city,id\n"; // CSV headers
    profiles.forEach((profile) => {
      const firstName = capitalizeWords(profile.first_name);
      const lastName = capitalizeWords(profile.last_name);
      const address = capitalizeWords(profile.address);
      const city = capitalizeWords(profile.city);
      csvData += `"${firstName} ${lastName}","${address}","${profile.zip_code} ${city}","${profile.id.slice(-5)}"\n`;
    });
    // Convert the CSV data to a Buffer
    const csvBuffer = Buffer.from(csvData);

    // Upload the CSV data to the SFTP server
    await client.put(
      csvBuffer,
      `/files/til-distplus/${dateString}/kampagne-${campaign_id}.csv`
    );

    await client.end();
  } catch (error: any) {
    throw new ErrorWithStatusCode(error.message, 500);
  }
}

export function capitalizeWords(str: string) {
  return str.split(" ").map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()).join(" ");
}

export async function sendLettersForNonDemoUser(user_id: string, profiles: Profile[], designBlob: string, campaign_id: string) {
  // Try to bill the user for the letters sent
  try {
    await billUserForLettersSent(profiles.length, user_id);
  } catch (error: any) {
    throw new ErrorWithStatusCode(error.message, error.statusCode);
  }

  // Generate pdf
  let pdf;
  try {
    logtail.info(`Generating a pdf for user ${user_id} and campaign ${campaign_id}`);
    pdf = await generatePdf(profiles, designBlob);
    logtail.info(`Successfully generated a pdf for user ${user_id} and campaign ${campaign_id}`);
  } catch (error: any) {
    logtail.error(`An error occured while trying to generate a pdf for user ${user_id} and campaign ${campaign_id}`);
    throw new ErrorWithStatusCode(FailedToGeneratePdfError, 500);
  }

  // Send pdf to print partner with datestring e.g. 15-05-2024
  const date = new Date();
  const dateString = `${date.getDate()}-${date.getMonth() + 1}-${date.getFullYear()}`;

  try {
    logtail.info(`Sending a pdf to the print partner for user ${user_id} and campaign ${campaign_id}`);
    await sendPdfToPrintPartner(pdf, user_id, dateString);
    logtail.info(`Successfully sent a pdf to the print partner for user ${user_id} and campaign ${campaign_id}`);
  } catch (error: any) {
    logtail.error(`An error occured while trying to send a pdf to the print partner for user ${user_id} and campaign ${campaign_id}`);
    throw new ErrorWithStatusCode(FailedToSendPdfToPrintPartnerError, 500);
  }

  try {
    logtail.info(`Generating a csv and sending it to the print partner for user ${user_id} and campaign ${campaign_id}`);
    await generateCsvAndSendToPrintPartner(profiles, user_id, dateString);
    logtail.info(`Successfully generated a csv and sent it to the print partner for user ${user_id} and campaign ${campaign_id}`);
  } catch (error: any) {
    logtail.error(`An error occured while trying to generate a csv and send it to the print partner for user ${user_id} and campaign ${campaign_id}`);
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
    logtail.info(`Successfully updated profiles to sent for user ${user_id} and campaign ${campaign_id}`);
  } catch (error: any) {
    logtail.error(`An error occured while trying to update profiles to sent for user ${user_id} and campaign ${campaign_id}`);
    throw new ErrorWithStatusCode(FailedToUpdateProfilesToSentError, 500);
  }
}

export async function sendLettersForDemoUser(profiles: Profile[], campaign_id: string, user_id: string) {
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
    })
  } catch (error: any) {
    logtail.error(`An error occured while trying to update profiles to sent for user ${user_id} and campaign ${campaign_id}`);
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
    }
  })

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
  }

  logtail.info("Scheduled campaigns activated");
}

export async function updateKlaviyoProfiles() {
  logtail.info("Updating Klaviyo profiles");
  const users = await prisma.user.findMany({
    where: {
      integrations: {
        some: {
          type: 'klaviyo',
        },
      }
    }
  });

  try {
    for (const user of users) {
      const isValid = await validateKlaviyoApiKeyForUser(user);

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
            type: "klaviyo"
          }
        },
        include: {
          segment: true,
        },
      });

      // Loop through each campaign and get the new profiles from Klaviyo
      const profilesToAdd: ProfileToAdd[] = [];
      for (const campaign of campaigns) {
        const klaviyoSegmentProfiles = await getKlaviyoSegmentProfiles(
          campaign.segment.klaviyo_id,
          campaign.user_id
        );
        const existingSegmentProfiles = await prisma.profile.findMany({
          where: { segment_id: campaign.segment_id }
        });
        const newKlaviyoSegmentProfiles = returnNewKlaviyoSegmentProfiles(
          klaviyoSegmentProfiles,
          existingSegmentProfiles
        );
        const convertedKlaviyoSegmentProfiles = newKlaviyoSegmentProfiles.map(
          (klaviyoSegmentProfile) => ({
            id: klaviyoSegmentProfile.id,
            first_name: klaviyoSegmentProfile.attributes.first_name.toLowerCase(),
            last_name: klaviyoSegmentProfile.attributes.last_name.toLowerCase(),
            email: klaviyoSegmentProfile.attributes.email.toLowerCase(),
            address: klaviyoSegmentProfile.attributes.location.address1.toLowerCase(),
            city: klaviyoSegmentProfile.attributes.location.city.toLowerCase(),
            zip_code: klaviyoSegmentProfile.attributes.location.zip,
            country: klaviyoSegmentProfile.attributes.location.country.toLowerCase(),
            segment_id: campaign.segment_id,
            in_robinson: false,
            custom_variable: klaviyoSegmentProfile.attributes.properties.custom_variable || null,
            demo: campaign.segment.demo,
          })
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
              { zip_code: profile.zip_code, address: profile.address, first_name: profile.first_name, last_name: profile.last_name, segment_id: profile.segment_id }
            ]
          },
        });

        if (existingProfile) {
          profilesToAdd.splice(profilesToAdd.indexOf(profile), 1);
        }
      }

      // Check if profiles are in Robinson
      const profilesToAddInRobinson = await returnProfilesInRobinson(profilesToAdd);
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
        }
      })

      for (const campaign of campaigns) {
        const recentProfileIds = await getRecentProfileIds(user);
        const segment = await prisma.segment.findFirst({
          where: {
            campaign: {
              id: campaign.id,
            },
          },
          include: {
            profiles: {
              where: {
                letter_sent: false,
                in_robinson: false,
                id: {
                  notIn: recentProfileIds,
                },
              },
            },
          },
        });

        if (!segment || segment.profiles.length === 0 || !campaign.design || !campaign.design.scene) {
          continue;
        }

        // if there is a profile with id "additional-revenue-{campaign.id}", then remove it
        const updatedProfiles = segment.profiles.filter((profile) => profile.id !== `additional-revenue-${campaign.id}`);

        try {
          if (!segment.demo) {
            await sendLettersForNonDemoUser(campaign.user_id, updatedProfiles, campaign.design.scene, campaign.id)
          } else {
            await sendLettersForDemoUser(updatedProfiles, campaign.id, campaign.user_id)
          }
        } catch (error: any) {
          logtail.error(`An error occured while trying to periodically activate a campaign with id ${campaign.id}`);
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
  klaviyoApiKey: string
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
  let skippedProfiles: any[] = [];
  let missingFields: { [key: string]: number } = {};
  let nextUrl: string | null = url;

  while (nextUrl) {
    const response = await fetch(nextUrl, options);
    const data: any = await response.json();

    if (data.data) {
      data.data.forEach((profile: any) => {
        const { first_name, last_name, email, location } = profile.attributes;
        const { address1, city, zip, country } = location || {};

        if (
          first_name &&
          last_name &&
          email &&
          address1 &&
          city &&
          zip &&
          country &&
          ["denmark", "danmark", "sweden", "sverige", "germany", "tyskland"].includes(country.toLowerCase())
        ) {
          allProfiles.push(profile);
        } else {
          if (!first_name) missingFields['first_name'] = (missingFields['first_name'] || 0) + 1;
          if (!last_name) missingFields['last_name'] = (missingFields['last_name'] || 0) + 1;
          if (!address1) missingFields['address1'] = (missingFields['address1'] || 0) + 1;
          if (!city) missingFields['city'] = (missingFields['city'] || 0) + 1;
          if (!zip) missingFields['zip'] = (missingFields['zip'] || 0) + 1;
          if (!country) missingFields['country'] = (missingFields['country'] || 0) + 1;
          // Skip profiles where country is not Denmark, Danmark, Sweden, Sverige, Germany or Tyskland
          if (country && !["denmark", "danmark", "sweden", "sverige", "germany", "tyskland"].includes(country.toLowerCase())) {
            missingFields['country'] = (missingFields['country'] || 0) + 1;
          }
          skippedProfiles.push(profile);
        }
      });
    }

    nextUrl = data.links?.next || null;

    // Respect the rate limit
    await new Promise((resolve) => setTimeout(resolve, 1000 / 75));
  }

  let reason = '';
  for (const field in missingFields) {
    reason += `${field} (x${missingFields[field]}), `;
  }
  reason = reason.slice(0, -2); // remove trailing comma and space

  return { validProfiles: allProfiles, skippedProfiles, reason };
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
    value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value
  );
}

export function validateCountry(country: string): boolean {
  return country.toLowerCase() === "denmark" || country.toLowerCase() === "danmark" || country.toLowerCase() === "sweden" || country.toLowerCase() === "sverige" || country.toLowerCase() === "germany" || country.toLowerCase() === "tyskland";
}

export async function checkIfProfileIsInRobinson(profile: ProfileToAdd) {
  const streetName = profile.address
    .match(/\D+/g)?.[0]
    .trim()
    .toLowerCase();
  const firstName = profile.first_name.toLowerCase();
  const lastName = profile.last_name.toLowerCase();
  const zip = profile.zip_code;
  const uniqueIdentifier = `${firstName},${lastName},${streetName},${zip}`;

  const response = await fetch(
    "https://ypvaugzxzbcnyeun.public.blob.vercel-storage.com/robinson-cleaned-modified-jAzirx8qMWVzJ1DPEEIqct82TSyuVU.csv"
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

async function getRecentProfileIds(user: User): Promise<string[]> {
  const bufferDaysAsNumber = Number(user.buffer_days || 10n);
  const daysAgo = subDays(new Date(), bufferDaysAsNumber);
  const BATCH_SIZE = 10000;
  let recentProfileIds: string[] = [];
  let skip = 0;
  let hasMore = true;

  const userSegments = await prisma.segment.findMany({
    where: {
      user_id: user.id,
    },
    select: {
      id: true,
    },
  });

  while (hasMore) {
    const recentProfiles = await prisma.profile.findMany({
      where: {
        letter_sent: true,
        letter_sent_at: {
          gte: daysAgo,
        },
        segment_id: {
          in: userSegments.map((segment) => segment.id),
        },
      },
      select: {
        id: true,
      },
      take: BATCH_SIZE,
      skip: skip,
    });

    if (recentProfiles.length < BATCH_SIZE) {
      hasMore = false;
    }

    recentProfileIds = recentProfileIds.concat(recentProfiles.map(profile => profile.id));
    skip += BATCH_SIZE;
  }

  return recentProfileIds;
}