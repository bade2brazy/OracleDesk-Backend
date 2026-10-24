import crypto from 'crypto';
import type Redis from 'ioredis';
import { config } from '../config';
import { logger } from './logger';
import { ChainError } from '../services/stellar/errors';

export interface CacheEntry<T> {
  value: T;
  ledger: number;
  readAt: number;
  gen: number;
}

export interface ChainCache {
  get<T>(
    key: string,
    opts: { ttlMs: number; tags: string[] },
    load: () => Promise<{ value: T; ledger: number }>,
  ): Promise<CacheEntry<T> & { cached: boolean }>;
  invalidateTag(tag: string, atLedger?: number): Promise<void>;
  stats(): { hits: number; misses: number; coalesced: number; staleRejects: number };
}

// ─── Codec ──────────────────────────────────────────────────────────────────

export function encode(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (typeof val === 'bigint') {
      return { $bigint: val.toString() };
    }
    if (Buffer.isBuffer(val) || val instanceof Uint8Array) {
      return { $buf: Buffer.from(val).toString('hex') };
    }
    return val;
  });
}

export function decode<T>(text: string): T {
  return JSON.parse(text, (_key, val) => {
    if (val && typeof val === 'object') {
      const obj = val as Record<string, unknown>;
      if (typeof obj.$bigint === 'string') {
        return BigInt(obj.$bigint);
      }
      if (typeof obj.$buf === 'string') {
        return Buffer.from(obj.$buf, 'hex') as any;
      }
    }
    return val;
  }) as T;
}

// ─── Key Helper ─────────────────────────────────────────────────────────────

export function chainKey(contractId: string, method: string, args: unknown): string {
  const netHash = crypto
    .createHash('sha256')
    .update(config.STELLAR_NETWORK_PASSPHRASE)
    .digest('hex')
    .slice(0, 16);
  const argsHash = crypto.createHash('sha256').update(encode(args)).digest('hex').slice(0, 32);
  return `chain:v1:${netHash}:${contractId}:${method}:${argsHash}`;
}

// ─── Memory Chain Cache ─────────────────────────────────────────────────────

interface StoredMemoryEntry {
  encodedValue?: string;
  isNegativeError?: boolean;
  errorPayload?: { message: string; contractError: string | null };
  ledger: number;
  readAt: number;
  ttlMs: number;
  tagGens: Record<string, number>;
}

export function memoryChainCache(): ChainCache {
  const entries = new Map<string, StoredMemoryEntry>();
  const tagGens = new Map<string, number>();
  const minLedgers = new Map<string, number>();
  const inFlight = new Map<string, Promise<any>>();

  let hits = 0;
  let misses = 0;
  let coalesced = 0;
  let staleRejects = 0;

  return {
    async invalidateTag(tag: string, atLedger?: number): Promise<void> {
      tagGens.set(tag, (tagGens.get(tag) ?? 0) + 1);
      if (atLedger !== undefined) {
        minLedgers.set(tag, Math.max(minLedgers.get(tag) ?? 0, atLedger));
      }
    },

    async get<T>(
      key: string,
      opts: { ttlMs: number; tags: string[] },
      load: () => Promise<{ value: T; ledger: number }>,
    ): Promise<CacheEntry<T> & { cached: boolean }> {
      if (inFlight.has(key)) {
        coalesced++;
        return inFlight.get(key)!;
      }

      const execute = async (): Promise<CacheEntry<T> & { cached: boolean }> => {
        const now = Date.now();
        const stored = entries.get(key);

        if (stored && now - stored.readAt < stored.ttlMs) {
          let valid = true;
          for (const tag of opts.tags) {
            const currentGen = tagGens.get(tag) ?? 0;
            const recordedGen = stored.tagGens[tag] ?? 0;
            if (currentGen > recordedGen) {
              valid = false;
              break;
            }
          }

          if (valid) {
            if (stored.isNegativeError) {
              hits++;
              throw new ChainError(
                stored.errorPayload?.message ?? 'Negative cached contract error',
                stored.errorPayload?.contractError ?? null,
              );
            }
            hits++;
            return {
              value: decode<T>(stored.encodedValue!),
              ledger: stored.ledger,
              readAt: stored.readAt,
              gen: 0,
              cached: true,
            };
          }
        }

        misses++;
        try {
          const loaded = await load();
          const currentTagGens: Record<string, number> = {};
          let minLedgerAllowed = 0;
          for (const tag of opts.tags) {
            currentTagGens[tag] = tagGens.get(tag) ?? 0;
            const ml = minLedgers.get(tag) ?? 0;
            if (ml > minLedgerAllowed) minLedgerAllowed = ml;
          }

          if (minLedgerAllowed > 0 && loaded.ledger < minLedgerAllowed) {
            staleRejects++;
            return {
              value: loaded.value,
              ledger: loaded.ledger,
              readAt: now,
              gen: 0,
              cached: false,
            };
          }

          if (stored && stored.ledger > loaded.ledger) {
            staleRejects++;
            return {
              value: loaded.value,
              ledger: loaded.ledger,
              readAt: now,
              gen: 0,
              cached: false,
            };
          }

          entries.set(key, {
            encodedValue: encode(loaded.value),
            ledger: loaded.ledger,
            readAt: now,
            ttlMs: opts.ttlMs,
            tagGens: currentTagGens,
          });

          return {
            value: loaded.value,
            ledger: loaded.ledger,
            readAt: now,
            gen: 0,
            cached: false,
          };
        } catch (err) {
          if (err instanceof ChainError && err.contractError) {
            const currentTagGens: Record<string, number> = {};
            for (const tag of opts.tags) {
              currentTagGens[tag] = tagGens.get(tag) ?? 0;
            }
            entries.set(key, {
              isNegativeError: true,
              errorPayload: { message: err.message, contractError: err.contractError },
              ledger: 0,
              readAt: now,
              ttlMs: config.CHAIN_CACHE_NEG_TTL_MS,
              tagGens: currentTagGens,
            });
          }
          throw err;
        }
      };

      const promise = execute().finally(() => inFlight.delete(key));
      inFlight.set(key, promise);
      return promise;
    },

    stats() {
      return { hits, misses, coalesced, staleRejects };
    },
  };
}

