import { Router } from 'express';
import { prisma } from '../app';
import { InternalServerError, MissingRequiredParametersError } from '../errors';

const router = Router();

router.post('/', async (req, res) => {
  const { user_id, firstName, lastName, company, address, zip, city, country } = req.body;
  if (!user_id || !firstName || !lastName || !company || !address || !zip || !city || !country) return res.status(400).json({ error: MissingRequiredParametersError });

  try {
    await prisma.user.update({
      where: { id: user_id },
      data: {
        first_name: firstName,
        last_name: lastName,
        company,
        address,
        zip_code: zip,
        city,
        country
      }
    })

    return res.status(200).json({ success: "Brugeroplysningerne er blevet opdateret" });
  } catch (error: any) {
    console.error(error);
    return res.status(500).json({ error: InternalServerError });
  }
})

export default router;