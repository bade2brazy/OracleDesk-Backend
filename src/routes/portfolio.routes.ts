import { Router } from 'express';
import { getPlatformStats, getPortfolio, getPositions } from '../controllers/portfolio.controller';
import { cachePolicy, validator } from '../middlewares/cache.middleware';
import { prisma } from '../lib/prisma';

const router = Router();

// Public (agent portfolio is public for demo)
router.get(
  '/',
  cachePolicy({ kind: 'shared', maxAge: 15, swr: 60 }),
  getPortfolio,
);

router.get(
  '/positions',
  cachePolicy({ kind: 'shared', maxAge: 15, swr: 60 }),
  validator(async (req) => {
    const status = req.query.status as any;
    const where = { ...(status ? { status } : {}) };
    const [agg, count] = await Promise.all([
      prisma.position.aggregate({ where, _max: { updatedAt: true } }),
      prisma.position.count({ where }),
    ]);
    const maxUpdated = agg._max.updatedAt?.toISOString() ?? '0';
    const page = req.query.page ?? '1';
    const limit = req.query.limit ?? '20';
    return `positions:${maxUpdated}:${count}:${page}:${limit}`;
  }),
  getPositions,
);

router.get(
  '/stats',
  cachePolicy({ kind: 'shared', maxAge: 15, swr: 60 }),
  validator(async () => {
    const [marketAgg, posAgg, tradeCount] = await Promise.all([
      prisma.market.aggregate({ _max: { updatedAt: true }, _count: true }),
      prisma.position.aggregate({ _max: { updatedAt: true }, _count: true }),
      prisma.trade.count(),
    ]);
    const maxM = marketAgg._max.updatedAt?.toISOString() ?? '0';
    const maxP = posAgg._max.updatedAt?.toISOString() ?? '0';
    return `stats:${maxM}:${maxP}:${marketAgg._count}:${posAgg._count}:${tradeCount}`;
  }),
  getPlatformStats,
);

export default router;
