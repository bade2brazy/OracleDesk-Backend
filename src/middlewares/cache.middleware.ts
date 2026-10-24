import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { sha256Hex, canonicalJson } from '../utils/hash.util';
import { checkAccess } from '../services/subscription.service';

export type CachePolicy =
  | { kind: 'immutable'; maxAge: number }
  | { kind: 'shared'; maxAge: number; swr: number }
  | { kind: 'personalised'; maxAge: number }
  | { kind: 'no-store' };

const POLICY_VERSION = 'v1';

export function checkETagMatch(ifNoneMatch: string, etag: string): boolean {
  if (ifNoneMatch.trim() === '*') return true;
  const targetClean = etag.replace(/^W\//, '').trim();
  const list = ifNoneMatch.split(',').map((s) => s.trim().replace(/^W\//, ''));
  return list.includes(targetClean);
}

export async function authClass(req: Request): Promise<string> {
  const user = (req as any).user;
  if (!user?.userId) {
    if (req.headers.authorization) return 'auth-header';
    return 'anon';
  }

  const traceId = req.params.id;
  if (traceId) {
    try {
      const access = await checkAccess(user.userId, traceId);
      if (access.hasAccess) return 'pass';
    } catch {}
  }

  return `user:${user.userId}`;
}

export function cachePolicy(
  policyInput: CachePolicy | ((req: Request, res: Response) => CachePolicy | Promise<CachePolicy>),
): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const policy: CachePolicy =
        typeof policyInput === 'function' ? await policyInput(req, res) : policyInput;
      res.locals.cachePolicy = policy;

      // Intercept response headers
      const originalWriteHead = res.writeHead;
      res.writeHead = function (this: Response, statusCode: number, ...args: any[]) {
        const is2xx = statusCode >= 200 && statusCode < 300;
        const hasAuth = Boolean(req.headers.authorization);

        if (!is2xx) {
          res.setHeader('Cache-Control', 'private, no-store');
        } else {
          // If request carried Authorization, it must NEVER get a public Cache-Control
          if (policy.kind === 'no-store') {
            res.setHeader('Cache-Control', 'private, no-store');
          } else if (policy.kind === 'personalised' || hasAuth) {
            const maxAge = policy.kind === 'personalised' ? policy.maxAge : 0;
            if (maxAge === 0) {
              res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
            } else {
              res.setHeader('Cache-Control', `private, max-age=${maxAge}`);
            }
            res.append('Vary', 'Authorization');
          } else if (policy.kind === 'immutable') {
            res.setHeader('Cache-Control', `public, max-age=${policy.maxAge}, immutable`);
          } else if (policy.kind === 'shared') {
            res.setHeader(
              'Cache-Control',
              `public, max-age=${policy.maxAge}, stale-while-revalidate=${policy.swr}`,
            );
          }

          res.append('Vary', 'Accept-Encoding');
          res.append('Vary', 'Origin');

          // Handle compression suffix on ETag
          const encoding = res.getHeader('Content-Encoding');
          if (encoding && typeof encoding === 'string') {
            const etag = res.getHeader('ETag');
            if (typeof etag === 'string' && !etag.endsWith(`-${encoding}"`)) {
              res.setHeader('ETag', etag.replace(/"$/, `-${encoding}"`));
            }
          }
        }

        return (originalWriteHead as any).apply(this, [statusCode, ...args]);
      };

      next();
    } catch (err) {
      next(err);
    }
  };
}

export function noStore(): RequestHandler {
  return cachePolicy({ kind: 'no-store' });
}

export function validator(compute: (req: Request) => Promise<string | null>): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const version = await compute(req);
      if (version === null) {
        return next();
      }

      const cls = await authClass(req);
      const rawHash = sha256Hex(`${POLICY_VERSION}|${cls}|${version}`);
      const etag = `"${rawHash}"`;
      res.locals.validatorEtag = etag;

      const ifNoneMatch = req.headers['if-none-match'];
      if (ifNoneMatch && checkETagMatch(ifNoneMatch, etag)) {
        res.setHeader('ETag', etag);
        const policy: CachePolicy = res.locals.cachePolicy ?? { kind: 'shared', maxAge: 5, swr: 30 };
        const hasAuth = Boolean(req.headers.authorization);

        if (policy.kind === 'no-store') {
          res.setHeader('Cache-Control', 'private, no-store');
        } else if (policy.kind === 'personalised' || hasAuth) {
          const maxAge = policy.kind === 'personalised' ? policy.maxAge : 0;
          if (maxAge === 0) {
            res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
          } else {
            res.setHeader('Cache-Control', `private, max-age=${maxAge}`);
          }
          res.append('Vary', 'Authorization');
        } else if (policy.kind === 'immutable') {
          res.setHeader('Cache-Control', `public, max-age=${policy.maxAge}, immutable`);
        } else if (policy.kind === 'shared') {
          res.setHeader(
            'Cache-Control',
            `public, max-age=${policy.maxAge}, stale-while-revalidate=${policy.swr}`,
          );
        }

        res.append('Vary', 'Accept-Encoding');
        res.append('Vary', 'Origin');
        res.status(304).end();
        return;
      }

      res.setHeader('ETag', etag);
      next();
    } catch (err) {
      next(err);
    }
  };
}
