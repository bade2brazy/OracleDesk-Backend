import { Router } from 'express';
import {
  listMarkets,
  getMarket,
  getMarketByOnChainId,
  getOnChainMarketState,
  triggerMarketGeneration,
  getMarketGenerationStatus,
  buildMarketsWhere,
} from '../controllers/market.controller';
import { requireAuth, requirePermission } from '../middlewares/auth.middleware';
import { generateLimiter } from '../middlewares/rate-limit.middleware';
import { idempotent } from '../middlewares/idempotency.middleware';
import { cachePolicy, validator, noStore } from '../middlewares/cache.middleware';
import { listMarketsSchema } from '../validators/market.validator';
import { prisma } from '../lib/prisma';
import { parseU64 } from '../lib/amounts';

const router = Router();

const marketDetailPolicy = cachePolicy(async (req) => {
  const id = req.params.id;
  const onChainRaw = req.params.onChainMarketId;
  const onChainMarketId = onChainRaw !== undefined ? parseU64(String(onChainRaw)) : null;
  const where = id ? { id } : (onChainMarketId !== null ? { onChainMarketId } : null);
  if (!where) return { kind: 'shared', maxAge: 5, swr: 30 };
  const market = await prisma.market.findUnique({ where: where as any, select: { status: true } });
  if (market && (market.status === 'RESOLVED' || market.status === 'CANCELLED')) {
    return { kind: 'immutable', maxAge: 86400 };
  }
  return { kind: 'shared', maxAge: 5, swr: 30 };
});

const marketDetailValidator = validator(async (req) => {
  const id = req.params.id;
  const onChainRaw = req.params.onChainMarketId;
  const onChainMarketId = onChainRaw !== undefined ? parseU64(String(onChainRaw)) : null;
  const where = id ? { id } : (onChainMarketId !== null ? { onChainMarketId } : null);
  if (!where) return null;
  const market = await prisma.market.findUnique({
    where: where as any,
    select: {
      id: true,
      updatedAt: true,
      status: true,
      _count: { select: { trades: true, positions: true, reasoningTraces: true } },
      reasoningTraces: { orderBy: { createdAt: 'desc' }, take: 1, select: { updatedAt: true } },
    },
  });
  if (!market) return null;
  const traceUpdated = market.reasoningTraces[0]?.updatedAt?.toISOString() ?? '0';
  const counts = `${market._count.trades}:${market._count.positions}:${market._count.reasoningTraces}`;
  return `market:${market.id}:${market.status}:${market.updatedAt.toISOString()}:${traceUpdated}:${counts}`;
});

// Public — no auth needed
router.get(
  '/',
  cachePolicy({ kind: 'shared', maxAge: 5, swr: 30 }),
  validator(async (req) => {
    const parsed = listMarketsSchema.safeParse({ query: req.query });
    if (!parsed.success) return null;
    const where = buildMarketsWhere(parsed.data.query);
    const [agg, count] = await Promise.all([
      prisma.market.aggregate({ where, _max: { updatedAt: true } }),
      prisma.market.count({ where }),
    ]);
    const maxUpdated = agg._max.updatedAt?.toISOString() ?? '0';
    const page = req.query.page ?? '1';
    const limit = req.query.limit ?? '20';
    return `markets:${maxUpdated}:${count}:${page}:${limit}`;
  }),
  listMarkets,
);

router.get('/on-chain/:onChainMarketId', marketDetailPolicy, marketDetailValidator, getMarketByOnChainId);
router.get(
  '/on-chain/:onChainMarketId/state',
  cachePolicy({ kind: 'shared', maxAge: 5, swr: 10 }),
  getOnChainMarketState,
);

// Admin only: each run calls paid LLM APIs and the treasury.
// Idempotency-Key required (#123): a retry replays the stored 202 and its
// jobId instead of starting a second paid market-maker cycle.
router.post('/generate', generateLimiter, requireAuth, requirePermission('markets.generate'), idempotent({ required: true }), triggerMarketGeneration);
router.get('/generation-status/:jobId', requireAuth, noStore(), getMarketGenerationStatus);

router.get('/:id', marketDetailPolicy, marketDetailValidator, getMarket);

export default router;
