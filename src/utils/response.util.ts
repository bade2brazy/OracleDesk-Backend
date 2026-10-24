import type { Response } from 'express';
import { currentContext } from '../lib/context';
import type { ApiResponse, ApiError, PaginationMeta } from '../types';
import { canonicalJson, sha256Hex } from './hash.util';
import { checkETagMatch } from '../middlewares/cache.middleware';

/**
 * Send a successful 2xx response
 */
export function sendSuccess<T>(
  res: Response,
  data: T,
  statusCode = 200,
  meta?: Record<string, unknown>,
): void {
  const body: ApiResponse<T> = { ok: true, data, error: null, meta };

  const policy = res.locals?.cachePolicy;
  if (policy && policy.kind !== 'no-store') {
    let etag = res.getHeader('ETag');
    if (!etag) {
      const hash = sha256Hex(canonicalJson(body));
      etag = `"${hash}"`;
      res.setHeader('ETag', etag);
    }

    const ifNoneMatch = res.req?.headers['if-none-match'];
    if (ifNoneMatch && checkETagMatch(ifNoneMatch, String(etag))) {
      res.status(304).end();
      return;
    }
  }

  res.status(statusCode).json(body);
}

/**
 * Send an error response
 */
export function sendError(
  res: Response,
  statusCode: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): void {
  // The header is set first in the chain, so it survives lost async context.
  const header = res.getHeader('X-Request-Id');
  const requestId = typeof header === 'string' ? header : currentContext()?.requestId;
  const error: ApiError = { code, message, details, requestId };
  const body: ApiResponse<null> = { ok: false, data: null, error };
  res.status(statusCode).json(body);
}

/**
 * Build a pagination meta object
 */
export function buildPaginationMeta(
  page: number,
  limit: number,
  total: number,
): PaginationMeta {
  return { page, limit, total, totalPages: Math.ceil(total / limit) };
}

/**
 * Parse pagination query params with safe defaults
 */
export function parsePagination(query: Record<string, unknown>): {
  page: number;
  limit: number;
  skip: number;
} {
  const page = Math.max(1, parseInt(String(query.page ?? '1'), 10));
  const limit = Math.min(100, Math.max(1, parseInt(String(query.limit ?? '20'), 10)));
  return { page, limit, skip: (page - 1) * limit };
}