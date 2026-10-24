import { Router } from 'express';
import {
  createIntent,
  getIntent,
  getMyPaymentEvents,
  getMySpendingAllowance,
  getTrace,
  getTraceKey,
  listTraces,
  preauthorizeAccess,
  setSpendingAllowance,
  submitIntent,
  unlockTrace,
  verifyTrace,
} from '../controllers/trace.controller';
import { optionalAuth, requireAuth } from '../middlewares/auth.middleware';
import { idempotent } from '../middlewares/idempotency.middleware';
import { cachePolicy, validator, noStore } from '../middlewares/cache.middleware';
import { prisma } from '../lib/prisma';

const router = Router();

// Public
router.get(
  '/',
  cachePolicy({ kind: 'shared', maxAge: 10, swr: 60 }),
  validator(async (req) => {
    const agentType = req.query.agentType as any;
    const marketId = req.query.marketId as any;
    if (agentType !== undefined && agentType !== 'MARKET_MAKER' && agentType !== 'TRADER') {
      return null;
    }
    const where = {
      ...(agentType ? { agentType: agentType as 'MARKET_MAKER' | 'TRADER' } : {}),
      ...(typeof marketId === 'string' && marketId ? { marketId } : {}),
    };
    const [agg, count] = await Promise.all([
      prisma.reasoningTrace.aggregate({ where, _max: { updatedAt: true } }),
      prisma.reasoningTrace.count({ where }),
    ]);
    const maxUpdated = agg._max.updatedAt?.toISOString() ?? '0';
    const page = req.query.page ?? '1';
    const limit = req.query.limit ?? '20';
    return `traces:${maxUpdated}:${count}:${page}:${limit}`;
  }),
  listTraces,
);

router.get('/access/allowance', requireAuth, noStore(), getMySpendingAllowance);
router.put('/access/allowance', requireAuth, idempotent(), setSpendingAllowance);
router.post('/access/preauthorize', requireAuth, preauthorizeAccess);
router.get('/payments', requireAuth, noStore(), getMyPaymentEvents);
router.post('/payment-intents', requireAuth, createIntent);
router.get('/payment-intents/:id', requireAuth, getIntent);
router.post('/payment-intents/:id/submit', requireAuth, submitIntent);

router.get(
  '/:id',
  optionalAuth,
  cachePolicy(async (req) => {
    if (!req.headers.authorization) {
      const trace = await prisma.reasoningTrace.findUnique({
        where: { id: req.params.id },
        select: { onChainTraceId: true },
      });
      if (trace && trace.onChainTraceId !== null) {
        return { kind: 'shared', maxAge: 300, swr: 0 };
      }
    }
    return { kind: 'personalised', maxAge: 0 };
  }),
  validator(async (req) => {
    const trace = await prisma.reasoningTrace.findUnique({
      where: { id: req.params.id },
      select: { id: true, updatedAt: true, verified: true, onChainTraceId: true },
    });
    if (!trace) return null;
    return `trace:${trace.id}:${trace.updatedAt.toISOString()}:${trace.verified}:${trace.onChainTraceId ?? ''}`;
  }),
  getTrace,
);

// Protected
// Idempotency-Key optional (#123). Lock is 60s by default, above verify's 20s IPFS timeout.
router.post('/verify', requireAuth, idempotent(), verifyTrace);
router.post('/:id/unlock', requireAuth, idempotent(), unlockTrace);

export default router;
