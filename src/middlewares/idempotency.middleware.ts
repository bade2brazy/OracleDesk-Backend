import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { canonicalJson, sha256Hex } from '../utils/hash.util';
import { sendError } from '../utils/response.util';

/**
 * Idempotency-Key support for state-changing endpoints (#123), following
 * draft-ietf-httpapi-idempotency-key-header (the same model Stripe uses).
 *
 * The client sends a unique `Idempotency-Key` per logical operation and reuses
 * it on retries. The first request with a key owns it; its final response is
 * stored and replayed for exact repeats (`Idempotent-Replayed: true`). Reusing
 * a key with a different request is 422 `IDEMPOTENCY_KEY_MISMATCH`. A repeat
 * while the first is still running is 409 `IDEMPOTENCY_IN_PROGRESS` with
 * `Retry-After`. A request that crashed mid-flight leaves a lock that expires
 * after `lockSeconds`, after which a retry takes the key over.
 *
 * Keys are scoped by (userId or "anon", method, route template, key), so the
 * same key on another route or from another user never collides.
 *
 * Must run after auth (it scopes by `req.user`) and after body parsing.
 */

export const IDEMPOTENCY_HEADER = 'Idempotency-Key';
export const REPLAYED_HEADER = 'Idempotent-Replayed';

const DEFAULT_TTL_HOURS = 24;
/** Must exceed the slowest guarded handler (POST /traces/verify fetches IPFS with a 20s timeout). */
const DEFAULT_LOCK_SECONDS = 60;
const MAX_STORED_BODY_BYTES = 64 * 1024;
/** Printable ASCII, 1–255 chars (the draft recommends a UUID). */
const KEY_PATTERN = /^[\x20-\x7E]{1,255}$/;
/** Only these response headers are stored and replayed. Never Set-Cookie / Authorization. */
const REPLAY_HEADER_ALLOWLIST = ['content-type', 'location', 'api-version'];
/** Same spirit as the pino redact list in src/lib/logger.ts. */
const REDACT_KEY_PATTERN = /token|secret|authorization|password|private.?key/i;
const TOO_LARGE_MARKER = { __idempotencyResponseTooLarge: true } as const;

export type IdempotencyStatus = 'IN_PROGRESS' | 'COMPLETED';

export interface IdempotencyRecord {
  id: string;
  fingerprint: string;
  status: IdempotencyStatus;
  lockedUntil: Date;
  expiresAt: Date;
  responseCode: number | null;
  responseBody: unknown;
  responseHeaders: Record<string, string> | null;
}

export interface IdempotencyScope {
  scope: string;
  method: string;
  route: string;
  key: string;
}

/** Storage behind the middleware. Postgres in production; swappable in tests. */
export interface IdempotencyStore {
  /** Insert an IN_PROGRESS row. Returns its id, or null if the key already exists. */
  claim(s: IdempotencyScope, row: { id: string; fingerprint: string; lockedUntil: Date; expiresAt: Date }): Promise<string | null>;
  find(s: IdempotencyScope): Promise<IdempotencyRecord | null>;
  /**
   * Take over a row whose owner is gone: an IN_PROGRESS row with an expired
   * lock, or any row past `expiresAt`. Conditional, so only one retry wins.
   */
  takeOver(id: string, row: { fingerprint: string; lockedUntil: Date; expiresAt: Date }, now: Date): Promise<boolean>;
  complete(id: string, code: number, body: unknown, headers: Record<string, string>): Promise<void>;
  release(id: string): Promise<void>;
  /** Delete up to `batchSize` expired rows; returns how many were deleted. */
  purgeExpired(now: Date, batchSize: number): Promise<number>;
}

/**
 * Postgres store. Everything goes through raw SQL: the `ON CONFLICT DO NOTHING`
 * insert is the only synchronization point between instances (no in-memory
 * map), and the conditional UPDATE makes stale-lock takeover race-free.
 */
