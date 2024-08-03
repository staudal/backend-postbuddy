import { Router } from "express";
import { logtail, prisma } from "../app";
import {
  fetchBulkOperationData,
  getBulkOperationUrl,
  processOrdersForCampaigns,
  saveOrders,
} from "../functions";

const router = Router();

export default router;
