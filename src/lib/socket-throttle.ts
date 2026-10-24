import type { Server } from 'socket.io';
import { logger } from './logger';

export interface Sink {
  emit(event: string, payload: unknown, opts: { volatile: boolean; room?: string }): void;
}

export interface ThrottleOptions {
  priceTickMs: number;
  tradeVolatile: boolean;
  dropHistorical: boolean;
  now?: () => number;
  schedule?: (fn: () => void, ms: number) => unknown;
}

export interface MarketPricePayload {
  onChainMarketId: string;
  marketId: string | null;
  priceYesBps: number;
  ledger: number;
  eventId: string;
  ts: number;
}

export class SocketThrottle {
  private sink: Sink;
  private opts: ThrottleOptions;
  private now: () => number;
  private schedule: (fn: () => void, ms: number) => unknown;

  private pendingPrices = new Map<string, MarketPricePayload>();
  private activeTimers = new Map<string, unknown>();
  private lastEmittedAt = new Map<string, number>();
  private lastEmittedLedger = new Map<string, number>();

  private coalescedCount = 0;
  private droppedHistoricalCount = 0;
  private emittedCounts: Record<string, number> = {};

  constructor(sink: Sink, opts: ThrottleOptions) {
    this.sink = sink;
    this.opts = opts;
    this.now = opts.now ?? (() => Date.now());
    this.schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  }

  private incrementEmitted(event: string): void {
    this.emittedCounts[event] = (this.emittedCounts[event] ?? 0) + 1;
  }

  public handle(
    event: string,
    payload: any,
    meta: { live: boolean; ledger: number; marketKey: string | null },
  ): void {
    if (!meta.live && this.opts.dropHistorical && event !== 'CATCHUP_COMPLETE') {
      this.droppedHistoricalCount++;
      return;
    }

    if (event === 'TRADE_EXECUTED') {
      const marketKey = meta.marketKey || payload?.onChainMarketId || payload?.marketId || 'unknown';
      const lastLedger = this.lastEmittedLedger.get(marketKey) ?? 0;

      // Drop pending update older than the last emitted ledger for that market
      if (payload?.ledger !== undefined && payload.ledger < lastLedger) {
        this.coalescedCount++;
      } else {
        const existing = this.pendingPrices.get(marketKey);
        if (existing) {
          // Compare ledger, then eventId string
          const isNewer =
            payload.ledger > existing.ledger ||
            (payload.ledger === existing.ledger && String(payload.eventId) >= String(existing.eventId));
          if (isNewer) {
            this.pendingPrices.set(marketKey, {
              onChainMarketId: String(payload.onChainMarketId),
              marketId: payload.marketId ?? null,
              priceYesBps: Number(payload.priceYesBps),
              ledger: Number(payload.ledger),
              eventId: String(payload.eventId),
              ts: this.now(),
            });
          }
          this.coalescedCount++;
        } else {
          this.pendingPrices.set(marketKey, {
            onChainMarketId: String(payload.onChainMarketId),
            marketId: payload.marketId ?? null,
            priceYesBps: Number(payload.priceYesBps),
            ledger: Number(payload.ledger),
            eventId: String(payload.eventId),
            ts: this.now(),
          });

          const lastEmit = this.lastEmittedAt.get(marketKey) ?? 0;
          const elapsed = this.now() - lastEmit;
          const delay = Math.max(0, this.opts.priceTickMs - elapsed);

          const timer = this.schedule(() => this.flushMarket(marketKey), delay);
          this.activeTimers.set(marketKey, timer);
        }
      }

      // Emit trade itself to realtime:full room
      this.sink.emit('TRADE_EXECUTED', payload, {
        volatile: this.opts.tradeVolatile,
        room: 'realtime:full',
      });
      this.incrementEmitted('TRADE_EXECUTED');
      return;
    }

    if (event === 'REASONING_PUBLISHED') {
      this.sink.emit('REASONING_PUBLISHED', payload, { volatile: false });
      this.incrementEmitted('REASONING_PUBLISHED');
      return;
    }

    if (event === 'CATCHUP_COMPLETE') {
      this.sink.emit('CATCHUP_COMPLETE', payload, { volatile: false });
      this.incrementEmitted('CATCHUP_COMPLETE');
      return;
    }

    this.sink.emit(event, payload, { volatile: false });
    this.incrementEmitted(event);
  }

  private flushMarket(marketKey: string): void {
    this.clearScheduledTimer(marketKey);
    const update = this.pendingPrices.get(marketKey);
    if (!update) return;

    this.pendingPrices.delete(marketKey);
    this.lastEmittedAt.set(marketKey, this.now());
    this.lastEmittedLedger.set(marketKey, update.ledger);

    this.sink.emit('MARKET_PRICE', update, { volatile: false });
    this.incrementEmitted('MARKET_PRICE');
  }

  private clearScheduledTimer(marketKey: string): void {
    const timer = this.activeTimers.get(marketKey);
    if (timer) {
      if (typeof timer === 'number' || typeof timer === 'object') {
        clearTimeout(timer as NodeJS.Timeout);
      }
      this.activeTimers.delete(marketKey);
    }
  }

  public flush(): void {
    for (const marketKey of Array.from(this.pendingPrices.keys())) {
      this.flushMarket(marketKey);
    }
  }

  public stop(): void {
    for (const marketKey of Array.from(this.activeTimers.keys())) {
      this.clearScheduledTimer(marketKey);
    }
    this.pendingPrices.clear();
  }

  public stats(): {
    coalesced: number;
    droppedHistorical: number;
    emitted: Record<string, number>;
  } {
    return {
      coalesced: this.coalescedCount,
      droppedHistorical: this.droppedHistoricalCount,
      emitted: { ...this.emittedCounts },
    };
  }
}

export interface SlowConsumerGuardOptions {
  warnBytes: number;
  dropBytes: number;
  checkMs: number;
}

export function attachSlowConsumerGuard(
  io: Server | any,
  opts: SlowConsumerGuardOptions,
): { stop(): void } {
  // Ensure all connecting sockets join the realtime:full room
  if (typeof io.on === 'function') {
    io.on('connection', (socket: any) => {
      socket.join('realtime:full');
    });
  }

  const checkSockets = () => {
    try {
      const socketMap = io.of ? io.of('/').sockets : io.sockets?.sockets;
      if (!socketMap) return;

      const sockets = socketMap.values ? Array.from(socketMap.values()) : Object.values(socketMap);
      for (const socket of sockets as any[]) {
        let bufferedBytes = 0;
        try {
          if (socket.conn?.transport?.socket?.bufferedAmount !== undefined) {
            bufferedBytes = socket.conn.transport.socket.bufferedAmount;
          } else if (socket.conn?.writeBuffer?.length !== undefined) {
            bufferedBytes = socket.conn.writeBuffer.length * 1024;
          }
        } catch {
          bufferedBytes = 0;
        }

        if (bufferedBytes >= opts.dropBytes) {
          logger.warn(
            { socketId: socket.id, bufferedBytes, dropBytes: opts.dropBytes },
            'Slow consumer dropped: exceeded dropBytes buffer threshold',
          );
          socket.disconnect(true);
        } else if (bufferedBytes >= opts.warnBytes) {
          if (typeof socket.leave === 'function') {
            socket.leave('realtime:full');
          }
        } else {
          if (typeof socket.join === 'function') {
            socket.join('realtime:full');
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in slow-consumer guard check');
    }
  };

  const timer = setInterval(checkSockets, opts.checkMs);

  return {
    stop: () => clearInterval(timer),
  };
}
