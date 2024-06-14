import "dotenv/config";
import * as Sentry from "@sentry/node";
import { nodeProfilingIntegration } from "@sentry/profiling-node";

Sentry.init({
  dsn: "https://65d3e283420a03a763042d0b2d669bdc@o4507426520760320.ingest.de.sentry.io/4507426522398800",
  integrations: [nodeProfilingIntegration()],
  tracesSampleRate: 1.0,
  profilesSampleRate: 1.0,
});

import express from "express";
import { PrismaClient } from "@prisma/client";
import cron from "node-cron";
import indexRouter from "./routes/index";
import shopifyRouter from "./routes/shopify";

import { triggerShopifyBulkQueries } from "./functions";

const app = express();
export const prisma = new PrismaClient();

// Use JSON parser middleware
app.use(express.json());

// Trigger Shopify bulk queries every day at midnight
cron.schedule('0 0 * * *', triggerShopifyBulkQueries);

// Setup routes
app.use('/', indexRouter);
app.use('/', shopifyRouter);

Sentry.setupExpressErrorHandler(app);

app.listen(3000, () => {
  console.log("🚀 Server ready at: http://localhost:3000");
});
