import { Router } from 'express';
import { prisma } from '../app';
import { MissingRequiredParametersError } from '../errors';

const router = Router();

router.put('/', async (req, res) => {
  const { user_id, first_name, last_name, company, address, zip_code, city, country, buffer_days } = req.body;
  if (!user_id) return MissingRequiredParametersError;

  const newUser = await prisma.user.update({
    where: { id: user_id },
    data: {
      first_name,
      last_name,
      company,
      address,
      zip_code,
      city,
      country,
      buffer_days,
    },
  });

  return res.status(200).json(newUser);
})

export default router;