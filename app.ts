import "dotenv/config";

import express from "express";
import cors from "cors";
import { PrismaClient } from "@prisma/client";
import cron from "node-cron";
import { authenticateToken, adminOnly } from "./routes/middleware";
import indexRouter from "./routes/index";
import shopifyRouter from "./routes/shopify";
import authRouter from "./routes/auth";
import usersRouter from "./routes/users";
import userRouter from "./routes/user";
import segmentRouter from "./routes/segments";
import campaignRouter from "./routes/campaigns";
import designRouter from "./routes/designs";
import integrationRouter from "./routes/integrations";
import blobRouter from "./routes/blob";
import settingsRouter from "./routes/settings";
import webhooksRouter from "./routes/webhooks";
import subscriptionRouter from "./routes/subscriptions";
import analyticsRouter from "./routes/analytics";
import profilesRouter from "./routes/profiles";
import adminRoute from "./routes/admin";
import { errorHandler } from "./errorhandler";

import { activateScheduledCampaigns, triggerShopifyBulkQueries, updateKlaviyoProfiles } from "./functions";
import { API_URL } from "./constants";
import path from "path";

import { Logtail } from "@logtail/node";
export const logtail = new Logtail("QrngmT7yBCxZSM4zsqSn4jgX");

const app = express();
export const prisma = new PrismaClient();

app.use(cors());
app.use(express.json());

// Serve the cesdk directory statically
app.use('/cesdk', express.static(path.join(__dirname, 'cesdk')));

// Trigger Shopify bulk queries every day at midnight
cron.schedule('0 0 * * *', triggerShopifyBulkQueries);
cron.schedule('0 0 * * *', updateKlaviyoProfiles);
cron.schedule('0 0 * * *', activateScheduledCampaigns);

// Setup routes
app.use('/', indexRouter);
app.use('/auth', authRouter);
app.use('/webhooks', webhooksRouter);
app.use('/shopify', shopifyRouter);


// Fully protected routes
app.use('/designs', authenticateToken, designRouter);
app.use('/users', authenticateToken, usersRouter);
app.use('/user', authenticateToken, userRouter);
app.use('/segments', authenticateToken, segmentRouter);
app.use('/campaigns', authenticateToken, campaignRouter);
app.use('/profiles', authenticateToken, profilesRouter);
app.use('/analytics', authenticateToken, analyticsRouter);
app.use('/subscriptions', authenticateToken, subscriptionRouter);
app.use('/settings', authenticateToken, settingsRouter);
app.use('/blob', authenticateToken, blobRouter);

// Partially protected routes
app.use('/integrations', integrationRouter);

// Admin routes
app.use('/admin', authenticateToken, adminOnly, adminRoute);

app.use(errorHandler)

const port = process.env.PORT || 8000
app.listen(port, () => {
  logtail.info(`🚀 Server ready at: ${API_URL}`)
})