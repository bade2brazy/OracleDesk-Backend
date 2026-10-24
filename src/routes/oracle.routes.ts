import { Router } from 'express';
import { getResolution } from '../controllers/oracle.controller';
import { cachePolicy } from '../middlewares/cache.middleware';
import { prisma } from '../lib/prisma';

const router = Router();

// Read-only. Outcomes are decided on-chain by the resolver contract.
router.get(
  '/markets/:marketId/resolution',
  cachePolicy(async (req) => {
    const market = await prisma.market.findUnique({
      where: { id: req.params.marketId },
      select: { status: true },
    });
    if (market && (market.status === 'RESOLVED' || market.status === 'CANCELLED')) {
      return { kind: 'immutable', maxAge: 86400 };
    }
    return { kind: 'shared', maxAge: 5, swr: 10 };
  }),
  getResolution,
);

export default router;
