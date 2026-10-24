/**
 * Resolution status. Outcomes are decided on-chain by the resolver contract
 * (Reflector price specs or signer attestations); the backend only reads.
 */
import { prisma } from '../lib/prisma';
import { AppError } from '../middlewares/error.middleware';
import { getOnChainMarketCached, resolverStateCached } from './chain.service';
import type { MarketStatus } from '../generated/market-core';

export type MarketStatusView =
  | { tag: 'Open' }
  | { tag: 'Resolved'; outcome: 'Yes' | 'No' }
  | { tag: 'Void' };

export function marketStatusView(status: MarketStatus): MarketStatusView {
  if (status.tag === 'Resolved') return { tag: 'Resolved', outcome: status.values[0].tag };
  return { tag: status.tag };
}

export async function getResolutionStatus(marketId: string, signal?: AbortSignal) {
  const market = await prisma.market.findUnique({
    where: { id: marketId },
    select: { id: true, status: true, onChainMarketId: true, resolutionHash: true, resolutionSpec: true },
  });
  if (!market) throw new AppError(404, 'MARKET_NOT_FOUND', 'Market not found');
  if (market.onChainMarketId === null) {
    throw new AppError(409, 'MARKET_NOT_ON_CHAIN', 'Market has not been created on-chain yet');
  }

  const [stateRes, onChainRes] = await Promise.all([
    resolverStateCached(market.onChainMarketId, signal),
    getOnChainMarketCached(market.onChainMarketId, signal),
  ]);

  const state = stateRes.value;
  const onChain = onChainRes.value;
  const ledger = Math.min(stateRes.ledger, onChainRes.ledger);
  const cached = Boolean(stateRes.cached && onChainRes.cached);

  return {
    marketId: market.id,
    onChainMarketId: market.onChainMarketId.toString(),
    resolverState: state.tag,
    marketStatus: marketStatusView(onChain.status),
    resolutionHash: market.resolutionHash,
    resolutionSpec: market.resolutionSpec,
    dbStatus: market.status,
    ledger,
    cached,
  };
}
