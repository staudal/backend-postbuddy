import { Router } from "express";
import { logtail, prisma } from "../app";
import {
  CampaignNotFoundError,
  DesignNotFoundError,
  FailedToBillUserError,
  FailedToCreateCampaignError,
  FailedToGeneratePdfError,
  FailedToSendPdfToPrintPartnerError,
  InsufficientRightsError,
  InternalServerError,
  MissingAddressError,
  MissingRequiredParametersError,
  MissingSubscriptionError,
  ProfilesNotFoundError,
  SegmentNotFoundError,
  UserNotFoundError,
} from "../errors";
import {
  billUserForLettersSent,
  generateCsvAndSendToPrintPartner,
  generatePdf,
  periodicallySendLetters,
  sendPdfToPrintPartner,
} from "../functions";
import { Campaign } from "@prisma/client";
import { pricePerLetter, testProfile } from "../constants";
import { authenticateToken } from "./middleware";

const router = Router();

router.get("/", authenticateToken, async (req, res) => {
  const user_id = req.body.user_id;
  if (!user_id)
    return res.status(400).json({ error: MissingRequiredParametersError });

  try {
    const dbUser = await prisma.user.findUnique({
      where: { id: user_id },
    });

    if (!dbUser) {
      return res.status(404).json({ error: UserNotFoundError });
    }

    // Fetch campaigns including necessary aggregation data
    const campaigns = await prisma.campaign.findMany({
      where: { user_id: dbUser.id, demo: dbUser.demo },
      include: {
        segment: {
          include: {
            profiles: {
              select: {
                letter_sent: true,
                letter_sent_at: true,
                orders: {
                  select: {
                    order: {
                      select: {
                        amount: true,
                        created_at: true,
                      },
                    },
                  },
                },
              },
              where: {
                letter_sent: true,
                letter_sent_at: {
                  not: null,
                },
              },
            },
          },
        },
      },
      orderBy: {
        created_at: "desc",
      },
    });

    // Process the data on the backend
    const campaignData = campaigns.map((campaign) => {
      const lettersSentCount = campaign.segment.profiles.filter(
        (profile) => profile.letter_sent,
      ).length;
      const campaignRevenue = campaign.segment.profiles.reduce(
        (acc, profile) => {
          const profileRevenue = profile.orders.reduce((acc, orderProfile) => {
            if (profile.letter_sent_at) {
              const orderDate = new Date(orderProfile.order.created_at);
              const letterSentDate = new Date(profile.letter_sent_at);

              // Only include orders where the order date is after the letter sent date
              if (orderDate > letterSentDate) {
                return acc + (orderProfile.order.amount || 0);
              }
            }
            return acc;
          }, 0);

          return acc + profileRevenue;
        },
        0,
      );

      const adSpend = lettersSentCount * pricePerLetter;
      const roas = campaignRevenue / adSpend;

      return {
        ...campaign,
        roas,
        letters_sent: lettersSentCount,
        campaign_revenue: campaignRevenue,
      };
    });

    return res.json(campaignData);
  } catch (error: any) {
    logtail.error(error + "GET /campaigns");
    return res.status(500).json({ InternalServerError });
  }
});