// ─── Redis Chain Cache ──────────────────────────────────────────────────────

let lastRedisCacheLog = 0;

export function redisChainCache(redis: Redis): ChainCache {
  const fallback = memoryChainCache();
  const inFlight = new Map<string, Promise<any>>();

  let hits = 0;
  let misses = 0;
  let coalesced = 0;
  let staleRejects = 0;

  return {
    async invalidateTag(tag: string, atLedger?: number): Promise<void> {
      try {
        const pipeline = redis.pipeline();
        pipeline.incr(`chain:gen:${tag}`);
        if (atLedger !== undefined) {
          pipeline.set(`chain:minLedger:${tag}`, atLedger.toString());
        }
        await pipeline.exec();
      } catch (err) {
        await fallback.invalidateTag(tag, atLedger);
      }
    },

    async get<T>(
      key: string,
      opts: { ttlMs: number; tags: string[] },
      load: () => Promise<{ value: T; ledger: number }>,
    ): Promise<CacheEntry<T> & { cached: boolean }> {
      if (inFlight.has(key)) {
        coalesced++;
        return inFlight.get(key)!;
      }

      const execute = async (): Promise<CacheEntry<T> & { cached: boolean }> => {
        let rawCache: string | null = null;
        try {
          rawCache = await redis.get(key);
        } catch (err) {
          const now = Date.now();
          if (now - lastRedisCacheLog > 60_000) {
            logger.warn({ err }, 'Redis chain cache unreachable; bypassing cache');
            lastRedisCacheLog = now;
          }
          const loaded = await load();
          return { value: loaded.value, ledger: loaded.ledger, readAt: Date.now(), gen: 0, cached: false };
        }

        const now = Date.now();
        if (rawCache) {
          try {
            const parsed = JSON.parse(rawCache);
            let valid = true;

            if (opts.tags.length > 0) {
              const genKeys = opts.tags.map((t) => `chain:gen:${t}`);
              const currentGens = await redis.mget(...genKeys);
              for (let i = 0; i < opts.tags.length; i++) {
                const tag = opts.tags[i];
                const currentGen = parseInt(currentGens[i] ?? '0', 10);
                const recordedGen = parsed.tagGens?.[tag] ?? 0;
                if (currentGen > recordedGen) {
                  valid = false;
                  break;
                }
              }
            }

            if (valid) {
              if (parsed.isNegativeError) {
                hits++;
                throw new ChainError(
                  parsed.errorPayload?.message ?? 'Negative cached contract error',
                  parsed.errorPayload?.contractError ?? null,
                );
              }
              hits++;
              return {
                value: decode<T>(parsed.encodedValue),
                ledger: parsed.ledger,
                readAt: parsed.readAt,
                gen: 0,
                cached: true,
              };
            }
          } catch (err) {
            if (err instanceof ChainError) throw err;
          }
        }

        misses++;

        // Cross-instance single-flight lock
        const lockKey = `chain:lock:${key}`;
        const token = crypto.randomUUID();
        let acquiredLock = false;
        try {
          const lockRes = await redis.set(lockKey, token, 'PX', 5000, 'NX');
          acquiredLock = lockRes === 'OK';
        } catch {}

        if (!acquiredLock) {
          const waitLimit = config.CHAIN_CACHE_WAIT_MS;
          const startWait = Date.now();
          while (Date.now() - startWait < waitLimit) {
            await new Promise((r) => setTimeout(r, 100));
            try {
              const maybeUpdated = await redis.get(key);
              if (maybeUpdated) {
                const parsed = JSON.parse(maybeUpdated);
                coalesced++;
                return {
                  value: decode<T>(parsed.encodedValue),
                  ledger: parsed.ledger,
                  readAt: parsed.readAt,
                  gen: 0,
                  cached: true,
                };
              }
            } catch {}
          }
        }

        try {
          const loaded = await load();
          const currentTagGens: Record<string, number> = {};
          let minLedgerAllowed = 0;

          if (opts.tags.length > 0) {
            const genKeys = opts.tags.map((t) => `chain:gen:${t}`);
            const minKeys = opts.tags.map((t) => `chain:minLedger:${t}`);
            const [genVals, minVals] = await Promise.all([
              redis.mget(...genKeys),
              redis.mget(...minKeys),
            ]);
            for (let i = 0; i < opts.tags.length; i++) {
              const tag = opts.tags[i];
              currentTagGens[tag] = parseInt(genVals[i] ?? '0', 10);
              const ml = parseInt(minVals[i] ?? '0', 10);
              if (ml > minLedgerAllowed) minLedgerAllowed = ml;
            }
          }

          if (minLedgerAllowed > 0 && loaded.ledger < minLedgerAllowed) {
            staleRejects++;
            return {
              value: loaded.value,
              ledger: loaded.ledger,
              readAt: now,
              gen: 0,
              cached: false,
            };
          }

          // Check if an existing entry has a newer ledger
          if (rawCache) {
            try {
              const prev = JSON.parse(rawCache);
              if (prev.ledger > loaded.ledger) {
                staleRejects++;
                return {
                  value: loaded.value,
                  ledger: loaded.ledger,
                  readAt: now,
                  gen: 0,
                  cached: false,
                };
              }
            } catch {}
          }

          const entryData = {
            encodedValue: encode(loaded.value),
            ledger: loaded.ledger,
            readAt: now,
            tagGens: currentTagGens,
          };

          await redis.set(key, JSON.stringify(entryData), 'PX', opts.ttlMs);

          return {
            value: loaded.value,
            ledger: loaded.ledger,
            readAt: now,
            gen: 0,
            cached: false,
          };
        } catch (err) {
          if (err instanceof ChainError && err.contractError) {
            const currentTagGens: Record<string, number> = {};
            try {
              if (opts.tags.length > 0) {
                const genKeys = opts.tags.map((t) => `chain:gen:${t}`);
                const genVals = await redis.mget(...genKeys);
                for (let i = 0; i < opts.tags.length; i++) {
                  currentTagGens[opts.tags[i]] = parseInt(genVals[i] ?? '0', 10);
                }
              }
              const negEntry = {
                isNegativeError: true,
                errorPayload: { message: err.message, contractError: err.contractError },
                ledger: 0,
                readAt: now,
                tagGens: currentTagGens,
              };
              await redis.set(key, JSON.stringify(negEntry), 'PX', config.CHAIN_CACHE_NEG_TTL_MS);
            } catch {}
          }
          throw err;
        } finally {
          if (acquiredLock) {
            redis.del(lockKey).catch(() => {});
          }
        }
      };

      const promise = execute().finally(() => inFlight.delete(key));
      inFlight.set(key, promise);
      return promise;
    },

    stats() {
      return { hits, misses, coalesced, staleRejects };
    },
  };
}
