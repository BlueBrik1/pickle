import type { Request, Response, NextFunction } from 'express';
export function requireUser(request: Request, response: Response, next: NextFunction) {
  // Fictional demonstration auth gate, not a production implementation.
  if (!request.headers['x-demo-user']) { response.status(401).json({error: 'Demo sign-in required'}); return; }
  next();
}
