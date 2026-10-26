/**
 * The JWT signing/verification secret, from JWT_SECRET only. There is no fallback: a missing or
 * blank value throws, and because both JwtModule (AuthModule) and JwtStrategy read it while the
 * application is created, the server refuses to start instead of running with a guessable secret.
 * The value is returned unchanged (not trimmed) so existing tokens stay valid; it is never logged
 * or included in error messages.
 */
export const JWT_SECRET_MISSING_MESSAGE =
  'JWT_SECRET is not configured. Set a strong random value in the environment; the server does not start without it.';

export function requireJwtSecret(config: { get<T = any>(key: string): T | undefined }): string {
  const value = config.get<string>('JWT_SECRET');
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(JWT_SECRET_MISSING_MESSAGE);
  }
  return value;
}
