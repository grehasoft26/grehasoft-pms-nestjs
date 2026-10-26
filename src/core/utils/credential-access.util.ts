import { ServiceUnavailableException, UnprocessableEntityException } from '@nestjs/common';
import { CredentialCryptoError } from '../credential-crypto.service';
import { getActiveRolePermissions, isSuperAdmin } from './role-access.util';

/**
 * Reveal rule shared by every Credential Vault store, same as PermissionsGuard would apply:
 * super admins, or an active role granting REVEAL_CREDENTIALS. Checked in services (not the
 * guard) so refused reveal attempts can be audited.
 */
export const canRevealCredentials = (user: any): boolean =>
  isSuperAdmin(user) || getActiveRolePermissions(user).includes('REVEAL_CREDENTIALS');

/**
 * Credential metadata (website-credential and server records: usernames, admin/cPanel URLs, FTP
 * hosts, emails, IPs) is readable with any one of these permissions, then still limited to the
 * caller's projects by the services. Secrets are never part of metadata responses.
 */
export const CREDENTIAL_METADATA_PERMISSIONS = [
  'MANAGE_INFRASTRUCTURE',
  'MANAGE_CREDENTIALS',
  'REVEAL_CREDENTIALS',
] as const;

/** Same decision PermissionsGuard makes for @Permissions(...CREDENTIAL_METADATA_PERMISSIONS). */
export const canReadCredentialMetadata = (user: any): boolean => {
  if (isSuperAdmin(user)) return true;
  const held = getActiveRolePermissions(user);
  return CREDENTIAL_METADATA_PERMISSIONS.some((p) => held.includes(p));
};

/** Maps CredentialCryptoError to HTTP errors without exposing stored values; other errors pass through. */
export const credentialCryptoHttpError = (error: unknown): unknown => {
  if (!(error instanceof CredentialCryptoError)) return error;
  if (error.code === 'KEY_CONFIG' || error.code === 'LEGACY_KEY_UNAVAILABLE') {
    return new ServiceUnavailableException('Credential encryption is not configured on the server.');
  }
  return new UnprocessableEntityException('The stored password could not be decrypted safely and needs manual review.');
};
