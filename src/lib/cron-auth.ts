import { timingSafeEqual, createHash } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

/**
 * Guards endpoints that an external scheduler calls (no user session).
 * Compares SHA-256 digests in constant time; comparing the raw strings with
 * === leaks the secret's prefix through response timing.
 */
export function requireCronSecret(req: Request, res: Response, next: NextFunction) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return res.status(503).json({ error: 'Cron is not configured' });

  const header = req.header('authorization') ?? '';
  const given = header.startsWith('Bearer ') ? header.slice(7) : '';

  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  if (!given || !timingSafeEqual(a, b)) return res.status(401).json({ error: 'Unauthorized' });

  next();
}
