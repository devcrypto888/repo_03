import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { z, type ZodTypeAny } from 'zod';

/**
 * Express route helper: validates query/body/params with zod and passes typed
 * values to the handler. Async errors are forwarded to the error middleware
 * (Express 4 doesn't do that on its own).
 */
export function route<Q extends ZodTypeAny = z.ZodAny, B extends ZodTypeAny = z.ZodAny, P extends ZodTypeAny = z.ZodAny>(
  schemas: { query?: Q; body?: B; params?: P },
  handler: (input: { query: z.infer<Q>; body: z.infer<B>; params: z.infer<P> }, req: Request, res: Response) => Promise<unknown> | unknown,
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const parse = <S extends ZodTypeAny>(s: S | undefined, v: unknown) => (s ? s.safeParse(v) : { success: true as const, data: v });
      const q = parse(schemas.query, req.query);
      const b = parse(schemas.body, req.body);
      const p = parse(schemas.params, req.params);
      const failed = [q, b, p].find((r) => !r.success) as z.SafeParseError<unknown> | undefined;
      if (failed) {
        return res.status(400).json({ error: 'Invalid request', issues: failed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
      }
      const out = await handler({ query: q.data as z.infer<Q>, body: b.data as z.infer<B>, params: p.data as z.infer<P> }, req, res);
      if (out !== undefined && !res.headersSent) res.json(out);
    } catch (err) {
      next(err);
    }
  };
}

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
export const isoMonth = z.string().regex(/^\d{4}-\d{2}$/, 'Expected YYYY-MM');
