# Credential encryption keys

`CredentialCryptoService` (`src/core/credential-crypto.service.ts`) encrypts Credential Vault
secrets with AES-256-GCM. **If every copy of a key is lost, every secret encrypted with it is
lost permanently.** Database backups cannot recover them.

## Format

```
gcm1:<keyVersion>:<iv base64url>:<tag base64url>:<ciphertext base64url>
```

- A new random 12-byte IV for every encryption, 16-byte authentication tag.
- Authenticated data binds each value to `table`, `field` and (when given) the record id.
  A value copied to another row or column fails to decrypt.
- Any tampering, a wrong key or a wrong record context throws `CredentialCryptoError`.
  The service never returns the stored value or plaintext on failure.

## Configuration

| Variable | Value |
|---|---|
| `CREDENTIAL_KEYS` | `<version>:<base64 32 bytes>`, comma-separated, e.g. `1:<key>,2:<key>` |
| `CREDENTIAL_ACTIVE_KEY_VERSION` | Version used for new encryptions; must be listed above |
| `CREDENTIAL_LEGACY_DJANGO_SECRET_KEY` | Optional. Old Django `SECRET_KEY`, only to read legacy Fernet values |

These keys are separate from `SECRET_KEY`, `JWT_SECRET` and `INVOICE_LINK_SECRET`; never reuse
those values. There is no fallback key.

**Startup requirement.** `CREDENTIAL_KEYS` and `CREDENTIAL_ACTIVE_KEY_VERSION` must be set and
valid in every environment, or the backend refuses to start: `CredentialCryptoService` validates
them during application initialisation and throws `KEY_CONFIG` before the server listens. Invalid
means: either variable missing or blank, an entry not in `<version>:<key>` form or with a bad
version label, a key that is not base64 of exactly 32 bytes, a duplicate version, or an active
version that is not listed. The error names the problem, never the key material. Each
encrypt/decrypt still re-checks the configuration. The optional legacy keys (`SECRET_KEY` for
legacy CBC values, `CREDENTIAL_LEGACY_DJANGO_SECRET_KEY`) are not checked at startup; reading a
legacy value without its key fails for that value only.

Deployment prerequisite: provision both variables in the target environment's secret store before
deploying a build that contains this check, otherwise the new release will not boot.

## Generating a key

Generate on a trusted machine, once per version, and do not paste it into chat, tickets or logs:

```
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

## Storage

- **Local development:** a development-only key in your own `.env` (never committed). Never
  use a production key locally.
- **Production:** the hosting platform's secret store / environment settings, readable only by
  the application and the people who deploy it. Not in the repository, deploy scripts, or the
  same location as database backups.
- **Offline escrow:** keep every key version that still protects data in a company password
  manager (or sealed offline copy) with at least two named people able to recover it.
  Record the version label with each key.

## Recovery

1. Restore `CREDENTIAL_KEYS` with every version still referenced by stored values
   (the version is the second field of each `gcm1` value).
2. Set `CREDENTIAL_ACTIVE_KEY_VERSION` and restart.
3. Verify by decrypting one known test credential.

Restoring a database backup requires the keys that were active when it was taken.

## Rotation

1. Generate a new key and add it with a new version: `CREDENTIAL_KEYS=1:<old>,2:<new>`.
2. Escrow the new key, then set `CREDENTIAL_ACTIVE_KEY_VERSION=2` and deploy. New writes use v2;
   v1 values still decrypt.
3. Re-encrypt stored v1 values (`needsReEncryption()` identifies them) and confirm none remain.
4. Only then remove v1 from `CREDENTIAL_KEYS`. Keep the escrowed v1 until no backup that
   still needs it is retained.

## Legacy formats (read only)

| Format | Shape | Key | Supported |
|---|---|---|---|
| `legacy-cbc-secret-key` (`EncryptionService`) | `ivhex:cthex` | SHA-256 of `SECRET_KEY` | Yes, if `SECRET_KEY` is the value used when the data was written |
| `legacy-cbc-static` (`InfrastructureService`, `SeoService`) | bare hex | Constant key/IV in source | Yes |
| `legacy-fernet` (Django) | `gAAAAA…` | SHA-256 of the Django `SECRET_KEY` | Yes, only if `CREDENTIAL_LEGACY_DJANGO_SECRET_KEY` is set to the original value |

CBC formats are not authenticated. Padding and strict UTF-8 checks reject most wrong-key or
non-ciphertext input, but cannot prove a value is genuine; review migrated values. Values
written with `EncryptionService`'s hardcoded fallback key (when `SECRET_KEY` was unset) are
deliberately not read.
