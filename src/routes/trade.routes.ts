import { Router } from 'express';
import { initiateCopyTrade, confirmCopyTrade } from '../controllers/trade.controller';
import { requireAuth } from '../middlewares/auth.middleware';
import { idempotent } from '../middlewares/idempotency.middleware';

const router = Router();

// #123: required on /copy (each duplicate creates another PENDING CopyTrade).
router.post('/copy',          requireAuth, idempotent({ required: true }), initiateCopyTrade);
router.patch('/copy/:id/confirm', requireAuth, idempotent(), confirmCopyTrade);

export default router;
