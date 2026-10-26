import * as crypto from 'crypto';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { CredentialAad, CredentialCryptoError, CredentialCryptoService } from './credential-crypto.service';
import { EncryptionService } from './encryption.service';

/**
 * Keys are random per test run and fixtures use made-up values only; no real secret is used.
 * Legacy fixtures come from the existing implementations, so reads are checked against what
 * the application actually stores.
 */
const newKey = () => crypto.randomBytes(32).toString('base64');
const K1 = newKey();
const K2 = newKey();

const configOf = (env: Record<string, string | undefined>) => ({ get: (k: string) => env[k] }) as unknown as ConfigService;
const serviceWith = (env: Record<string, string | undefined>) => new CredentialCryptoService(configOf(env));
const v1Only = () => serviceWith({ CREDENTIAL_KEYS: `1:${K1}`, CREDENTIAL_ACTIVE_KEY_VERSION: '1' });

const AAD: CredentialAad = { table: 'company_credentials', field: 'password', recordId: 7 };
const SECRET = 'S3cret!-pässwörd €';

const expectCode = (fn: () => unknown, code: string) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(CredentialCryptoError);
    expect((error as CredentialCryptoError).code).toBe(code);
    return error as CredentialCryptoError;
  }
  throw new Error(`expected CredentialCryptoError ${code}`);
};

/** Re-encodes one base64url segment of a gcm1 value after flipping a bit in it. */
const flipSegment = (stored: string, index: number) => {
  const parts = stored.split(':');
  const bytes = Buffer.from(parts[index], 'base64url');
  bytes[0] ^= 0x01;
  parts[index] = bytes.toString('base64url');
  return parts.join(':');
};