export const postgresIdempotencyStore: IdempotencyStore = {
  async claim(s, row) {
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO "idempotency_keys"
        ("id", "scope", "method", "route", "key", "fingerprint", "status", "lockedUntil", "expiresAt")
      VALUES
        (${row.id}, ${s.scope}, ${s.method}, ${s.route}, ${s.key}, ${row.fingerprint}, 'IN_PROGRESS', ${row.lockedUntil}, ${row.expiresAt})
      ON CONFLICT ("scope", "method", "route", "key") DO NOTHING
      RETURNING "id"`;
    return rows[0]?.id ?? null;
  },
  async find(s) {
    const rows = await prisma.$queryRaw<IdempotencyRecord[]>`
      SELECT "id", "fingerprint", "status", "lockedUntil", "expiresAt",
             "responseCode", "responseBody", "responseHeaders"
      FROM "idempotency_keys"
      WHERE "scope" = ${s.scope} AND "method" = ${s.method} AND "route" = ${s.route} AND "key" = ${s.key}`;
    return rows[0] ?? null;
  },
  async takeOver(id, row, now) {
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      UPDATE "idempotency_keys"
      SET "fingerprint" = ${row.fingerprint}, "status" = 'IN_PROGRESS',
          "lockedUntil" = ${row.lockedUntil}, "expiresAt" = ${row.expiresAt},
          "responseCode" = NULL, "responseBody" = NULL, "responseHeaders" = NULL
      WHERE "id" = ${id}
        AND (("status" = 'IN_PROGRESS' AND "lockedUntil" < ${now}) OR "expiresAt" < ${now})
      RETURNING "id"`;
    return rows.length > 0;
  },
  async complete(id, code, body, headers) {
    await prisma.$executeRaw`
      UPDATE "idempotency_keys"
      SET "status" = 'COMPLETED', "responseCode" = ${code},
          "responseBody" = ${JSON.stringify(body ?? null)}::jsonb,
          "responseHeaders" = ${JSON.stringify(headers)}::jsonb
      WHERE "id" = ${id}`;
  },
  async release(id) {
    await prisma.$executeRaw`DELETE FROM "idempotency_keys" WHERE "id" = ${id}`;
  },
  async purgeExpired(now, batchSize) {
    return prisma.$executeRaw`
      DELETE FROM "idempotency_keys"
      WHERE "id" IN (
        SELECT "id" FROM "idempotency_keys" WHERE "expiresAt" < ${now} LIMIT ${batchSize}
      )`;
  },
};

let store: IdempotencyStore = postgresIdempotencyStore;

/** Test seam: swap the store and get the previous one back. */
export function setIdempotencyStore(next: IdempotencyStore): IdempotencyStore {
  const prev = store;
  store = next;
  return prev;
}

/** Recursively replace values under sensitive-looking keys. Defence in depth. */
export function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEY_PATTERN.test(k) ? '[redacted]' : redactSensitive(v);
    }
    return out;
  }
  return value;
}

function routeTemplate(req: Request): string {
  // Route-level middleware runs after matching, so req.route is the template
  // ("/copy/:id/confirm"), not the concrete path.
  const path = (req.route as { path?: string } | undefined)?.path ?? req.path;
  return `${req.baseUrl}${path}`;
}

export function requestFingerprint(req: Request, route: string): string {
  return sha256Hex(
    canonicalJson({
      method: req.method,
      route,
      params: req.params ?? {},
      // Parsed object, so parameter order doesn't change the fingerprint.
      query: req.query ?? {},
      body: req.body ?? null,
    }),
  );
}

function replay(res: Response, record: IdempotencyRecord): void {
  if (
    record.responseBody !== null &&
    typeof record.responseBody === 'object' &&
    (record.responseBody as Record<string, unknown>).__idempotencyResponseTooLarge
  ) {
    sendError(res, 409, 'IDEMPOTENCY_RESPONSE_UNAVAILABLE', 'The original response was too large to store; retry with a new Idempotency-Key');
    return;
  }
  for (const [name, value] of Object.entries(record.responseHeaders ?? {})) {
    if (REPLAY_HEADER_ALLOWLIST.includes(name.toLowerCase())) res.setHeader(name, value);
  }
  res.setHeader(REPLAYED_HEADER, 'true');
  res.status(record.responseCode ?? 200).json(record.responseBody);
}

