import test from 'node:test';
import assert from 'node:assert/strict';
import { setupTestEnv } from './helpers/env';
import { SocketThrottle, attachSlowConsumerGuard } from '../src/lib/socket-throttle';

setupTestEnv();

test('bursts of trades on one market produce one MARKET_PRICE per tick with the latest price', () => {
  let currentTime = 1000;
  const timers = new Map<number, { fn: () => void; triggerAt: number }>();
  let timerId = 0;

  const emitted: Array<{ event: string; payload: any; opts: any }> = [];
  const sink = {
    emit(event: string, payload: unknown, opts: { volatile: boolean; room?: string }) {
      emitted.push({ event, payload, opts });
    },
  };

  const throttle = new SocketThrottle(sink, {
    priceTickMs: 1000,
    tradeVolatile: true,
    dropHistorical: true,
    now: () => currentTime,
    schedule: (fn, ms) => {
      const id = ++timerId;
      timers.set(id, { fn, triggerAt: currentTime + ms });
      return id;
    },
  });

  // Burst of 5 trades in the same tick
  for (let i = 1; i <= 5; i++) {
    throttle.handle(
      'TRADE_EXECUTED',
      { onChainMarketId: '0', priceYesBps: 5000 + i * 100, ledger: 100 + i, eventId: `ev-${i}` },
      { live: true, ledger: 100 + i, marketKey: '0' },
    );
  }

  // Trades are emitted immediately to realtime:full room
  const trades = emitted.filter((e) => e.event === 'TRADE_EXECUTED');
  assert.equal(trades.length, 5);

  // No price ticks emitted yet
  assert.equal(emitted.filter((e) => e.event === 'MARKET_PRICE').length, 0);

  // Advance time to 2000 ms and trigger timer
  currentTime = 2000;
  for (const [id, t] of timers.entries()) {
    if (t.triggerAt <= currentTime) {
      timers.delete(id);
      t.fn();
    }
  }

  const prices = emitted.filter((e) => e.event === 'MARKET_PRICE');
  assert.equal(prices.length, 1);
  assert.equal(prices[0].payload.priceYesBps, 5500);
  assert.equal(prices[0].payload.ledger, 105);
  assert.equal(prices[0].opts.volatile, false);
});

test('final price after a burst is emitted when the tick elapses', () => {
  let currentTime = 1000;
  const timers = new Map<number, { fn: () => void; triggerAt: number }>();
  let timerId = 0;

  const emitted: Array<{ event: string; payload: any }> = [];
  const sink = {
    emit(event: string, payload: unknown) {
      emitted.push({ event, payload });
    },
  };

  const throttle = new SocketThrottle(sink, {
    priceTickMs: 500,
    tradeVolatile: true,
    dropHistorical: true,
    now: () => currentTime,
    schedule: (fn, ms) => {
      const id = ++timerId;
      timers.set(id, { fn, triggerAt: currentTime + ms });
      return id;
    },
  });

  throttle.handle(
    'TRADE_EXECUTED',
    { onChainMarketId: '1', priceYesBps: 6000, ledger: 200, eventId: 'ev-1' },
    { live: true, ledger: 200, marketKey: '1' },
  );

  // Before timer expires: 0 price ticks
  assert.equal(emitted.filter((e) => e.event === 'MARKET_PRICE').length, 0);

  currentTime = 1600;
  for (const [id, t] of timers.entries()) {
    if (t.triggerAt <= currentTime) {
      timers.delete(id);
      t.fn();
    }
  }

  const prices = emitted.filter((e) => e.event === 'MARKET_PRICE');
  assert.equal(prices.length, 1);
  assert.equal(prices[0].payload.priceYesBps, 6000);
});

test('out-of-order older ledger never overwrites a newer pending price', () => {
  let currentTime = 1000;
  const timers = new Map<number, { fn: () => void; triggerAt: number }>();
  let timerId = 0;

  const emitted: Array<{ event: string; payload: any }> = [];
  const sink = {
    emit(event: string, payload: unknown) {
      emitted.push({ event, payload });
    },
  };

  const throttle = new SocketThrottle(sink, {
    priceTickMs: 1000,
    tradeVolatile: true,
    dropHistorical: true,
    now: () => currentTime,
    schedule: (fn, ms) => {
      const id = ++timerId;
      timers.set(id, { fn, triggerAt: currentTime + ms });
      return id;
    },
  });

  // Newer trade first
  throttle.handle(
    'TRADE_EXECUTED',
    { onChainMarketId: '2', priceYesBps: 7000, ledger: 300, eventId: 'ev-2' },
    { live: true, ledger: 300, marketKey: '2' },
  );

  // Out of order older trade
  throttle.handle(
    'TRADE_EXECUTED',
    { onChainMarketId: '2', priceYesBps: 6500, ledger: 299, eventId: 'ev-1' },
    { live: true, ledger: 299, marketKey: '2' },
  );

  currentTime = 2000;
  for (const [id, t] of timers.entries()) {
    if (t.triggerAt <= currentTime) {
      timers.delete(id);
      t.fn();
    }
  }

  const prices = emitted.filter((e) => e.event === 'MARKET_PRICE');
  assert.equal(prices.length, 1);
  assert.equal(prices[0].payload.priceYesBps, 7000);
  assert.equal(prices[0].payload.ledger, 300);
});

