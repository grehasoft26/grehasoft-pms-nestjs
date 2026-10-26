import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

/**
 * Credential Vault encryption: AES-256-GCM with versioned keys.
 *
 * Stored format: gcm1:<keyVersion>:<iv base64url>:<tag base64url>:<ciphertext base64url>
 * - a fresh random 12-byte IV per encryption, a 16-byte authentication tag
 * - AAD binds the value to its table, field and (optionally) record id, plus the header,
 *   so a value copied to another record or field fails authentication
 *
 * Keys: CREDENTIAL_KEYS = "<version>:<base64 32 bytes>[,<version>:<base64 32 bytes>...]" and
 * CREDENTIAL_ACTIVE_KEY_VERSION = the version used for new encryptions. Older versions stay
 * listed so existing values still decrypt during rotation. There is no fallback key and
 * SECRET_KEY / JWT_SECRET are never used for new encryption.
 *
 * Invalid or missing configuration stops the application from starting (onModuleInit throws
 * KEY_CONFIG before the server listens). Every encrypt/decrypt also re-checks it. The legacy
 * read keys (SECRET_KEY, CREDENTIAL_LEGACY_DJANGO_SECRET_KEY) are optional and not checked at startup.
 *
 * Legacy formats are read only (decryptLegacy), never written:
 * - legacy-cbc-secret-key: "ivhex:cthex", AES-256-CBC, key = SHA-256(SECRET_KEY) (EncryptionService)
 * - legacy-cbc-static: bare hex, AES-256-CBC with the constant key/IV in InfrastructureService and SeoService
 * - legacy-fernet: Django Fernet token, key = SHA-256(Django SECRET_KEY), configured explicitly as
 *   CREDENTIAL_LEGACY_DJANGO_SECRET_KEY (HMAC-verified)
 * CBC formats carry no authentication: padding plus strict UTF-8 checks reject most wrong-key
 * or non-ciphertext input, but cannot prove a value is genuine.
 *
 * Nothing here logs keys, plaintext or stored values, and errors never include them.
 */

export type CredentialCryptoErrorCode =
  | 'KEY_CONFIG'
  | 'UNKNOWN_KEY_VERSION'
  | 'INVALID_INPUT'
  | 'MALFORMED'
  | 'AUTH_FAILED'
  | 'UNRECOGNIZED_FORMAT'
  | 'LEGACY_KEY_UNAVAILABLE'
  | 'LEGACY_DECRYPT_FAILED';

export class CredentialCryptoError extends Error {
  constructor(
    readonly code: CredentialCryptoErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CredentialCryptoError';
  }
}

/** Where a value is stored; recordId is optional but must be stable when used. */
export interface CredentialAad {
  table: string;
  field: string;
  recordId?: string | number;
}

export type StoredCredentialFormat = 'gcm1' | 'legacy-cbc-secret-key' | 'legacy-cbc-static' | 'legacy-fernet' | 'unknown';

const FORMAT_PREFIX = 'gcm1';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const VERSION_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
const AAD_NAME_PATTERN = /^[A-Za-z0-9_.]{1,64}$/;
const RECORD_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

// Legacy constants copied from InfrastructureService/SeoService (public in source; read only)
const LEGACY_STATIC_KEY = Buffer.from('12345678901234567890123456789012');
const LEGACY_STATIC_IV = Buffer.from('1234567890123456');

const utf8 = new TextDecoder('utf-8', { fatal: true });
// C0 controls other than tab, LF and CR do not occur in real credentials; seeing them means wrong key
const UNEXPECTED_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

@Injectable()
export class CredentialCryptoService implements OnModuleInit {
  private readonly keys = new Map<string, Buffer>();
  private activeVersion: string | null = null;
  private configError: string | null = null;

  constructor(private readonly config: ConfigService) {
    try {
      this.loadKeys();
    } catch (error) {
      this.keys.clear();
      this.activeVersion = null;
      this.configError = error instanceof CredentialCryptoError ? error.message : 'Credential encryption keys are invalid.';
    }
  }

  /** Fails application startup when the keys are missing or invalid (no key material in the error). */
  onModuleInit(): void {
    this.assertReady();
  }

  /** True when an active key is configured and every listed key is valid. */
  isConfigured(): boolean {
    return this.configError === null;
  }

  /** Throws KEY_CONFIG when the key configuration is missing or invalid. */
  assertReady(): void {
    if (this.configError !== null) throw new CredentialCryptoError('KEY_CONFIG', this.configError);
  }

  get activeKeyVersion(): string {
    this.assertReady();
    return this.activeVersion!;
  }