/** Capture the final response, then store it (2xx/4xx) or release the key (5xx). */
function captureAndStore(res: Response, id: string): void {
  let body: unknown;
  const originalJson = res.json.bind(res);
  res.json = ((payload: unknown) => {
    body = payload;
    return originalJson(payload);
  }) as Response['json'];

  res.on('finish', () => {
    const code = res.statusCode;
    // Transient server errors stay retryable: drop the key instead of caching.
    if (code >= 500) {
      store.release(id).catch((err) => logger.error({ err, id }, 'Idempotency: failed to release key'));
      return;
    }
    const headers: Record<string, string> = {};
    for (const name of REPLAY_HEADER_ALLOWLIST) {
      const value = res.getHeader(name);
      if (value !== undefined) headers[name] = String(value);
    }
    const redacted = redactSensitive(body ?? null);
    const size = Buffer.byteLength(JSON.stringify(redacted) ?? 'null', 'utf8');
    const stored = size > MAX_STORED_BODY_BYTES ? TOO_LARGE_MARKER : redacted;
    store.complete(id, code, stored, headers).catch((err) => logger.error({ err, id }, 'Idempotency: failed to store response'));
  });
}

export function idempotent(opts: { required?: boolean; ttlHours?: number; lockSeconds?: number } = {}): RequestHandler {
  const ttlMs = (opts.ttlHours ?? DEFAULT_TTL_HOURS) * 3_600_000;
  const lockMs = (opts.lockSeconds ?? DEFAULT_LOCK_SECONDS) * 1_000;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const header = req.get(IDEMPOTENCY_HEADER);
    if (header === undefined) {
      if (opts.required) {
        sendError(res, 400, 'IDEMPOTENCY_KEY_REQUIRED', `This endpoint requires an ${IDEMPOTENCY_HEADER} header`);
        return;
      }
      next();
      return;
    }
    const key = header.trim();
    if (!KEY_PATTERN.test(key)) {
      sendError(res, 400, 'IDEMPOTENCY_KEY_INVALID', `${IDEMPOTENCY_HEADER} must be 1–255 printable ASCII characters`);
      return;
    }

    const route = routeTemplate(req);
    const scope: IdempotencyScope = { scope: req.user?.userId ?? 'anon', method: req.method, route, key };
    const fingerprint = requestFingerprint(req, route);
    const now = new Date();
    const row = { fingerprint, lockedUntil: new Date(now.getTime() + lockMs), expiresAt: new Date(now.getTime() + ttlMs) };

    try {
      const claimedId = await store.claim(scope, { id: uuidv4(), ...row });
      if (claimedId) {
        captureAndStore(res, claimedId);
        next();
        return;
      }

      const existing = await store.find(scope);
      if (!existing) {
        // Purged between our insert and read; treat as a transient conflict.
        res.setHeader('Retry-After', '1');
        sendError(res, 409, 'IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is in progress');
        return;
      }

      const expired = existing.expiresAt.getTime() < now.getTime();
      if (!expired && existing.fingerprint !== fingerprint) {
        sendError(res, 422, 'IDEMPOTENCY_KEY_MISMATCH', 'This Idempotency-Key was already used with a different request');
        return;
      }

      if (!expired && existing.status === 'COMPLETED') {
        replay(res, existing);
        return;
      }

      const stale = expired || existing.lockedUntil.getTime() < now.getTime();
      if (stale && (await store.takeOver(existing.id, row, now))) {
        captureAndStore(res, existing.id);
        next();
        return;
      }

      res.setHeader('Retry-After', '1');
      sendError(res, 409, 'IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is in progress');
    } catch (err) {
      next(err);
    }
  };
}

/** Delete expired keys in batches (scheduled from monitor.cron.ts). */
export async function purgeExpiredIdempotencyKeys(batchSize = 5_000, maxBatches = 100): Promise<number> {
  let total = 0;
  for (let i = 0; i < maxBatches; i++) {
    const deleted = await store.purgeExpired(new Date(), batchSize);
    total += deleted;
    if (deleted < batchSize) break;
  }
  return total;
}
