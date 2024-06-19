import { logtail } from './app'
const NODE_ENV = process.env.NODE_ENV || 'development';

export const errorHandler = (err: any, req: any, res: any, next: any) => {
  // Log the error
  if (NODE_ENV === 'production') {
    logtail.error(`Error in [${req.method}] ${req.url}`, err);
  } else {
    console.error(err);
  }

  // Send a 500 response for unhandled errors
  return res.status(500).json({ error: 'InternalServerError' });
};