describe('CredentialCryptoService', () => {
  describe('AES-256-GCM round trip', () => {
    it('encrypts to the gcm1 format and decrypts back', () => {
      const svc = v1Only();
      const stored = svc.encrypt(SECRET, AAD);
      const [prefix, version, iv, tag, ct] = stored.split(':');
      expect(prefix).toBe('gcm1');
      expect(version).toBe('1');
      expect(Buffer.from(iv, 'base64url')).toHaveLength(12);
      expect(Buffer.from(tag, 'base64url')).toHaveLength(16);
      expect(ct).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(stored).not.toContain(SECRET);
      expect(svc.decrypt(stored, AAD)).toBe(SECRET);
    });

    it('round-trips the empty string', () => {
      const svc = v1Only();
      expect(svc.decrypt(svc.encrypt('', AAD), AAD)).toBe('');
    });

    it('uses a fresh IV every time, so equal inputs never produce equal values', () => {
      const svc = v1Only();
      const values = Array.from({ length: 50 }, () => svc.encrypt(SECRET, AAD));
      expect(new Set(values).size).toBe(50);
      expect(new Set(values.map((v) => v.split(':')[2])).size).toBe(50);
    });

    it('works without a recordId when the caller has none yet', () => {
      const svc = v1Only();
      const aad = { table: 'servers', field: 'password' };
      expect(svc.decrypt(svc.encrypt(SECRET, aad), aad)).toBe(SECRET);
    });
  });

  describe('tampering and wrong context are rejected', () => {
    const svc = v1Only();
    const stored = svc.encrypt(SECRET, AAD);

    it.each([
      ['IV', 2],
      ['authentication tag', 3],
      ['ciphertext', 4],
    ])('rejects a modified %s', (_label, index) => {
      expectCode(() => svc.decrypt(flipSegment(stored, index as number), AAD), 'AUTH_FAILED');
    });

    it('rejects a different record id, field or table (AAD mismatch)', () => {
      expectCode(() => svc.decrypt(stored, { ...AAD, recordId: 8 }), 'AUTH_FAILED');
      expectCode(() => svc.decrypt(stored, { ...AAD, field: 'notes' }), 'AUTH_FAILED');
      expectCode(() => svc.decrypt(stored, { ...AAD, table: 'servers' }), 'AUTH_FAILED');
    });

    it('rejects the right version label with the wrong key', () => {
      const other = serviceWith({ CREDENTIAL_KEYS: `1:${K2}`, CREDENTIAL_ACTIVE_KEY_VERSION: '1' });
      expectCode(() => other.decrypt(stored, AAD), 'AUTH_FAILED');
    });

    it('rejects a value relabelled to another configured version', () => {
      const both = serviceWith({ CREDENTIAL_KEYS: `1:${K1},2:${K2}`, CREDENTIAL_ACTIVE_KEY_VERSION: '2' });
      expectCode(() => both.decrypt(stored.replace(/^gcm1:1:/, 'gcm1:2:'), AAD), 'AUTH_FAILED');
    });

    it('rejects malformed values', () => {
      const [, , iv, tag, ct] = stored.split(':');
      const shortIv = Buffer.alloc(8).toString('base64url');
      const shortTag = Buffer.alloc(12).toString('base64url');
      for (const bad of [
        '',
        'plain-text-password',
        `gcm2:1:${iv}:${tag}:${ct}`,
        `gcm1:1:${iv}:${tag}`,
        `gcm1:1:${iv}:${tag}:${ct}:extra`,
        `gcm1::${iv}:${tag}:${ct}`,
        `gcm1:1:${shortIv}:${tag}:${ct}`,
        `gcm1:1:${iv}:${shortTag}:${ct}`,
        `gcm1:1:${iv}:${tag}:${ct}+/`,
      ]) {
        expectCode(() => svc.decrypt(bad, AAD), 'MALFORMED');
      }
    });

    it('rejects an unknown key version explicitly', () => {
      expectCode(() => svc.decrypt(stored.replace(/^gcm1:1:/, 'gcm1:9:'), AAD), 'UNKNOWN_KEY_VERSION');
    });

    it('requires table and field names for AAD', () => {
      expectCode(() => svc.encrypt(SECRET, { table: '', field: 'password' }), 'INVALID_INPUT');
      expectCode(() => svc.encrypt(SECRET, { table: 'servers', field: 'pass word' }), 'INVALID_INPUT');
      expectCode(() => svc.encrypt(SECRET, { table: 'servers', field: 'password', recordId: '1:2' }), 'INVALID_INPUT');
    });

    it('never returns the input or the plaintext when decryption fails', () => {
      const tampered = flipSegment(stored, 4);
      let result: unknown = 'not reached';
      const error = expectCode(() => {
        result = svc.decrypt(tampered, AAD);
      }, 'AUTH_FAILED');
      expect(result).toBe('not reached');
      expect(error.message).not.toContain(SECRET);
      expect(error.message).not.toContain(tampered.split(':')[4]);
      expectCode(() => svc.decrypt('legacy-or-plain-value', AAD), 'MALFORMED');
    });
  });

  describe('key configuration', () => {
    it.each([
      ['missing keys', {}],
      ['missing active version', { CREDENTIAL_KEYS: `1:${K1}` }],
      ['active version not listed', { CREDENTIAL_KEYS: `1:${K1}`, CREDENTIAL_ACTIVE_KEY_VERSION: '2' }],
      ['31-byte key', { CREDENTIAL_KEYS: `1:${crypto.randomBytes(31).toString('base64')}`, CREDENTIAL_ACTIVE_KEY_VERSION: '1' }],
      ['33-byte key', { CREDENTIAL_KEYS: `1:${crypto.randomBytes(33).toString('base64')}`, CREDENTIAL_ACTIVE_KEY_VERSION: '1' }],
      ['not base64', { CREDENTIAL_KEYS: '1:not*base64!', CREDENTIAL_ACTIVE_KEY_VERSION: '1' }],
      ['raw 32-character string instead of base64', { CREDENTIAL_KEYS: '1:12345678901234567890123456789012', CREDENTIAL_ACTIVE_KEY_VERSION: '1' }],
      ['entry without version', { CREDENTIAL_KEYS: K1, CREDENTIAL_ACTIVE_KEY_VERSION: '1' }],
      ['invalid version label', { CREDENTIAL_KEYS: `v 1:${K1}`, CREDENTIAL_ACTIVE_KEY_VERSION: 'v 1' }],
      ['duplicate version', { CREDENTIAL_KEYS: `1:${K1},1:${K2}`, CREDENTIAL_ACTIVE_KEY_VERSION: '1' }],
    ])('refuses to encrypt or decrypt with %s', (_label, env) => {
      const svc = serviceWith(env as Record<string, string>);
      expect(svc.isConfigured()).toBe(false);
      expectCode(() => svc.assertReady(), 'KEY_CONFIG');
      expectCode(() => svc.encrypt(SECRET, AAD), 'KEY_CONFIG');
      expectCode(() => svc.decrypt(v1Only().encrypt(SECRET, AAD), AAD), 'KEY_CONFIG');
    });

    it('never falls back to SECRET_KEY or JWT_SECRET', () => {
      const svc = serviceWith({ SECRET_KEY: 'test-only-secret', JWT_SECRET: 'test-only-jwt' });
      expectCode(() => svc.encrypt(SECRET, AAD), 'KEY_CONFIG');
    });

    it('configuration errors do not contain key material', () => {
      const bad = crypto.randomBytes(31).toString('base64');
      const svc = serviceWith({ CREDENTIAL_KEYS: `1:${bad}`, CREDENTIAL_ACTIVE_KEY_VERSION: '1' });
      expect(expectCode(() => svc.assertReady(), 'KEY_CONFIG').message).not.toContain(bad);
    });

    it('accepts whitespace around entries and base64 padding', () => {
      const svc = serviceWith({ CREDENTIAL_KEYS: ` 1 : ${K1} , 2:${K2} `, CREDENTIAL_ACTIVE_KEY_VERSION: ' 2 ' });
      expect(svc.isConfigured()).toBe(true);
      expect(svc.activeKeyVersion).toBe('2');
    });
  });

  describe('key rotation', () => {
    it('encrypts with the active version and still decrypts older versions', () => {
      const old = v1Only().encrypt(SECRET, AAD);
      const rotated = serviceWith({ CREDENTIAL_KEYS: `1:${K1},2:${K2}`, CREDENTIAL_ACTIVE_KEY_VERSION: '2' });
      expect(rotated.decrypt(old, AAD)).toBe(SECRET);
      expect(rotated.needsReEncryption(old)).toBe(true);

      const fresh = rotated.encrypt(SECRET, AAD);
      expect(fresh.split(':')[1]).toBe('2');
      expect(rotated.needsReEncryption(fresh)).toBe(false);
      expect(rotated.decrypt(fresh, AAD)).toBe(SECRET);
    });

    it('fails explicitly once a retired key is removed', () => {
      const old = v1Only().encrypt(SECRET, AAD);
      const retired = serviceWith({ CREDENTIAL_KEYS: `2:${K2}`, CREDENTIAL_ACTIVE_KEY_VERSION: '2' });
      expectCode(() => retired.decrypt(old, AAD), 'UNKNOWN_KEY_VERSION');
    });
  });

  describe('legacy formats (read only)', () => {
    const LEGACY_SECRET = 'test-only-secret-key';
    const legacyEnv = {
      CREDENTIAL_KEYS: `1:${K1}`,
      CREDENTIAL_ACTIVE_KEY_VERSION: '1',
      SECRET_KEY: LEGACY_SECRET,
      CREDENTIAL_LEGACY_DJANGO_SECRET_KEY: 'test-only-django-secret-not-a-real-key',
    };
    const svc = serviceWith(legacyEnv);

    // Produced by the existing implementations (not copies of them)
    const companyStored = new EncryptionService(configOf({ SECRET_KEY: LEGACY_SECRET })).encrypt('legacy-company-password');
    // Static-key value written by the former InfrastructureService helper (removed in Stage 6)
    const infraStored = '7712cdc078d0ac9d5cf600170c2091e424d1124a9cb9f8acd6ac52bf7444e727'; // 'legacy-cpanel-password'
    // Static-key value written by the former SeoService helper (removed in Stage 7)
    const seoStored = 'ac6670cc5b803f67e79153cf2cb4bbaf7342a9a1aea3a39016b19285fb188582'; // 'legacy-seo-pässwörd'
    // Generated with Python cryptography 46 using the Django code's derivation
    // Fernet(urlsafe_b64encode(sha256(SECRET_KEY))) and the made-up secret above
    const FERNET_ASCII =
      'gAAAAABq2aizYmoIVxLZHKAecPVpNyXWrlAAhLAkbcUXXynTqPjYHyZ1diN0lElEy7CBIWMuGJSJhM-rdDmczHUR7gJ8b8cpwHpQ2-VGmqdm7JEQMxsRM5c=';
    const FERNET_UNICODE =
      'gAAAAABq2ai8HZ7MSWSl_5KLUOhmBfvryuRxirXwVOFuHOBQ6byX08oJG4ns5-LmtVQpYcl44BzX-UsenL3s7DjZcu1_Gb2wWw==';

    it('classifies every format by shape', () => {
      expect(svc.classify(svc.encrypt('x', AAD))).toBe('gcm1');
      expect(svc.classify(companyStored)).toBe('legacy-cbc-secret-key');
      expect(svc.classify(infraStored)).toBe('legacy-cbc-static');
      expect(svc.classify(seoStored)).toBe('legacy-cbc-static');
      expect(svc.classify(FERNET_ASCII)).toBe('legacy-fernet');
      expect(svc.classify('my-plain-password')).toBe('unknown');
      expect(svc.classify('')).toBe('unknown');
    });

    it('reads EncryptionService (SECRET_KEY) values', () => {
      expect(svc.decryptLegacy(companyStored)).toEqual({ format: 'legacy-cbc-secret-key', plaintext: 'legacy-company-password' });
    });

    it('reads static-key InfrastructureService and SeoService values', () => {
      // Frozen fixture used by website-credentials.http.spec
      expect(svc.decryptLegacy('390423887eaa4e0511c6b96b1126549de0c8fe74f32ccc31b31978b7600f8577').plaintext).toBe('legacy-static-pass');
      expect(svc.decryptLegacy(infraStored).plaintext).toBe('legacy-cpanel-password');
      expect(svc.decryptLegacy(seoStored).plaintext).toBe('legacy-seo-pässwörd');
    });

    it('reads Django Fernet values when the Django secret is configured', () => {
      expect(svc.decryptLegacy(FERNET_ASCII)).toEqual({ format: 'legacy-fernet', plaintext: 'legacy-fixture-password' });
      expect(svc.decryptLegacy(FERNET_UNICODE).plaintext).toBe('pässwörd-€');
    });

    it('reports a missing legacy key instead of guessing', () => {
      const noLegacyKeys = serviceWith({ CREDENTIAL_KEYS: `1:${K1}`, CREDENTIAL_ACTIVE_KEY_VERSION: '1' });
      expectCode(() => noLegacyKeys.decryptLegacy(companyStored), 'LEGACY_KEY_UNAVAILABLE');
      expectCode(() => noLegacyKeys.decryptLegacy(FERNET_ASCII), 'LEGACY_KEY_UNAVAILABLE');
      // The static key is in the source, so it needs no configuration
      expect(noLegacyKeys.decryptLegacy(infraStored).plaintext).toBe('legacy-cpanel-password');
    });

    it('does not use the hardcoded EncryptionService fallback key', () => {
      const fallbackStored = new EncryptionService(configOf({})).encrypt('made-with-fallback');
      const noSecret = serviceWith({ CREDENTIAL_KEYS: `1:${K1}`, CREDENTIAL_ACTIVE_KEY_VERSION: '1' });
      expectCode(() => noSecret.decryptLegacy(fallbackStored), 'LEGACY_KEY_UNAVAILABLE');
    });

    it('fails explicitly with the wrong legacy key', () => {
      const wrong = serviceWith({ ...legacyEnv, SECRET_KEY: 'another-test-secret', CREDENTIAL_LEGACY_DJANGO_SECRET_KEY: 'another-django-secret' });
      expectCode(() => wrong.decryptLegacy(companyStored), 'LEGACY_DECRYPT_FAILED');
      expectCode(() => wrong.decryptLegacy(FERNET_ASCII), 'LEGACY_DECRYPT_FAILED');
    });

    it('rejects a tampered Fernet token (HMAC)', () => {
      const raw = Buffer.from(FERNET_ASCII, 'base64url');
      raw[30] ^= 0x01;
      expectCode(() => svc.decryptLegacy(raw.toString('base64url')), 'LEGACY_DECRYPT_FAILED');
    });

    it('never treats unrecognised or undecryptable input as plaintext', () => {
      expectCode(() => svc.decryptLegacy('my-plain-password'), 'UNRECOGNIZED_FORMAT');
      expectCode(() => svc.decryptLegacy(svc.encrypt('x', AAD)), 'UNRECOGNIZED_FORMAT');
      // Plaintext that merely looks like static-key hex fails decryption instead of being returned
      const hexLookingPlaintext = 'deadbeef'.repeat(8);
      expect(svc.classify(hexLookingPlaintext)).toBe('legacy-cbc-static');
      expectCode(() => svc.decryptLegacy(hexLookingPlaintext), 'LEGACY_DECRYPT_FAILED');
    });
  });
  describe('startup validation (onModuleInit)', () => {
    const BAD_31 = crypto.randomBytes(31).toString('base64');
    const INVALID: [string, Record<string, string | undefined>][] = [
      ['1. CREDENTIAL_KEYS missing or blank', { CREDENTIAL_KEYS: '   ', CREDENTIAL_ACTIVE_KEY_VERSION: '1' }],
      ['2. CREDENTIAL_ACTIVE_KEY_VERSION missing or blank', { CREDENTIAL_KEYS: `1:${K1}`, CREDENTIAL_ACTIVE_KEY_VERSION: ' ' }],
      ['3. entry without "<version>:<key>" / invalid version label', { CREDENTIAL_KEYS: `v 1:${K1}`, CREDENTIAL_ACTIVE_KEY_VERSION: 'v 1' }],
      ['4. key not 32 bytes (or not base64)', { CREDENTIAL_KEYS: `1:${BAD_31}`, CREDENTIAL_ACTIVE_KEY_VERSION: '1' }],
      ['5. duplicate version', { CREDENTIAL_KEYS: `1:${K1},1:${K2}`, CREDENTIAL_ACTIVE_KEY_VERSION: '1' }],
      ['6. active version not listed', { CREDENTIAL_KEYS: `1:${K1}`, CREDENTIAL_ACTIVE_KEY_VERSION: '2' }],
    ];

    it.each(INVALID)('fails startup: %s', (_label, env) => {
      const error = expectCode(() => serviceWith(env).onModuleInit(), 'KEY_CONFIG');
      for (const material of [K1, K2, BAD_31]) expect(error.message).not.toContain(material);
    });

    it('also fails startup when the variables are entirely absent or not base64', () => {
      expectCode(() => serviceWith({}).onModuleInit(), 'KEY_CONFIG');
      expectCode(() => serviceWith({ CREDENTIAL_KEYS: '1:not*base64!', CREDENTIAL_ACTIVE_KEY_VERSION: '1' }).onModuleInit(), 'KEY_CONFIG');
    });

    it('starts with a valid single key and with a multi-version (rotation) configuration', () => {
      expect(() => v1Only().onModuleInit()).not.toThrow();
      expect(() => serviceWith({ CREDENTIAL_KEYS: `1:${K1},2:${K2}`, CREDENTIAL_ACTIVE_KEY_VERSION: '2' }).onModuleInit()).not.toThrow();
    });

    it('does not require the optional legacy read keys at startup', () => {
      const svc = serviceWith({ CREDENTIAL_KEYS: `1:${K1}`, CREDENTIAL_ACTIVE_KEY_VERSION: '1', SECRET_KEY: undefined, CREDENTIAL_LEGACY_DJANGO_SECRET_KEY: undefined });
      expect(() => svc.onModuleInit()).not.toThrow();
    });

    describe('application initialisation', () => {
      const boot = async (env: Record<string, string | undefined>) => {
        const moduleRef = await Test.createTestingModule({
          providers: [CredentialCryptoService, { provide: ConfigService, useValue: configOf(env) }],
        }).compile();
        const app = moduleRef.createNestApplication();
        try {
          await app.init();
        } finally {
          await app.close().catch(() => undefined);
        }
      };

      it.each(INVALID)('refuses to start: %s', async (_label, env) => {
        const error = await boot(env).catch((e) => e);
        expect(error).toBeInstanceOf(CredentialCryptoError);
        expect(error.code).toBe('KEY_CONFIG');
        for (const material of [K1, K2, BAD_31]) expect(error.message).not.toContain(material);
      });

      it('starts with valid test keys', async () => {
        await expect(boot({ CREDENTIAL_KEYS: `1:${K1}`, CREDENTIAL_ACTIVE_KEY_VERSION: '1' })).resolves.toBeUndefined();
        await expect(boot({ CREDENTIAL_KEYS: `1:${K1},2:${K2}`, CREDENTIAL_ACTIVE_KEY_VERSION: '2' })).resolves.toBeUndefined();
      });
    });
  });
});
