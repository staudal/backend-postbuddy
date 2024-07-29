import { Router } from "express";
import { prisma } from "../app";
import {
  InsufficientRightsError,
  MissingRequiredParametersError,
  UserAlreadyExistsError,
  UserNotFoundError,
} from "../errors";
import argon2 from "argon2";
import { authenticateToken } from "./middleware";

const router = Router();

router.get("/users", authenticateToken, async (req, res) => {
  const { user_id } = req.body;
  const page = req.query.page ? parseInt(req.query.page as string) : 1;
  const limit = req.query.limit ? parseInt(req.query.limit as string) : 10;
  const offset = (page - 1) * limit;
  const sort = req.query.sort
    ? (req.query.sort as any).split(":")
    : ["created_at", "desc"];

  // Validate that user is admin
  const user = await prisma.user.findUnique({
    where: { id: user_id },
  });

  if (!user) return UserNotFoundError;

  if (user.role !== "admin") {
    return res.status(403).json({ error: InsufficientRightsError });
  }

  const users = (await prisma.user.findMany({
    skip: offset,
    take: limit,
    distinct: ["id"], // Ensure uniqueness of profiles
    orderBy: {
      [sort[0]]: sort[1],
    },
  })) as any;

  // Add total count of users to the response
  const total = await prisma.user.count();

  return res.status(200).json({ users, total });
});

router.get("/users/:id", authenticateToken, async (req, res) => {
  const { user_id } = req.body;
  const id = req.params.id;

  // Validate that user is admin
  const user = await prisma.user.findUnique({
    where: { id: user_id },
  });

  if (!user) return UserNotFoundError;

  if (user.role !== "admin") {
    return res.status(403).json({ error: InsufficientRightsError });
  }

  const foundUser = await prisma.user.findUnique({
    where: { id },
  });

  if (!foundUser) return UserNotFoundError;

  return res.status(200).json(foundUser);
});

router.post("/users", async (req, res) => {
  const {
    user_id,
    first_name,
    last_name,
    company,
    email,
    password,
    role,
    demo,
  } = req.body;
  if (!user_id) return MissingRequiredParametersError;

  const user = await prisma.user.findUnique({
    where: { id: user_id },
  });
  if (!user) return UserNotFoundError;

  // Check that user has the correct role
  if (user.role !== "admin") {
    return res.status(403).json({ error: InsufficientRightsError });
  }

  // Check if the created user already exists if email is provided
  if (email) {
    const existingUser = await prisma.user.findUnique({
      where: { email },
    });
    if (existingUser) {
      return res.status(400).json({ error: UserAlreadyExistsError });
    }
  }

  const hashedPassword = await argon2.hash(password);

  // Create the new user
  await prisma.user.create({
    data: {
      first_name,
      last_name,
      company,
      email,
      password: hashedPassword,
      role,
      demo,
    },
  });

  return res.status(201).json({ success: "Bruger oprettet" });
});

router.put(`/users/:id`, async (req, res) => {
  const { user_id, first_name, last_name, company, email, role, demo } =
    req.body;
  const id = req.params.id;
  if (!user_id || !id) return MissingRequiredParametersError;

  // Check if user is an admin
  const user = await prisma.user.findUnique({
    where: { id: user_id },
  });
  if (!user) return UserNotFoundError;

  if (user.role !== "admin") {
    return res.status(403).json({ error: InsufficientRightsError });
  }

  // check if email already exists if it's provided
  if (email) {
    const existingUser = await prisma.user.findUnique({
      where: { email },
    });
    if (existingUser && existingUser.id !== id) {
      return res.status(400).json({ error: UserAlreadyExistsError });
    }
  }

  await prisma.user.update({
    where: {
      id,
    },
    data: {
      first_name,
      last_name,
      email,
      company,
      role,
      demo,
    },
  });

  return res.status(200).json({ success: "Bruger opdateret" });
});

router.get("/campaigns", authenticateToken, async (req, res) => {
  const { user_id } = req.body;
  const id = req.query.id as string;
  const page = req.query.page ? parseInt(req.query.page as string) : 1;
  const limit = req.query.limit ? parseInt(req.query.limit as string) : 10;
  const offset = (page - 1) * limit;
  const sort = req.query.sort
    ? (req.query.sort as any).split(":")
    : ["created_at", "desc"];

  // Validate that user is admin
  const user = await prisma.user.findUnique({
    where: { id: user_id },
  });

  if (!user) return UserNotFoundError;

  if (user.role !== "admin") {
    return res.status(403).json({ error: InsufficientRightsError });
  }

  const campaigns = (await prisma.campaign.findMany({
    where: {
      user_id: id,
    },
    skip: offset,
    take: limit,
    distinct: ["id"], // Ensure uniqueness of profiles
    orderBy: {
      [sort[0]]: sort[1],
    },
  })) as any;

  // Add total count of users to the response
  const total = await prisma.campaign.count({
    where: {
      user_id: id,
    },
  });

  return res.status(200).json({ campaigns, total });
});

