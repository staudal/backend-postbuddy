import { Router } from "express";
import { logtail, prisma } from "../app";
import {
  IntegrationNotFoundError,
  InternalServerError,
  MissingRequiredParametersError,
  UserNotFoundError,
} from "../errors";
import { authenticateToken } from "./middleware";
import { API_URL, supabase, WEB_URL } from "../constants";

const router = Router();

router.get("/klaviyo", authenticateToken, async (req, res) => {
  const { data, error } = await supabase
    .from("integrations")
    .select("*")
    .eq("user_id", req.body.user_id)
    .eq("type", "klaviyo");

  if (error) {
    console.error(error);
    return res.status(500).json({ error: InternalServerError });
  }

  if (data.length === 0) {
    return res.status(204);
  } else {
    return res.json(data[0]);
  }
});

router.get("/", authenticateToken, async (req, res) => {
  const user_id = req.body.user_id;
  const integrationType = req.body.integrationType;
  if (!user_id)
    return res.status(400).json({ error: MissingRequiredParametersError });

  const user = await prisma.user.findUnique({
    where: { id: user_id },
  });
  if (!user) return res.status(404).json({ error: UserNotFoundError });

  if (integrationType) {
    const integration = await prisma.integration.findFirst({
      where: { type: integrationType },
    });

    return res.json(integration);
  }

  const integrations = await prisma.integration.findMany({
    where: { user_id: user.id },
  });

  res.json(integrations);
});

router.get("/shopify/disconnect", authenticateToken, async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id)
      return res.status(400).json({ error: MissingRequiredParametersError });

    const user = await prisma.user.findUnique({
      where: { id: user_id },
    });
    if (!user) {
      return res.status(404).json({ error: UserNotFoundError });
    }

    const integration = await prisma.integration.findFirst({
      where: {
        user_id: user.id,
        type: "shopify",
      },
    });

    if (!integration || !integration.token) {
      return res.status(404).json({ error: IntegrationNotFoundError });
    }

    const revokeUrl = `https://${integration?.shop}.myshopify.com/admin/api_permissions/current.json`;
    const options = {
      method: "DELETE",
      headers: {
        "X-Shopify-Access-Token": integration.token,
      },
    };

    await fetch(revokeUrl, options);

    await prisma.integration.deleteMany({
      where: {
        user_id: user.id,
        type: "shopify",
      },
    });

    // Delete all orderProfiles associated with the user's orders
    await prisma.orderProfile.deleteMany({
      where: {
        order: {
          user_id: user.id,
        },
      },
    });

    // Delete all orders
    await prisma.order.deleteMany({
      where: {
        user_id: user.id,
      },
    });

    return res
      .status(200)
      .json({ success: "Shopify-integrationen blev slettet" });
  } catch (error) {
    logtail.error(error + "GET /shopify/disconnect");
    return res.status(500).json({ error: InternalServerError });
  }
});

router.post("/klaviyo/connect", authenticateToken, async (req, res) => {
  try {
    const { user_id, api_key } = req.body;
    if (!user_id || !api_key)
      return res.status(400).json({ error: MissingRequiredParametersError });

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
      return res.status(400).json({
        error:
          "Ugyldig API key. Er du sikker på, den har read-access til segmenter?",
      });
    }

    const klaviyoResponseTwo = await fetch(
      "https://a.klaviyo.com/api/profiles/",
      {
        method: "GET",
        headers: {
          accept: "application/json",
          revision: "2024-02-15",
          Authorization: `Klaviyo-API-Key ${api_key}`,
        },
      },
    );

    const klaviyoDataTwo: any = await klaviyoResponseTwo.json();
    if (!klaviyoDataTwo.data) {
      return res.status(400).json({
        error:
          "Ugyldig API key. Er du sikker på, den har read-access til profiler?",
      });
    }

    // Check that user doesn't already have a Klaviyo integration
    const existingIntegration = await prisma.integration.findFirst({
      where: {
        user_id: user_id,
        type: "klaviyo",
      },
    });

    if (existingIntegration) {
      return res
        .status(400)
        .json({ error: "Du har allerede integreret med Klaviyo" });
    }

    const klaviyoIntegration = await prisma.integration.create({
      data: {
        type: "klaviyo",
        klaviyo_api_key: api_key,
        user_id,
      },
    });

    return res.status(200).json(klaviyoIntegration);
  } catch (error: any) {
    logtail.error(error + "POST /klaviyo/connect");
    return res.status(500).json({ error: InternalServerError });
  }
});

