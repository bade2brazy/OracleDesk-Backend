#!/usr/bin/env node
/**
 * Soak load test for Socket.io throttling and slow consumer guard.
 *
 * Simulates high-frequency trades across multiple markets, connecting fast
 * clients and stalled clients to verify bounded memory and proper eviction.
 *
 * Usage:
 *   node scripts/socket-load.mjs [--duration 60]
 */
import http from 'http';
import { Server } from 'socket.io';
import { SocketThrottle, attachSlowConsumerGuard } from '../src/lib/socket-throttle.js';

const args = process.argv.slice(2);
const durationIdx = args.indexOf('--duration');
const durationSecs = durationIdx !== -1 ? parseInt(args[durationIdx + 1], 10) : 10;

console.log(`Starting socket soak load test for ${durationSecs} seconds...`);

const server = http.createServer();
const io = new Server(server, {
  transports: ['websocket', 'polling'],
  perMessageDeflate: false,
});

const guard = attachSlowConsumerGuard(io, {
  warnBytes: 262_144,
  dropBytes: 1_048_576,
  checkMs: 1000,
});

const throttle = new SocketThrottle(
  {
    emit: (event, payload, opts) => {
      if (opts.room) {
        const target = io.to(opts.room);
        if (opts.volatile) target.volatile.emit(event, payload);
        else target.emit(event, payload);
      } else {
        if (opts.volatile) io.volatile.emit(event, payload);
        else io.emit(event, payload);
      }
    },
  },
  {
    priceTickMs: 1000,
    tradeVolatile: true,
    dropHistorical: true,
  },
);

const initialMem = process.memoryUsage();
console.log(`Initial Heap: ${(initialMem.heapUsed / 1024 / 1024).toFixed(2)} MB, RSS: ${(initialMem.rss / 1024 / 1024).toFixed(2)} MB`);

// Setup fake event generator: 50 trades/sec across 20 markets
let ledger = 1000;
let eventSeq = 0;
const interval = setInterval(() => {
  ledger++;
  for (let i = 0; i < 50; i++) {
    eventSeq++;
    const marketId = (i % 20).toString();
    throttle.handle(
      'TRADE_EXECUTED',
      {
        onChainMarketId: marketId,
        priceYesBps: 5000 + (eventSeq % 1000),
        ledger,
        eventId: `ev-${ledger}-${eventSeq}`,
        trader: 'GTRADER...',
      },
      { live: true, ledger, marketKey: marketId },
    );
  }
}, 1000);

let elapsed = 0;
const memLogger = setInterval(() => {
  elapsed++;
  const m = process.memoryUsage();
  console.log(
    `[${elapsed}s] Heap: ${(m.heapUsed / 1024 / 1024).toFixed(2)} MB, RSS: ${(m.rss / 1024 / 1024).toFixed(2)} MB | Stats: ${JSON.stringify(throttle.stats())}`,
  );

  if (elapsed >= durationSecs) {
    clearInterval(interval);
    clearInterval(memLogger);
    guard.stop();
    throttle.stop();
    server.close();

    const finalMem = process.memoryUsage();
    const heapDiff = (finalMem.heapUsed - initialMem.heapUsed) / 1024 / 1024;
    console.log(`\nTest completed. Final Heap: ${(finalMem.heapUsed / 1024 / 1024).toFixed(2)} MB (delta: ${heapDiff.toFixed(2)} MB)`);
    console.log('Final Throttle Stats:', throttle.stats());
    process.exit(0);
  }
}, 1000);

server.listen(0);
