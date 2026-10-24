import type { IncomingMessage } from 'http';
import crypto from 'crypto';
import type { Socket } from 'socket.io';
import type Redis from 'ioredis';
import { config } from '../config';
import { logger } from './logger';

export function normalizeIp(ip: string | undefined): string {
  if (!ip) return '127.0.0.1';
  let cleaned = ip.trim();
  if (cleaned.startsWith('::ffff:')) {
    cleaned = cleaned.slice(7);
  }
  return cleaned;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    return null;
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

export function ipMatchesCidr(ip: string, cidr: string): boolean {
  const normIp = normalizeIp(ip);
  const normCidr = cidr.trim();
  if (!normCidr) return false;

  if (!normCidr.includes('/')) {
    return normIp.toLowerCase() === normalizeIp(normCidr).toLowerCase();
  }

  const [net, maskStr] = normCidr.split('/');
  const mask = parseInt(maskStr, 10);
  if (isNaN(mask) || mask < 0 || mask > 32) return false;

  const ipInt = ipv4ToInt(normIp);
  const netInt = ipv4ToInt(net);
  if (ipInt === null || netInt === null) {
    return normIp.toLowerCase() === net.toLowerCase();
  }

  const bitmask = mask === 0 ? 0 : (~0 << (32 - mask)) >>> 0;
  return (ipInt & bitmask) === (netInt & bitmask);
}

export function isIpInCidrs(ip: string, cidrs: string[]): boolean {
  if (!cidrs || cidrs.length === 0) return false;
  return cidrs.some((cidr) => ipMatchesCidr(ip, cidr));
}

export function clientIp(req: IncomingMessage, trusted: string[] = config.TRUSTED_PROXIES): string {
  const peerIp = normalizeIp(req.socket?.remoteAddress);
  if (!trusted || trusted.length === 0 || !isIpInCidrs(peerIp, trusted)) {
    return peerIp;
  }

  const xff = req.headers['x-forwarded-for'];
  if (!xff || typeof xff !== 'string') {
    return peerIp;
  }

  const ips = xff
    .split(',')
    .map((s) => normalizeIp(s.trim()))
    .filter(Boolean);

  if (ips.length === 0) return peerIp;

  // Walk right-to-left skipping trusted proxies
  for (let i = ips.length - 1; i >= 0; i--) {
    const ip = ips[i];
    if (!isIpInCidrs(ip, trusted)) {
      return ip;
    }
  }

  return ips[0];
}

export function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true;
  return config.CORS_ORIGINS.includes(origin);
}

export interface ConnectionLimiterOptions {
  maxConnections: number;
  maxPerIp: number;
  connectRatePerMin: number;
  exemptCidrs?: string[];
  instanceId?: string;
}

export interface ConnectionLimiter {
  acquire(ip: string, socketId: string): Promise<{ ok: true } | { ok: false; reason: 'GLOBAL' | 'PER_IP' | 'RATE' }>;
  release(ip: string, socketId: string): Promise<void>;
}

const metricsState = {
  connected: 0,
  rejected: {
    GLOBAL: 0,
    PER_IP: 0,
    RATE: 0,
    ORIGIN: 0,
    EVENT: 0,
  } as Record<string, number>,
  disconnectedForAbuse: 0,
};

export function recordSocketRejection(reason: string): void {
  metricsState.rejected[reason] = (metricsState.rejected[reason] ?? 0) + 1;
}

export function socketMetrics(): {
  connected: number;
  rejected: Record<string, number>;
  disconnectedForAbuse: number;
} {
  return {
    connected: metricsState.connected,
    rejected: { ...metricsState.rejected },
    disconnectedForAbuse: metricsState.disconnectedForAbuse,
  };
}

export function memoryConnectionLimiter(opts: ConnectionLimiterOptions): ConnectionLimiter {
  const activeSockets = new Map<string, string>(); // socketId -> ip
  const ipSockets = new Map<string, Set<string>>(); // ip -> Set<socketId>
  const rateCounts = new Map<string, { count: number; expiresAt: number }>();

  return {
    async acquire(ip: string, socketId: string) {
      const isExempt = opts.exemptCidrs && isIpInCidrs(ip, opts.exemptCidrs);

      if (activeSockets.size >= opts.maxConnections) {
        metricsState.rejected.GLOBAL = (metricsState.rejected.GLOBAL ?? 0) + 1;
        return { ok: false, reason: 'GLOBAL' };
      }

      if (!isExempt) {
        const now = Date.now();
        let rateEntry = rateCounts.get(ip);
        if (!rateEntry || now > rateEntry.expiresAt) {
          rateEntry = { count: 0, expiresAt: now + 60_000 };
          rateCounts.set(ip, rateEntry);
        }

        if (rateEntry.count >= opts.connectRatePerMin) {
          metricsState.rejected.RATE = (metricsState.rejected.RATE ?? 0) + 1;
          return { ok: false, reason: 'RATE' };
        }
        rateEntry.count++;

        const currentSet = ipSockets.get(ip);
        if (currentSet && currentSet.size >= opts.maxPerIp) {
          metricsState.rejected.PER_IP = (metricsState.rejected.PER_IP ?? 0) + 1;
          return { ok: false, reason: 'PER_IP' };
        }
      }

      activeSockets.set(socketId, ip);
      let set = ipSockets.get(ip);
      if (!set) {
        set = new Set();
        ipSockets.set(ip, set);
      }
      set.add(socketId);
      metricsState.connected++;

      return { ok: true };
    },

    async release(ip: string, socketId: string) {
      if (activeSockets.has(socketId)) {
        activeSockets.delete(socketId);
        const set = ipSockets.get(ip);
        if (set) {
          set.delete(socketId);
          if (set.size === 0) ipSockets.delete(ip);
        }
        metricsState.connected = Math.max(0, metricsState.connected - 1);
      }
    },
  };
}