test('historical events during catch-up are not emitted live and CATCHUP_COMPLETE is emitted once', () => {
  const emitted: Array<{ event: string; payload: any }> = [];
  const sink = {
    emit(event: string, payload: unknown) {
      emitted.push({ event, payload });
    },
  };

  const throttle = new SocketThrottle(sink, {
    priceTickMs: 1000,
    tradeVolatile: true,
    dropHistorical: true,
  });

  // Historical trade during catch-up (live: false)
  throttle.handle(
    'TRADE_EXECUTED',
    { onChainMarketId: '0', priceYesBps: 5000, ledger: 10, eventId: 'ev-old' },
    { live: false, ledger: 10, marketKey: '0' },
  );

  assert.equal(emitted.length, 0);
  assert.equal(throttle.stats().droppedHistorical, 1);

  // Catchup complete event
  throttle.handle(
    'CATCHUP_COMPLETE',
    { fromLedger: 1, toLedger: 100, events: 50 },
    { live: true, ledger: 100, marketKey: null },
  );

  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event, 'CATCHUP_COMPLETE');
});

test('TRADE_EXECUTED is volatile by default and non-volatile when configured', () => {
  const emittedDefault: any[] = [];
  const throttleDefault = new SocketThrottle(
    { emit: (event, payload, opts) => emittedDefault.push({ event, payload, opts }) },
    { priceTickMs: 1000, tradeVolatile: true, dropHistorical: true },
  );

  throttleDefault.handle(
    'TRADE_EXECUTED',
    { onChainMarketId: '0', priceYesBps: 5000, ledger: 100, eventId: '1' },
    { live: true, ledger: 100, marketKey: '0' },
  );
  assert.equal(emittedDefault[0].opts.volatile, true);

  const emittedNonVolatile: any[] = [];
  const throttleNonVolatile = new SocketThrottle(
    { emit: (event, payload, opts) => emittedNonVolatile.push({ event, payload, opts }) },
    { priceTickMs: 1000, tradeVolatile: false, dropHistorical: true },
  );

  throttleNonVolatile.handle(
    'TRADE_EXECUTED',
    { onChainMarketId: '0', priceYesBps: 5000, ledger: 100, eventId: '1' },
    { live: true, ledger: 100, marketKey: '0' },
  );
  assert.equal(emittedNonVolatile[0].opts.volatile, false);
});

test('idle markets release their timers', () => {
  let cleared = false;
  const throttle = new SocketThrottle(
    { emit: () => {} },
    {
      priceTickMs: 1000,
      tradeVolatile: true,
      dropHistorical: true,
      schedule: () => ({
        // Timer token
      }),
    },
  );

  throttle.handle(
    'TRADE_EXECUTED',
    { onChainMarketId: '0', priceYesBps: 5000, ledger: 100, eventId: '1' },
    { live: true, ledger: 100, marketKey: '0' },
  );

  throttle.stop();
  // Ensure pending was cleared
  throttle.flush();
  assert.equal(throttle.stats().emitted['MARKET_PRICE'] ?? 0, 0);
});

test('slow-consumer guard degrades then disconnects sockets above thresholds', () => {
  const disconnected: string[] = [];
  const rooms = new Map<string, Set<string>>();

  const fakeSockets = new Map<string, any>([
    [
      'sock-normal',
      {
        id: 'sock-normal',
        conn: { transport: { socket: { bufferedAmount: 1000 } } },
        join: (r: string) => {
          let s = rooms.get('sock-normal');
          if (!s) { s = new Set(); rooms.set('sock-normal', s); }
          s.add(r);
        },
        leave: (r: string) => rooms.get('sock-normal')?.delete(r),
        disconnect: () => disconnected.push('sock-normal'),
      },
    ],
    [
      'sock-slow',
      {
        id: 'sock-slow',
        conn: { transport: { socket: { bufferedAmount: 300_000 } } },
        join: (r: string) => {
          let s = rooms.get('sock-slow');
          if (!s) { s = new Set(); rooms.set('sock-slow', s); }
          s.add(r);
        },
        leave: (r: string) => rooms.get('sock-slow')?.delete(r),
        disconnect: () => disconnected.push('sock-slow'),
      },
    ],
    [
      'sock-stalled',
      {
        id: 'sock-stalled',
        conn: { transport: { socket: { bufferedAmount: 3_000_000 } } },
        join: (r: string) => {
          let s = rooms.get('sock-stalled');
          if (!s) { s = new Set(); rooms.set('sock-stalled', s); }
          s.add(r);
        },
        leave: (r: string) => rooms.get('sock-stalled')?.delete(r),
        disconnect: () => disconnected.push('sock-stalled'),
      },
    ],
  ]);

  const fakeIo = {
    of: () => ({ sockets: fakeSockets }),
    on: () => {},
  };

  const guard = attachSlowConsumerGuard(fakeIo, {
    warnBytes: 262_144, // 256KB
    dropBytes: 2_097_152, // 2MB
    checkMs: 50,
  });

  // Wait a moment for guard loop check
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      guard.stop();
      assert.ok(disconnected.includes('sock-stalled'), 'sock-stalled must be disconnected');
      assert.ok(!rooms.get('sock-slow')?.has('realtime:full'), 'sock-slow must leave realtime:full');
      resolve();
    }, 100);
  });
});