  encrypt(plaintext: string, aad: CredentialAad): string {
    this.assertReady();
    if (typeof plaintext !== 'string') throw new CredentialCryptoError('INVALID_INPUT', 'Plaintext must be a string.');
    const version = this.activeVersion!;
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.keys.get(version)!, iv, { authTagLength: TAG_LENGTH });
    cipher.setAAD(this.aadFor(version, aad));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [FORMAT_PREFIX, version, b64url(iv), b64url(tag), b64url(ciphertext)].join(':');
  }

  /** Decrypts a gcm1 value; throws (never returns the input) on any problem. */
  decrypt(stored: string, aad: CredentialAad): string {
    this.assertReady();
    const parsed = this.parse(stored);
    const key = this.keys.get(parsed.version);
    if (!key) throw new CredentialCryptoError('UNKNOWN_KEY_VERSION', `No credential key is configured for version "${parsed.version}".`);
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, parsed.iv, { authTagLength: TAG_LENGTH });
      decipher.setAAD(this.aadFor(parsed.version, aad));
      decipher.setAuthTag(parsed.tag);
      return Buffer.concat([decipher.update(parsed.ciphertext), decipher.final()]).toString('utf8');
    } catch {
      throw new CredentialCryptoError('AUTH_FAILED', 'Credential could not be authenticated.');
    }
  }

  /** True for gcm1 values written with a key other than the active one (rotation). */
  needsReEncryption(stored: string): boolean {
    return this.parse(stored).version !== this.activeKeyVersion;
  }

  /**
   * Shape-based classification; it does not decrypt. Plaintext that happens to look like a
   * legacy format is classified as that format and then fails in decryptLegacy.
   */
  classify(stored: string): StoredCredentialFormat {
    if (typeof stored !== 'string' || stored === '') return 'unknown';
    if (stored.startsWith(`${FORMAT_PREFIX}:`)) return 'gcm1';
    if (/^[0-9a-f]{32}:(?:[0-9a-f]{32})+$/.test(stored)) return 'legacy-cbc-secret-key';
    if (isFernetShape(stored)) return 'legacy-fernet';
    if (/^(?:[0-9a-f]{32})+$/.test(stored)) return 'legacy-cbc-static';
    return 'unknown';
  }

  /** Reads a legacy value. Throws for gcm1, unknown shapes, unavailable keys and failed decryption. */
  decryptLegacy(stored: string): { format: Exclude<StoredCredentialFormat, 'gcm1' | 'unknown'>; plaintext: string } {
    const format = this.classify(stored);
    switch (format) {
      case 'legacy-cbc-secret-key': {
        const secret = this.config.get<string>('SECRET_KEY');
        if (!secret) throw new CredentialCryptoError('LEGACY_KEY_UNAVAILABLE', 'SECRET_KEY is not configured.');
        const [ivHex, ctHex] = stored.split(':');
        const key = crypto.createHash('sha256').update(secret).digest();
        return { format, plaintext: decryptCbc('aes-256-cbc', key, Buffer.from(ivHex, 'hex'), Buffer.from(ctHex, 'hex')) };
      }
      case 'legacy-cbc-static':
        return { format, plaintext: decryptCbc('aes-256-cbc', LEGACY_STATIC_KEY, LEGACY_STATIC_IV, Buffer.from(stored, 'hex')) };
      case 'legacy-fernet': {
        const secret = this.config.get<string>('CREDENTIAL_LEGACY_DJANGO_SECRET_KEY');
        if (!secret) throw new CredentialCryptoError('LEGACY_KEY_UNAVAILABLE', 'CREDENTIAL_LEGACY_DJANGO_SECRET_KEY is not configured.');
        return { format, plaintext: decryptFernet(stored, crypto.createHash('sha256').update(secret).digest()) };
      }
      case 'gcm1':
        throw new CredentialCryptoError('UNRECOGNIZED_FORMAT', 'Value is already gcm1; use decrypt().');
      default:
        throw new CredentialCryptoError('UNRECOGNIZED_FORMAT', 'Value is not in a recognised credential format.');
    }
  }

  private loadKeys(): void {
    const raw = (this.config.get<string>('CREDENTIAL_KEYS') ?? '').trim();
    const active = (this.config.get<string>('CREDENTIAL_ACTIVE_KEY_VERSION') ?? '').trim();
    if (!raw) throw new CredentialCryptoError('KEY_CONFIG', 'CREDENTIAL_KEYS is not configured.');
    if (!active) throw new CredentialCryptoError('KEY_CONFIG', 'CREDENTIAL_ACTIVE_KEY_VERSION is not configured.');

    for (const entry of raw.split(',').map((e) => e.trim()).filter(Boolean)) {
      const separator = entry.indexOf(':');
      const version = separator > 0 ? entry.slice(0, separator).trim() : '';
      const encoded = separator > 0 ? entry.slice(separator + 1).trim() : '';
      if (!VERSION_PATTERN.test(version)) {
        throw new CredentialCryptoError('KEY_CONFIG', 'CREDENTIAL_KEYS entries must be "<version>:<base64 key>" (version: letters, digits, _ or -).');
      }
      if (this.keys.has(version)) throw new CredentialCryptoError('KEY_CONFIG', `CREDENTIAL_KEYS lists version "${version}" twice.`);
      if (!BASE64_PATTERN.test(encoded)) {
        throw new CredentialCryptoError('KEY_CONFIG', `CREDENTIAL_KEYS version "${version}" is not valid base64.`);
      }
      const key = Buffer.from(encoded, 'base64');
      if (key.length !== KEY_LENGTH) {
        throw new CredentialCryptoError('KEY_CONFIG', `CREDENTIAL_KEYS version "${version}" must decode to ${KEY_LENGTH} bytes.`);
      }
      this.keys.set(version, key);
    }

    if (!this.keys.has(active)) {
      throw new CredentialCryptoError('KEY_CONFIG', `CREDENTIAL_ACTIVE_KEY_VERSION "${active}" is not listed in CREDENTIAL_KEYS.`);
    }
    this.activeVersion = active;
  }

  private parse(stored: string): { version: string; iv: Buffer; tag: Buffer; ciphertext: Buffer } {
    const malformed = () => new CredentialCryptoError('MALFORMED', 'Value is not a valid gcm1 credential.');
    if (typeof stored !== 'string') throw malformed();
    const parts = stored.split(':');
    if (parts.length !== 5 || parts[0] !== FORMAT_PREFIX || !VERSION_PATTERN.test(parts[1])) throw malformed();
    if (!parts.slice(2).every((p) => BASE64URL_PATTERN.test(p))) throw malformed();
    const iv = Buffer.from(parts[2], 'base64url');
    const tag = Buffer.from(parts[3], 'base64url');
    // Re-encoding catches non-canonical base64url (e.g. stray trailing bits)
    if (iv.length !== IV_LENGTH || b64url(iv) !== parts[2]) throw malformed();
    if (tag.length !== TAG_LENGTH || b64url(tag) !== parts[3]) throw malformed();
    const ciphertext = Buffer.from(parts[4], 'base64url');
    if (b64url(ciphertext) !== parts[4]) throw malformed();
    return { version: parts[1], iv, tag, ciphertext };
  }

  private aadFor(version: string, aad: CredentialAad): Buffer {
    if (!aad || !AAD_NAME_PATTERN.test(String(aad.table)) || !AAD_NAME_PATTERN.test(String(aad.field))) {
      throw new CredentialCryptoError('INVALID_INPUT', 'AAD requires table and field names (letters, digits, _ or .).');
    }
    const recordId = aad.recordId === undefined || aad.recordId === null ? '' : String(aad.recordId);
    if (recordId !== '' && !RECORD_ID_PATTERN.test(recordId)) {
      throw new CredentialCryptoError('INVALID_INPUT', 'AAD recordId must be letters, digits, _ or -.');
    }
    return Buffer.from(`${FORMAT_PREFIX}:${version}|${aad.table}|${aad.field}|${recordId}`, 'utf8');
  }
}