router.get("/klaviyo/disconnect", authenticateToken, async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id)
      return res.status(400).json({ error: MissingRequiredParametersError });

    const user = await prisma.user.findUnique({
      where: { id: user_id },
    });
    if (!user) return res.status(404).json({ error: UserNotFoundError });

    await prisma.integration.deleteMany({
      where: {
        user_id: user.id,
        type: "klaviyo",
      },
    });

    return res
      .status(200)
      .json({ success: "Klaviyo-integrationen blev slettet" });
  } catch (error: any) {
    logtail.error(error + "GET /klaviyo/disconnect");
    return res.status(500).json({ error: InternalServerError });
  }
});

router.post("/woocommerce/connect", authenticateToken, async (req, res) => {
  try {
    const { user_id, shop_url } = req.body;
    if (!user_id || !shop_url) {
      return res.status(400).json({ error: MissingRequiredParametersError });
    }

    const user = await prisma.user.findUnique({
      where: { id: user_id },
    });
    if (!user) {
      return res.status(404).json({ error: UserNotFoundError });
    }

    const integration = await prisma.integration.findFirst({
      where: {
        user_id: user.id,
        type: "woocommerce",
      },
    });

    if (integration) {
      return res
        .status(400)
        .json({ error: "Du har allerede integreret med WooCommerce" });
    }

    // Ensure shop_url starts with http:// or https://
    if (!/^https?:\/\//i.test(shop_url)) {
      return res.status(400).json({ error: "Ugyldig URL - mangler http:// eller https://" });
    }

    const store_url = new URL(shop_url);
    if (!store_url.hostname) {
      return res.status(400).json({ error: "Ugyldig URL - mangler domæne" });
    }

    const endpoint = "/wc-auth/v1/authorize";
    const params = {
      app_name: "Postbuddy",
      scope: "read",
      user_id: user_id,
      return_url: `${WEB_URL}/integrations`,
      callback_url: `https://rkjrflfwfqhhpwafimbe.supabase.co/functions/v1/woocommerce-callback`,
    }

    const url = new URL(store_url.origin);
    url.pathname = endpoint;
    url.search = new URLSearchParams(params).toString();

    return res.status(200).json({ url: url.toString() });
  } catch (error: any) {
    console.error(error);
    logtail.error(error + "POST /woocommerce/connect");
    return res.status(500).json({ error: InternalServerError });
  }
});

router.post("/woocommerce/disconnect", authenticateToken, async (req, res) => {
  try {
    const { user_id } = req.body;
    if (!user_id)
      return res.status(400).json({ error: MissingRequiredParametersError });

    const user = await prisma.user.findUnique({
      where: { id: user_id },
    });
    if (!user) return res.status(404).json({ error: UserNotFoundError });

    await prisma.integration.deleteMany({
      where: {
        user_id: user.id,
        type: "woocommerce",
      },
    });

    // Delete all orderProfiles associated with the user's orders
    await prisma.orderProfile.deleteMany({
      where: {
        order: {
          user_id: user.id,
        },
      },
    });

    // Delete all orders
    await prisma.order.deleteMany({
      where: {
        user_id: user.id,
      },
    });

    return res
      .status(200)
      .json({ success: "WooCommerce-integrationen blev slettet" });
  } catch (error: any) {
    logtail.error(error + "POST /woocommerce/disconnect");
    return res.status(500).json({ error: InternalServerError });
  }
});

export default router;
