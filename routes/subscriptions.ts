import { Router, Request, Response } from 'express';
import { prisma } from '../app';
import { InternalServerError, MissingRequiredParametersError, MissingSubscriptionError, UserNotFoundError } from '../errors';
import Stripe from 'stripe';

const router = Router();

router.get('/new', async (req: Request, res: Response) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: MissingRequiredParametersError });

  const user = await prisma.user.findUnique({
    where: { id: user_id },
  });
  if (!user) return res.status(404).json({ error: UserNotFoundError });

  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

  if (STRIPE_SECRET_KEY == null) {
    return new Response("Stripe secret key not found", {
      status: 500,
    });
  }

  const stripe = new Stripe(STRIPE_SECRET_KEY);

  try {
    const session = await stripe.checkout.sessions.create({
      client_reference_id: user.id,
      success_url: 'http://localhost:3001/dashboard/account',
      cancel_url: 'http://localhost:3001/dashboard/account',
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
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: InternalServerError });
  }
})

router.get('/portal', async (req: Request, res: Response) => {
  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: MissingRequiredParametersError });

  const subscription = await prisma.subscription.findFirst({
    where: { user_id },
  });
  if (!subscription) return res.status(404).json({ error: MissingSubscriptionError });

  try {
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
      return_url: `http://localhost:3001/dashboard/account`,
    });

    return res.status(200).json({ url: session.url });
  } catch (error: any) {
    console.error(error);
    return res.status(500).json({ error: InternalServerError });
  }
})

router.get('/status', async (req: Request, res: Response) => {
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