// errorHandler.js
import { logtail } from './app'

export const errorHandler = (err: any, req: any, res: any, next: any) => {
  // Log the error
  logtail.error(`Error in [${req.method}] ${req.url}`, err);

  // Send a 500 response for unhandled errors
  return res.status(500).json({ error: 'InternalServerError' });
};