const b64url = (buf: Buffer) => buf.toString('base64url');

/** Fernet token: 0x80 | timestamp(8) | iv(16) | ciphertext(n*16) | hmac(32), urlsafe base64. */
function isFernetShape(value: string): boolean {
  if (!/^gAAAAA[A-Za-z0-9_-]+={0,2}$/.test(value)) return false;
  const raw = Buffer.from(value, 'base64url');
  return raw.length >= 1 + 8 + 16 + 16 + 32 && (raw.length - 57) % 16 === 0 && raw[0] === 0x80;
}

function decryptFernet(token: string, fernetKey: Buffer): string {
  const raw = Buffer.from(token, 'base64url');
  const signed = raw.subarray(0, raw.length - 32);
  const mac = raw.subarray(raw.length - 32);
  const expected = crypto.createHmac('sha256', fernetKey.subarray(0, 16)).update(signed).digest();
  if (!crypto.timingSafeEqual(mac, expected)) {
    throw new CredentialCryptoError('LEGACY_DECRYPT_FAILED', 'Legacy Fernet value could not be authenticated.');
  }
  return decryptCbc('aes-128-cbc', fernetKey.subarray(16, 32), raw.subarray(9, 25), raw.subarray(25, raw.length - 32));
}

function decryptCbc(algorithm: 'aes-256-cbc' | 'aes-128-cbc', key: Buffer, iv: Buffer, ciphertext: Buffer): string {
  let plaintext: string;
  try {
    const decipher = crypto.createDecipheriv(algorithm, key, iv);
    plaintext = utf8.decode(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  } catch {
    throw new CredentialCryptoError('LEGACY_DECRYPT_FAILED', 'Legacy value could not be decrypted with the configured key.');
  }
  if (UNEXPECTED_CONTROL.test(plaintext)) {
    throw new CredentialCryptoError('LEGACY_DECRYPT_FAILED', 'Legacy value could not be decrypted with the configured key.');
  }
  return plaintext;
}
