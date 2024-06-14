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
import cors from "cors";
import { PrismaClient } from "@prisma/client";
import cron from "node-cron";
import authenticateToken from "./routes/middleware";
import indexRouter from "./routes/index";
import shopifyRouter from "./routes/shopify";
import authRouter from "./routes/auth";
import userRouter from "./routes/user";
import segmentRouter from "./routes/segments";
import campaignRouter from "./routes/campaigns";
import designRouter from "./routes/designs";
import integrationRouter from "./routes/integrations";
import blobRouter from "./routes/blob";

import { triggerShopifyBulkQueries } from "./functions";

const app = express();
export const prisma = new PrismaClient();

app.use(cors());
app.use(express.json());

// Trigger Shopify bulk queries every day at midnight
cron.schedule('0 0 * * *', triggerShopifyBulkQueries);

// Setup routes
app.use('/', indexRouter);
app.use('/', authRouter);
app.use('/', shopifyRouter, authenticateToken);
app.use('/', userRouter, authenticateToken);
app.use('/', segmentRouter, authenticateToken);
app.use('/', campaignRouter, authenticateToken);
app.use('/', designRouter, authenticateToken);
app.use('/', integrationRouter, authenticateToken);
app.use('/', blobRouter, authenticateToken);

Sentry.setupExpressErrorHandler(app);

app.listen(3000, () => {
  console.log("🚀 Server ready at: http://localhost:3000");
});