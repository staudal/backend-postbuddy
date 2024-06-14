import { PrismaClient, Profile } from '@prisma/client'
import { Order } from './types'
import { Order as PrismaOrder } from '@prisma/client'
import Stripe from 'stripe';
import { MissingSubscriptionError } from './errors';
import CreativeEngine, { MimeType } from '@cesdk/node';
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
  } catch (error: any) {
    console.error(`Error loading user with id ${userId}: ${error}`);
    throw new Error(`Der opstod en fejl under indlæsning af bruger med id ${userId}: ${error.message}`);
  }
};

export const getBulkOperationUrl = async (shop: string, token: string, apiId: string) => {
  try {
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
  } catch (error: any) {
    console.error(`Error fetching bulk operation URL: ${error}`);
    throw new Error(`Der opstod en fejl under hentning af bulk operation URL: ${error.message}`);
  }
};

export const fetchBulkOperationData = async (url: string) => {
  try {
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
        } catch (error: any) {
          console.error(`Failed to parse order: ${error.message}`);
        }
      }
    }

    return orders;
  } catch (error: any) {
    console.error(`Error fetching bulk operation data: ${error}`);
    throw new Error(`Der opstod en fejl under hentning af bulk operation data: ${error.message}`);
  }
};

export const saveOrders = async (userId: string, shopifyOrders: Order[]) => {
  try {
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
  } catch (error: any) {
    console.error(`Error saving orders for user ${userId}: ${error}`);
    throw new Error(`Der opstod en fejl ved gemme ordre for bruger ${userId}: ${error.message}`);
  }
};

export const processOrdersForCampaigns = async (user: any, allOrders: PrismaOrder[]) => {
  try {
    const campaigns = user.campaigns;
    const profilePromises = allOrders.map(allOrder => findAndUpdateProfile(allOrder, campaigns));
    return await Promise.all(profilePromises);
  } catch (error: any) {
    console.error(`Error processing orders for campaigns: ${error}`);
    throw new Error(`Der opstod en fejl under behandling af ordre for kampagner: ${error.message}`);
  }
};

export const findAndUpdateProfile = async (allOrder: PrismaOrder, campaigns: any[]) => {
  for (const campaign of campaigns) {
    try {
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
          for (const profile of profiles) {
            const existingDbOrder = await prisma.orderProfile.findFirst({
              where: {
                order_id: allOrder.id,
                profile_id: profile.id,
              },
            });

            if (existingDbOrder) {
              continue;
            }

            try {
              await prisma.orderProfile.create({
                data: {
                  order_id: allOrder.id,
                  profile_id: profile.id,
                },
              });
            } catch (error: any) {
              console.error(`Error creating orderProfile for order ${allOrder.id} and profile ${profile.id}: ${error.message}`);
            }
          }
        }
      }
    } catch (error: any) {
      console.error(`Error finding and updating profile for order ${allOrder.id}: ${error}`);
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

export const formatOrderData = (newShopifyOrder: Order, userId: string) => {
  try {
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
  } catch (error: any) {
    console.error(`Error formatting order data: ${error}`);
    throw new Error(`Error formatting order data: ${error.message}`);
  }
};


export const getAddressComponents = (addressFull: string) => {
  try {
    const addressMatch = addressFull.match(/^(\D*\d+)/) || [];
    return addressMatch[0] || addressFull;
  } catch (error: any) {
    console.error(`Error getting address components: ${error}`);
    throw new Error(`Error getting address components: ${error.message}`);
  }
};


export async function triggerShopifyBulkQueries() {
  try {
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

    const userPromises = users.map(async (user) => {
      try {
        const shopifyIntegration = user.integrations.find(
          (integration) => integration.type === 'shopify'
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

        const response = await fetch(shopifyApiUrl, {
          method: 'POST',
          headers: shopifyApiHeaders,
          body: JSON.stringify({ query: shopifyBulkOperationQuery }),
        });

        const data: any = await response.json();

        if (!response.ok) {
          console.error(`Failed to create bulk query for user ${user.id}: ${data.errors}`);
        } else {
          console.log(
            `Created bulk query for user ${user.id}: ${data.data.bulkOperationRunQuery.bulkOperation.id}`
          );
        }
      } catch (error: any) {
        console.error(`Error creating bulk query for user ${user.id}: ${error}`);
        throw new Error(`Error creating bulk query for user ${user.id}: ${error.message}`);
      }
    });

    await Promise.allSettled(userPromises);
  } catch (error: any) {
    console.error(`Error triggering Shopify bulk queries: ${error}`);
    throw new Error(`Error triggering Shopify bulk queries: ${error.message}`);
  }
}

export async function billUserForLettersSent(profilesLength: number, user_id: string) {
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  if (!STRIPE_SECRET_KEY) {
    throw new Error('Missing Stripe secret key');
  }

  const stripe = new Stripe(STRIPE_SECRET_KEY)
  const subscription = await prisma.subscription.findFirst({
    where: { user_id },
  });
  if (!subscription) {
    throw new Error(MissingSubscriptionError);
  }

  const usageRecord = await stripe.subscriptionItems.createUsageRecord(subscription.subscription_item_id, {
    quantity: profilesLength,
    timestamp: Math.floor(Date.now() / 1000),
    action: 'increment',
  });

  if (!usageRecord) {
    throw new Error('Failed to bill user for letters sent');
  }
}

export async function generateTestDesign(blob: string, format: string): Promise<Buffer> {
  const config = {
    license: process.env.IMGLY_LICENSE,
    baseURL: "https://app.postbuddy.dk/node/assets",
  }

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
  engine.variable.setString("Fornavn", firstName);
}

export function updateLastName(engine: CreativeEngine, profile: Profile) {
  const nameParts = profile.last_name.split(" ");
  const lastName = nameParts[nameParts.length - 1];
  engine.variable.setString("Efternavn", lastName);
}

export function updateEmail(engine: CreativeEngine, profile: Profile) {
  engine.variable.setString("Email", profile.email);
}

export function updateAddress(engine: CreativeEngine, profile: Profile) {
  engine.variable.setString("Adresse", profile.address);
}

export function updateCity(engine: CreativeEngine, profile: Profile) {
  engine.variable.setString("By", profile.city);
}

export function updateZipCode(engine: CreativeEngine, profile: Profile) {
  engine.variable.setString("Postnummer", profile.zip_code);
}

export function updateCountry(engine: CreativeEngine, profile: Profile) {
  engine.variable.setString("Land", profile.country);
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