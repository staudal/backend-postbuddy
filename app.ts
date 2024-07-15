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
import settingsRouter from "./routes/settings";
import webhooksRouter from "./routes/webhooks";
import subscriptionRouter from "./routes/subscriptions";
import analyticsRouter from "./routes/analytics";
import profilesRouter from "./routes/profiles";
import adminRoute from "./routes/admin";
import { errorHandler } from "./errorhandler";
import pm2, { ProcessDescription } from 'pm2';
import { activateScheduledCampaigns, periodicallySendLetters, triggerShopifyBulkQueries, updateKlaviyoProfiles } from "./functions";
import path from "path";
import { Logtail } from "@logtail/node";

export const logtail = new Logtail("QrngmT7yBCxZSM4zsqSn4jgX");

const app = express();
export const prisma = new PrismaClient();

app.use(cors());
app.use(express.json({ limit: "50mb" }));

// Serve the cesdk directory statically
app.use('/cesdk', express.static(path.join(__dirname, 'cesdk')));

// Function to setup cron jobs
const setupCronJobs = () => {
  cron.schedule('0 0 * * *', triggerShopifyBulkQueries); // every day at 00:00
  cron.schedule('0 1 * * *', updateKlaviyoProfiles); // every day at 01:00
  cron.schedule('0 * * * *', activateScheduledCampaigns); // once per hour
  cron.schedule('0 * * * *', periodicallySendLetters); // once per hour
};

if (process.env.NODE_ENV === "production") {
  // Connect to PM2 and determine the leader only in production
  pm2.connect((err) => {
    if (err) {
      console.error(err);
      process.exit(2);
    }

    pm2.list((err, list) => {
      if (err) {
        console.error(err);
        process.exit(2);
      }

      const hasValidPmId = (process: ProcessDescription): process is ProcessDescription & { pm_id: number } => {
        return process.pm_id !== undefined;
      };

      const validProcesses = list.filter(hasValidPmId);

      if (validProcesses.length === 0) {
        console.error('No valid processes found');
        process.exit(2);
      }

      const leaderProcess = validProcesses.reduce<ProcessDescription & { pm_id: number }>((leader, process) => {
        return process.pm_id < leader.pm_id ? process : leader;
      }, validProcesses[0]);

      const currentPmId = parseInt(process.env.pm_id!, 10);
      if (leaderProcess.pm_id === currentPmId) {
        console.log(`This instance is the leader: ${currentPmId}`);
        setupCronJobs(); // Schedule the cron jobs only on the leader
      } else {
        console.log(`This instance is not the leader: ${currentPmId}`);
      }

      pm2.disconnect();
    });
  });
}

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

// Partially protected routes
app.use('/integrations', integrationRouter);

// Admin routes
app.use('/admin', authenticateToken, adminOnly, adminRoute);

app.use(errorHandler)

const port = process.env.PORT || 8000;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
