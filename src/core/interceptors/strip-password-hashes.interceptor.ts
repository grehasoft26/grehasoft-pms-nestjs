import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable, map } from 'rxjs';

/** Login password hash formats stored on users (bcrypt, migrated Django pbkdf2_sha256). */
const PASSWORD_HASH_PATTERN = /^(\$2[abxy]?\$\d{2}\$[./A-Za-z0-9]{53}|pbkdf2_sha256\$\d+\$[^$]+\$[^$]+)$/;

export const isPasswordHash = (value: unknown): boolean =>
  typeof value === 'string' && PASSWORD_HASH_PATTERN.test(value);

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * Removes user login password hashes from response bodies.
 * Several services return Prisma rows with `include: { user: true }` (and similar), which
 * would otherwise expose `password` hashes. Only `password` fields whose value is a login
 * hash are removed; encrypted infrastructure/credential passwords use other formats and are
 * left as they are. Plain objects and arrays are copied; other values (Buffers, streams,
 * Dates, Decimals) are returned unchanged.
 */
export function stripPasswordHashes<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (Array.isArray(value)) {
    if (seen.has(value)) return value;
    seen.add(value);
    return value.map((item) => stripPasswordHashes(item, seen)) as unknown as T;
  }
  if (!isPlainObject(value)) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    if (key === 'password' && isPasswordHash(val)) continue;
    out[key] = stripPasswordHashes(val, seen);
  }
  return out as T;
}

@Injectable()
export class StripPasswordHashesInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((body) => stripPasswordHashes(body)));
  }
}
