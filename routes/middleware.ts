import { prisma } from '../app';
import { supabase } from '../constants';

const authenticateToken = async (req: any, res: any, next: any) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized: No token provided' });
  }

  try {
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) {
      return res.status(403).json({ error: 'Forbidden: Invalid token' });
    }

    // Optional: Check if the user exists in your database
    const dbUser = await prisma.user.findUnique({ where: { id: user.id } });
    if (!dbUser) {
      return res.status(403).json({ error: 'User not found' });
    }

    req.body.user_id = dbUser.id; // Attach the user ID to the request body
    next(); // Proceed to the next middleware or route handler
  } catch (error) {
    return res.status(403).json({ error: 'Forbidden: Invalid token' });
  }
};

export { authenticateToken };