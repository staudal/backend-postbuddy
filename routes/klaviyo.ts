import { Router } from "express";
import { authenticateToken } from "./middleware";

const router = Router();

router.post("/segments", authenticateToken, async (req, res) => {
  const { api_key } = req.body;
  const options = {
    method: "GET",
    headers: {
      accept: "application/json",
      revision: "2024-02-15",
      Authorization: `Klaviyo-API-Key ${api_key}`,
    },
  };

  const response = await fetch("https://a.klaviyo.com/api/segments", options);
  const { data } = await response.json();

  res.json(data);
});

export default router;