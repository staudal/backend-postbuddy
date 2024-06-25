import { Router } from 'express';
import { prisma } from '../app';
import { InternalServerError, MissingRequiredParametersError } from '../errors';

const router = Router();

router.put('/', async (req, res) => {
  const { user_id, firstName, lastName, company, address, zip, city, country, bufferDays } = req.body;
  if (!user_id) return MissingRequiredParametersError;

  await prisma.user.update({
    where: { id: user_id },
    data: {
      first_name: firstName,
      last_name: lastName,
      company,
      address,
      zip_code: zip,
      city,
      country,
      bufferDays,
    },
  });

  return res.status(200).json({ success: "Brugeroplysningerne er blevet opdateret" });
})

export default router;