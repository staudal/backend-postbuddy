import jwt from 'jsonwebtoken';
import { prisma } from '../app';

const JWT_SECRET = process.env.JWT_SECRET || 'your_jwt_secret';

const authenticateToken = async (req: any, res: any, next: any) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Unauthorized: No token provided' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as jwt.JwtPayload;

    // Optional: You can add more validation logic here, e.g., checking if the user exists in the database
    const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
    if (!user) {
      return res.status(403).json({ error: 'User not found' });
    }

    req.body.user_id = user.id; // Attach the user ID to the request body
    next(); // Proceed to the next middleware or route handler
  } catch (error) {
    console.error('Token verification error:', error);
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
};

export default authenticateToken;