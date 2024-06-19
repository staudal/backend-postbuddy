import { Router } from 'express';
import { prisma } from '../app';
import { InternalServerError, MissingRequiredParametersError, MissingSubscriptionError, UserNotFoundError } from '../errors';
import Stripe from 'stripe';
import { WEB_URL } from '../constants';

const router = Router();

router.get('/new', async (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: MissingRequiredParametersError });

  const user = await prisma.user.findUnique({
    where: { id: user_id },
  });
  if (!user) return res.status(404).json({ error: UserNotFoundError });

  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

  if (STRIPE_SECRET_KEY == null) {
    return res.status(500).json({ error: InternalServerError });
  }

  const stripe = new Stripe(STRIPE_SECRET_KEY);

  const session = await stripe.checkout.sessions.create({
    client_reference_id: user.id,
    success_url: WEB_URL + '/dashboard/account',
    cancel_url: WEB_URL + '/dashboard/account',
    line_items: [
      {
        // Usage pricing
        price:
          process.env.NODE_ENV === "production"
            ? "price_1PRJ8tHpzjX3OijIdjXrFLpL"
            : "price_1PRJAOHpzjX3OijIVEQgCCBy",
      },
      {
        // Monthly subscription
        price:
          process.env.NODE_ENV === "production"
            ? "price_1PRJ9FHpzjX3OijI6YTk7syK"
            : "price_1PRJABHpzjX3OijISTQv2EjE",
        quantity: 1,
      }
    ],
    mode: "subscription",
  });

  return res.status(200).json({ url: session.url });
})

router.get('/portal', async (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: MissingRequiredParametersError });

  const subscription = await prisma.subscription.findFirst({
    where: { user_id },
  });
  if (!subscription) return res.status(404).json({ error: MissingSubscriptionError });

  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  if (!STRIPE_SECRET_KEY) {
    throw new Error("Stripe secret key not found");
  }

  const stripe = new Stripe(STRIPE_SECRET_KEY);

  if (!subscription.customer_id) {
    throw new Error("Customer ID not found");
  }
  const session = await stripe.billingPortal.sessions.create({
    customer: subscription.customer_id,
    return_url: WEB_URL + `/dashboard/account`,
  });

  return res.status(200).json({ url: session.url });
})

router.get('/status', async (req, res) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: MissingRequiredParametersError });

  const subscription = await prisma.subscription.findFirst({
    where: { user_id },
  });

  const subscriptionStatus = subscription?.status == "active";

  if (subscriptionStatus) {
    return res.status(200).json(true);
  } else {
    return res.status(200).json(false);
  }
})

export default router;