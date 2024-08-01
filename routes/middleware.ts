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
      return res.status(403).json({ error: 'Forbidden: Invalid or expired token' });
    }

    req.body.user_id = user.id; // Attach the user ID to the request body
    next(); // Proceed to the next middleware or route handler
  } catch (error) {
    console.error('Error in authenticateToken middleware', error);
    return res.status(403).json({ error: 'Forbidden: Invalid token' });
  }
};

export { authenticateToken };