router.get("/segments", authenticateToken, async (req, res) => {
  const { user_id } = req.body;
  const id = req.query.id as string;
  const page = req.query.page ? parseInt(req.query.page as string) : 1;
  const limit = req.query.limit ? parseInt(req.query.limit as string) : 10;
  const offset = (page - 1) * limit;
  const sort = req.query.sort
    ? (req.query.sort as any).split(":")
    : ["created_at", "desc"];

  // Validate that user is admin
  const user = await prisma.user.findUnique({
    where: { id: user_id },
  });

  if (!user) return UserNotFoundError;

  if (user.role !== "admin") {
    return res.status(403).json({ error: InsufficientRightsError });
  }

  const segments = (await prisma.segment.findMany({
    where: {
      user_id: id,
    },
    skip: offset,
    take: limit,
    distinct: ["id"], // Ensure uniqueness of profiles
    orderBy: {
      [sort[0]]: sort[1],
    },
  })) as any;

  // Add total count of users to the response
  const total = await prisma.segment.count({
    where: {
      user_id: id,
    },
  });

  // Add profile_count and in_robinson_count to each segment
  for (let i = 0; i < segments.length; i++) {
    const profile_count = await prisma.profile.count({
      where: {
        segment_id: segments[i].id,
      },
    });
    segments[i].profile_count = profile_count;

    const in_robinson_count = await prisma.profile.count({
      where: {
        segment_id: segments[i].id,
        in_robinson: true,
      },
    });
    segments[i].in_robinson_count = in_robinson_count;
  }

  return res.status(200).json({ segments, total });
});

router.get("/designs", authenticateToken, async (req, res) => {
  const { user_id } = req.body;
  const id = req.query.id as string;
  const page = req.query.page ? parseInt(req.query.page as string) : 1;
  const limit = req.query.limit ? parseInt(req.query.limit as string) : 10;
  const offset = (page - 1) * limit;
  const sort = req.query.sort
    ? (req.query.sort as any).split(":")
    : ["created_at", "desc"];

  // Validate that user is admin
  const user = await prisma.user.findUnique({
    where: { id: user_id },
  });

  if (!user) return UserNotFoundError;

  if (user.role !== "admin") {
    return res.status(403).json({ error: InsufficientRightsError });
  }

  const designs = (await prisma.design.findMany({
    where: {
      user_id: id,
    },
    skip: offset,
    take: limit,
    distinct: ["id"], // Ensure uniqueness of profiles
    orderBy: {
      [sort[0]]: sort[1],
    },
  })) as any;

  // Add total count of users to the response
  const total = await prisma.design.count({
    where: {
      user_id: id,
    },
  });

  return res.status(200).json({ designs, total });
});

router.get("/integrations", authenticateToken, async (req, res) => {
  const { user_id } = req.body;
  const id = req.query.id as string;
  const page = req.query.page ? parseInt(req.query.page as string) : 1;
  const limit = req.query.limit ? parseInt(req.query.limit as string) : 10;
  const offset = (page - 1) * limit;
  const sort = req.query.sort
    ? (req.query.sort as any).split(":")
    : ["created_at", "desc"];

  // Validate that user is admin
  const user = await prisma.user.findUnique({
    where: { id: user_id },
  });

  if (!user) return UserNotFoundError;

  if (user.role !== "admin") {
    return res.status(403).json({ error: InsufficientRightsError });
  }

  const integrations = (await prisma.integration.findMany({
    where: {
      user_id: id,
    },
    skip: offset,
    take: limit,
    distinct: ["id"], // Ensure uniqueness of profiles
    orderBy: {
      [sort[0]]: sort[1],
    },
  })) as any;

  // Add total count of users to the response
  const total = await prisma.integration.count({
    where: {
      user_id: id,
    },
  });

  return res.status(200).json({ integrations, total });
});

router.get("/subscriptions", authenticateToken, async (req, res) => {
  const { user_id } = req.body;
  const id = req.query.id as string;
  const page = req.query.page ? parseInt(req.query.page as string) : 1;
  const limit = req.query.limit ? parseInt(req.query.limit as string) : 10;
  const offset = (page - 1) * limit;
  const sort = req.query.sort
    ? (req.query.sort as any).split(":")
    : ["created_at", "desc"];

  // Validate that user is admin
  const user = await prisma.user.findUnique({
    where: { id: user_id },
  });

  if (!user) return UserNotFoundError;

  if (user.role !== "admin") {
    return res.status(403).json({ error: InsufficientRightsError });
  }

  const subscriptions = (await prisma.subscription.findMany({
    where: {
      user_id: id,
    },
    skip: offset,
    take: limit,
    distinct: ["id"], // Ensure uniqueness of profiles
    orderBy: {
      [sort[0]]: sort[1],
    },
  })) as any;

  // Add total count of users to the response
  const total = await prisma.subscription.count({
    where: {
      user_id: id,
    },
  });

  return res.status(200).json({ subscriptions, total });
});

export default router;