router.get("/:id", authenticateToken, async (req, res) => {
  const user_id = req.body.user_id;
  const id = req.params.id;

  const user = await prisma.user.findUnique({
    where: { id: user_id },
  });

  if (!user) return res.status(404).json({ error: UserNotFoundError });

  if (user.role !== "admin") {
    if (!user_id || !id)
      return res.status(400).json({ error: MissingRequiredParametersError });
  }

  const campaign = await prisma.campaign.findUnique({
    where: { id: id },
    select: {
      id: true,
      name: true,
      start_date: true,
      status: true,
      type: true,
      segment: {
        select: {
          id: true,
          name: true,
          profiles: {
            select: {
              letter_sent: true,
              letter_sent_at: true,
              orders: {
                select: {
                  order: {
                    select: {
                      amount: true,
                      created_at: true,
                    },
                  },
                },
              },
            },
            where: {
              letter_sent: true,
            },
          },
        },
      },
      design: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  });

  if (!campaign) return res.status(404).json({ error: CampaignNotFoundError });

  let letters_sent = 0;
  let campaign_revenue = 0;
  let totalDaysToFirstPurchase = 0;
  let conversions = 0;
  let profilesWithPurchase = 0;

  for (const profile of campaign.segment.profiles) {
    if (profile.letter_sent) letters_sent++;
    const orders = profile.orders.filter(
      (order) =>
        profile.letter_sent_at !== null &&
        order.order.created_at > profile.letter_sent_at &&
        order.order.amount > 0,
    );
    if (orders.length > 0) {
      profilesWithPurchase++;
      conversions++;
      if (profile.letter_sent_at) {
        totalDaysToFirstPurchase +=
          (new Date(orders[0].order.created_at).getTime() -
            new Date(profile.letter_sent_at).getTime()) /
          (1000 * 3600 * 24);
      } else {
        totalDaysToFirstPurchase += 0;
      }
      campaign_revenue += orders.reduce(
        (acc, order) => acc + order.order.amount,
        0,
      );
    }
  }

  // Calculate the ad spend for the campaign
  const ad_spend = letters_sent ? letters_sent * pricePerLetter : 0;

  // Calculate the return on ad spend for the campaign
  const roas = ad_spend ? campaign_revenue / ad_spend : 0;

  const avg_days_to_first_purchase = profilesWithPurchase
    ? totalDaysToFirstPurchase / profilesWithPurchase
    : 0;

  const updatedCampaign = {
    id: campaign.id,
    name: campaign.name,
    start_date: campaign.start_date,
    design: campaign.design,
    status: campaign.status,
    type: campaign.type,
    segment: {
      id: campaign.segment.id,
      name: campaign.segment.name,
    },
    campaign_revenue,
    ad_spend,
    roas,
    letters_sent,
    conversions,
    avg_days_to_first_purchase,
    profile_count: letters_sent,
  };

  return res.json(updatedCampaign);
});

// USED FOR CAMPAIGN DETAILS PAGE (to fetch all profiles in a campaign)
router.get("/:id/profiles", authenticateToken, async (req, res) => {
  const user_id = req.body.user_id;
  const page = req.query.page ? parseInt(req.query.page as string) : 1;
  const limit = req.query.limit ? parseInt(req.query.limit as string) : 10;
  const offset = (page - 1) * limit;
  const sort = req.query.sort
    ? (req.query.sort as any).split(":")
    : ["created_at", "desc"];

  const user = await prisma.user.findUnique({
    where: { id: user_id },
  });

  if (!user) return res.status(404).json({ error: UserNotFoundError });

  const campaignId = req.params.id;

  // Fetch all profiles for sorting
  const allProfiles = await prisma.profile.findMany({
    where: {
      segment: {
        campaign: {
          id: campaignId,
        },
      },
    },
    include: {
      orders: {
        select: {
          order: {
            select: {
              amount: true,
              created_at: true,
            },
          },
        },
      },
    },
  });

  // Process profiles to add necessary fields
  const processedProfiles = allProfiles.map((profile: any) => {
    const full_name = `${profile.first_name} ${profile.last_name}`;

    const revenue = (profile.orders || [])
      .filter(
        (order: any) =>
          profile.letter_sent_at !== null &&
          order.order.created_at > profile.letter_sent_at &&
          order.order.amount > 0,
      )
      .reduce((acc: number, order: any) => acc + order.order.amount, 0);

    return {
      ...profile,
      full_name,
      revenue,
    };
  });

  // Sort the profiles
  const sortedProfiles = processedProfiles.sort((a, b) => {
    if (sort[1] === "asc") {
      return a[sort[0]] > b[sort[0]] ? 1 : -1;
    } else {
      return a[sort[0]] < b[sort[0]] ? 1 : -1;
    }
  });

  // Paginate the sorted profiles
  const paginatedProfiles = sortedProfiles.slice(offset, offset + limit);

  return res.status(200).json(paginatedProfiles);
});

router.post("/", authenticateToken, async (req, res) => {
  try {
    const {
      user_id,
      name,
      type,
      segment_id,
      design_id,
      discountCodes,
      start_date,
    } = req.body;
    if (
      !name ||
      !user_id ||
      !type ||
      !segment_id ||
      !design_id ||
      !discountCodes
    )
      return res.status(400).json({ error: MissingRequiredParametersError });

    // Verify that segment exists
    const segment = await prisma.segment.findUnique({
      where: { id: segment_id, user_id },
    });
    if (!segment) return res.status(404).json({ error: SegmentNotFoundError });

    // Verify that design exists
    const design = await prisma.design.findUnique({
      where: { id: design_id },
    });
    if (!design || !design.scene)
      return res.status(404).json({ error: DesignNotFoundError });

    // Verify that user has an active subscription
    const user = await prisma.user.findUnique({
      where: { id: user_id },
      include: {
        subscription: true,
      },
    });

    if (user?.subscription?.status !== "active") {
      return res.status(400).json({ error: MissingSubscriptionError });
    }

    const startDate = start_date
      ? new Date(start_date)
      : new Date().toISOString();
    let campaign: Campaign | null;
    campaign = await prisma.campaign.create({
      data: {
        name,
        type,
        status: "scheduled",
        segment_id,
        created_at: new Date(),
        user_id,
        design_id,
        discount_codes: discountCodes || [],
        start_date: startDate,
        demo: segment.demo,
      },
    });

    return res.status(201).json({
      success: "Kampagnen er blevet oprettet og afventer afsendelse",
      campaign,
    });
  } catch (error: any) {
    logtail.error(error + "POST /campaigns");
    return res.status(500).json({ error: FailedToCreateCampaignError });
  }
});

router.put("/:id", authenticateToken, async (req, res) => {
  try {
    const { user_id, status, design_id } = req.body;
    const id = req.params.id;
    if (!user_id)
      return res.status(400).json({ error: MissingRequiredParametersError });

    const campaign = await prisma.campaign.findUnique({
      where: { id: id },
    });
    if (!campaign) return CampaignNotFoundError;

    if (campaign.user_id !== user_id) return InsufficientRightsError;

    await prisma.campaign.update({
      where: { id: id },
      data: {
        status: status || campaign.status,
        design_id: design_id || campaign.design_id,
      },
    });

    return res.status(200).json({ success: "Kampagnen er blevet opdateret" });
  } catch (error: any) {
    logtail.error(error + "PUT /campaigns");
    return res.status(500).json({ error: InternalServerError });
  }
});

router.delete("/:id", authenticateToken, async (req, res) => {
  try {
    const { user_id } = req.body;
    const id = req.params.id;
    if (!user_id || !id)
      return res.status(400).json({ error: MissingRequiredParametersError });

    const campaign = await prisma.campaign.findUnique({
      where: { id: id },
    });
    if (!campaign) return CampaignNotFoundError;

    if (campaign.user_id !== user_id) return InsufficientRightsError;

    await prisma.campaign.delete({
      where: { id: id },
    });

    return res.status(200).json({ success: "Kampagnen er blevet slettet" });
  } catch (error: any) {
    logtail.error(error + "DELETE /campaigns");
    return res.status(500).json({ error: InternalServerError });
  }
});

router.get("/force-send-letters", authenticateToken, async (req, res) => {
  await periodicallySendLetters();
});

router.post("/test-letter", authenticateToken, async (req, res) => {
  try {
    const { user_id, design_id } = req.body;
    if (!user_id || !design_id)
      return res.status(400).json({ error: MissingRequiredParametersError });

    const user = await prisma.user.findUnique({
      where: { id: user_id },
    });
    if (!user) return UserNotFoundError;

    const design = await prisma.design.findUnique({
      where: { id: design_id },
    });
    if (!design || !design.scene) return DesignNotFoundError;

    if (!user.address || !user.zip_code || !user.city) MissingAddressError;

    // Try to bill the user for the letters sent
    try {
      await billUserForLettersSent(1, user_id);
    } catch (error: any) {
      return res.status(500).json({ error: FailedToBillUserError });
    }

    // Generate pdf
    let pdf;
    try {
      pdf = await generatePdf([testProfile], design.scene);
    } catch (error: any) {
      logtail.error(
        `An error occured while trying to generate a pdf for a test letter for user ${user_id}`,
      );
      return res.status(500).json({ error: FailedToGeneratePdfError });
    }

    // Send pdf to print partner with datestring e.g. 15-05-2024
    const date = new Date();
    const dateString = `${date.getDate()}-${date.getMonth() + 1}-${date.getFullYear()}`;

    try {
      await sendPdfToPrintPartner(pdf, user_id, dateString);
    } catch (error: any) {
      logtail.error(
        `An error occured while trying to send a test letter pdf to the print partner for user ${user_id}`,
      );
      return res
        .status(500)
        .json({ error: FailedToSendPdfToPrintPartnerError });
    }

    try {
      await generateCsvAndSendToPrintPartner(
        [testProfile],
        user_id,
        dateString,
      );
    } catch (error: any) {
      logtail.error(
        `An error occured while trying to generate a test letter csv and send it to the print partner for user ${user_id}`,
      );
      return res
        .status(500)
        .json({ error: FailedToSendPdfToPrintPartnerError });
    }

    return res
      .status(201)
      .json({ success: "Testbrevet er blevet sendt til produktion" });
  } catch (error: any) {
    logtail.error(error + "POST /campaigns/test-letter");
    return res.status(500).json({ error: InternalServerError });
  }
});

export default router;
