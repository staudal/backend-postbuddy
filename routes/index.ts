import { Router } from 'express';

const router = Router();

router.get('/', async (req, res) => {
  return res.status(200).json({ message: "Hello Worlds!" });
});

export default router;