const LUA_ACQUIRE = `
local ipKey = KEYS[1]
local instancesKey = KEYS[2]
local rateKey = KEYS[3]
local member = ARGV[1]
local maxGlobal = tonumber(ARGV[2])
local maxPerIp = tonumber(ARGV[3])
local maxRate = tonumber(ARGV[4])
local isExempt = ARGV[5]
local instanceId = ARGV[6]

-- Calculate total cluster connections
local total = 0
local instCounts = redis.call('HGETALL', instancesKey)
for i = 2, #instCounts, 2 do
  total = total + tonumber(instCounts[i])
end

if total >= maxGlobal then
  return 'GLOBAL'
end

if isExempt ~= '1' then
  local currentRate = redis.call('INCR', rateKey)
  if currentRate == 1 then
    redis.call('EXPIRE', rateKey, 120)
  end
  if currentRate > maxRate then
    return 'RATE'
  end

  local ipCount = redis.call('SCARD', ipKey)
  if ipCount >= maxPerIp then
    return 'PER_IP'
  end
end

redis.call('SADD', ipKey, member)
redis.call('EXPIRE', ipKey, 120)
redis.call('HINCRBY', instancesKey, instanceId, 1)

return 'OK'
`;

const LUA_RELEASE = `
local ipKey = KEYS[1]
local instancesKey = KEYS[2]
local member = ARGV[1]
local instanceId = ARGV[2]

redis.call('SREM', ipKey, member)
local cur = redis.call('HINCRBY', instancesKey, instanceId, -1)
if cur <= 0 then
  redis.call('HDEL', instancesKey, instanceId)
end
return 'OK'
`;

let lastRedisErrorLog = 0;

export function redisConnectionLimiter(redis: Redis, opts: ConnectionLimiterOptions): ConnectionLimiter {
  const fallback = memoryConnectionLimiter(opts);
  const instanceId = opts.instanceId || `${process.pid}:${crypto.randomBytes(4).toString('hex')}`;

  const currentMinute = () => Math.floor(Date.now() / 60000);

  return {
    async acquire(ip: string, socketId: string) {
      try {
        const isExempt = opts.exemptCidrs && isIpInCidrs(ip, opts.exemptCidrs);
        const ipKey = `socklim:ip:${ip}`;
        const instancesKey = 'socklim:instances';
        const rateKey = `socklim:rate:${ip}:${currentMinute()}`;
        const member = `${instanceId}:${socketId}`;

        const res = (await redis.eval(
          LUA_ACQUIRE,
          3,
          ipKey,
          instancesKey,
          rateKey,
          member,
          opts.maxConnections.toString(),
          opts.maxPerIp.toString(),
          opts.connectRatePerMin.toString(),
          isExempt ? '1' : '0',
          instanceId,
        )) as string;

        if (res === 'OK') {
          metricsState.connected++;
          return { ok: true };
        }

        const reason = res as 'GLOBAL' | 'PER_IP' | 'RATE';
        metricsState.rejected[reason] = (metricsState.rejected[reason] ?? 0) + 1;
        return { ok: false, reason };
      } catch (err) {
        const now = Date.now();
        if (now - lastRedisErrorLog > 60_000) {
          logger.warn({ err }, 'Redis connection limiter failed; falling back to memory limiter');
          lastRedisErrorLog = now;
        }
        return fallback.acquire(ip, socketId);
      }
    },

    async release(ip: string, socketId: string) {
      try {
        const ipKey = `socklim:ip:${ip}`;
        const instancesKey = 'socklim:instances';
        const member = `${instanceId}:${socketId}`;

        await redis.eval(LUA_RELEASE, 2, ipKey, instancesKey, member, instanceId);
        metricsState.connected = Math.max(0, metricsState.connected - 1);
      } catch (err) {
        await fallback.release(ip, socketId);
      }
    },
  };
}

export interface InboundLimiterOptions {
  allowedEvents?: string[];
  eventsPer10s?: number;
}

export function inboundEventLimiter(socket: Socket, opts: InboundLimiterOptions = {}): void {
  const allowed = new Set(opts.allowedEvents ?? []);
  const limit = opts.eventsPer10s ?? config.SOCKET_INBOUND_EVENTS_PER_10S;

  let eventCount = 0;
  let windowEnd = Date.now() + 10_000;
  let violations = 0;
  let violationWindowEnd = Date.now() + 60_000;

  socket.use(([event], next) => {
    const now = Date.now();
    if (now > violationWindowEnd) {
      violations = 0;
      violationWindowEnd = now + 60_000;
    }
    if (now > windowEnd) {
      eventCount = 0;
      windowEnd = now + 10_000;
    }

    if (!allowed.has(event)) {
      violations++;
      metricsState.rejected.EVENT = (metricsState.rejected.EVENT ?? 0) + 1;
      if (violations >= 3) {
        metricsState.disconnectedForAbuse++;
        logger.warn(
          { socketId: socket.id, event, violations },
          'Socket disconnected for repeated unknown inbound events',
        );
        socket.disconnect(true);
        return;
      }
      return next(new Error('EVENT_NOT_ALLOWED'));
    }

    eventCount++;
    if (eventCount > limit) {
      violations++;
      metricsState.rejected.RATE = (metricsState.rejected.RATE ?? 0) + 1;
      if (violations >= 3) {
        metricsState.disconnectedForAbuse++;
        logger.warn(
          { socketId: socket.id, eventCount, limit, violations },
          'Socket disconnected for inbound event rate limit abuse',
        );
        socket.disconnect(true);
        return;
      }
      return next(new Error('RATE_LIMIT_EXCEEDED'));
    }

    next();
  });
}
