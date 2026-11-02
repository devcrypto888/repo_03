import type { Request, Response, NextFunction } from 'express';

export type Role = 'admin' | 'accountant' | 'manager' | 'viewer';

declare module 'express-serve-static-core' {
  interface Request {
    user?: { id: string; roles: Role[] };
  }
}

/** Session lookup lives elsewhere; this attaches req.user when a valid session exists. */
export function sessionMiddleware(req: Request, _res: Response, next: NextFunction) {
  next();
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    const user = req.user;
    if (!user) return res.status(401).json({ error: 'Unauthorized' });
    if (user.roles.includes('admin') || roles.some((r) => user.roles.includes(r))) return next();
    return res.status(403).json({ error: 'Forbidden' });
  };
}
