import { Router } from 'express';
import { z } from 'zod';

import { route, isoDate, isoMonth } from '../lib/validate';
import { requireRole } from '../lib/auth';
import { getStockSummary } from '../reports/stock-summary';
import { getReservationAging } from '../reports/reservation-aging';
import { stockAsOf, diffSnapshots } from '../reports/as-of-snapshot';
import { monthlyRollforward, closeMonth } from '../reports/rollforward';
import { rollforwardWorkbook } from '../reports/export-xlsx';
import { viewFreshness } from '../jobs/refresh-views';
import { cached } from '../lib/cache';

export const reportsRouter = Router();

reportsRouter.get(
  '/stock-summary',
  route({}, () => cached('stock-summary', 30_000, getStockSummary)),
);

reportsRouter.get(
  '/reservation-aging',
  route({ query: z.object({ asOf: isoDate.optional() }) }, ({ query }) =>
    getReservationAging(query.asOf ? new Date(`${query.asOf}T23:59:59Z`) : new Date()),
  ),
);

reportsRouter.get(
  '/as-of',
  route(
    { query: z.object({ date: isoDate, knownAt: isoDate.optional(), category: z.string().max(100).optional() }) },
    ({ query }) =>
      stockAsOf(new Date(`${query.date}T23:59:59.999Z`), {
        knownAt: query.knownAt ? new Date(`${query.knownAt}T23:59:59.999Z`) : undefined,
        category: query.category,
      }),
  ),
);

reportsRouter.get(
  '/as-of/diff',
  route({ query: z.object({ from: isoDate, to: isoDate }) }, ({ query }) =>
    diffSnapshots(new Date(`${query.from}T23:59:59.999Z`), new Date(`${query.to}T23:59:59.999Z`)),
  ),
);

reportsRouter.get(
  '/rollforward/:month',
  route({ params: z.object({ month: isoMonth }) }, ({ params }) => monthlyRollforward(params.month)),
);

reportsRouter.get(
  '/rollforward/:month.xlsx',
  route({ params: z.object({ month: isoMonth }) }, async ({ params }, _req, res) => {
    const [rows, stock] = await Promise.all([monthlyRollforward(params.month), getStockSummary()]);
    const buf = rollforwardWorkbook(params.month, rows, stock);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="rollforward-${params.month}.xlsx"`);
    res.send(buf);
  }),
);

reportsRouter.post(
  '/rollforward/:month/close',
  requireRole('accountant'),
  route({ params: z.object({ month: isoMonth }) }, ({ params }) => closeMonth(params.month)),
);

reportsRouter.get('/freshness', route({}, () => viewFreshness()));
