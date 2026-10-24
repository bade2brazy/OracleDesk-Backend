import type { Request, Response } from 'express';
import { sendSuccess } from '../utils/response.util';
import { getResolutionStatus } from '../services/oracle.service';

/** GET /oracle/markets/:marketId/resolution — live resolver + market-core state. */
export async function getResolution(req: Request, res: Response): Promise<void> {
  sendSuccess(res, await getResolutionStatus(String(req.params.marketId), req.signal));
}
