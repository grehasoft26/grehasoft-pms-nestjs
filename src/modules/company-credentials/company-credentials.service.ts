import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { CompanyCredentialCategory } from '@prisma/client';
import { PrismaService } from '../../core/prisma.service';
import { CredentialCryptoService } from '../../core/credential-crypto.service';
import { canRevealCredentials, credentialCryptoHttpError } from '../../core/utils/credential-access.util';
import { CredentialAuditContext, CredentialAuditService } from '../credential-audit/credential-audit.service';

export const COMPANY_CREDENTIAL_CATEGORIES = Object.values(CompanyCredentialCategory);

/** AAD identifiers for company_credentials.password; must match on encrypt and decrypt. */
const PASSWORD_AAD = { table: 'company_credentials', field: 'password' } as const;

/**
 * Internal Grehasoft company credentials.
 * Separate from client WebsiteCredential records (InfrastructureService), which are untouched.
 *
 * New passwords are encrypted with CredentialCryptoService (AES-256-GCM, AAD bound to the record
 * id). Existing EncryptionService values ("ivhex:cthex", key from SECRET_KEY) stay readable; any
 * other stored value is refused for manual review, never returned as if it were the password.
 * Passwords never appear in list/detail/create/update responses; they are revealed one at a time
 * through POST /:id/reveal, which requires REVEAL_CREDENTIALS and is audited (as are denials,
 * creates, secret changes and deletes).
 */
@Injectable()
export class CompanyCredentialsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CredentialCryptoService,
    private readonly audit: CredentialAuditService,
  ) {}


  /** Strips the stored password and exposes only whether one is set. */
  private format(credential: any) {
    const { password, ...rest } = credential;
    return { ...rest, has_password: !!password };
  }

  async findAll(query: { page?: string; limit?: string; search?: string; category?: string; all?: string } = {}) {
    const where: any = {};

    if (query.search && query.search.trim()) {
      const search = query.search.trim();
      // MySQL default collation (utf8mb4_unicode_ci) makes `contains` case-insensitive
      where.OR = [
        { name: { contains: search } },
        { provider: { contains: search } },
        { username: { contains: search } },
        { login_url: { contains: search } },
        { notes: { contains: search } },
      ];
    }

    if (query.category) {
      where.category = this.parseCategory(query.category);
    }

    if (query.all === 'true') {
      const credentials = await this.prisma.companyCredential.findMany({ where, orderBy: { name: 'asc' } });
      return credentials.map((c) => this.format(c));
    }

    const pageNum = Math.max(1, Number(query.page) || 1);
    const limitNum = Math.max(1, Number(query.limit) || 5);

    const count = await this.prisma.companyCredential.count({ where });
    const results = await this.prisma.companyCredential.findMany({
      where,
      orderBy: { id: 'desc' },
      skip: (pageNum - 1) * limitNum,
      take: limitNum,
    });

    return {
      count,
      next: pageNum * limitNum < count ? `/api/infrastructure/company-credentials?page=${pageNum + 1}` : null,
      previous: pageNum > 1 ? `/api/infrastructure/company-credentials?page=${pageNum - 1}` : null,
      results: results.map((c) => this.format(c)),
    };
  }

  async findOne(id: number) {
    return this.format(await this.getOrThrow(id));
  }

  /**
   * Decrypted password for an explicit reveal request. Permission is checked here rather than by
   * the guard so refused attempts are audited (REVEAL_DENIED) before the record is even looked up.
   * The secret is returned only after the REVEAL audit row is written.
   */
  async revealPassword(user: any, id: number, context: CredentialAuditContext) {
    if (!canRevealCredentials(user)) {
      await this.audit
        .record(context, { credentialType: 'company', credentialId: id, action: 'REVEAL_DENIED' })
        .catch(() => undefined); // the request is refused either way
      throw new ForbiddenException('You do not have permission to reveal credentials.');
    }
    const credential = await this.getOrThrow(id);
    const password = credential.password ? this.readPassword(credential.password, id) : '';
    await this.audit.record(context, { credentialType: 'company', credentialId: id, action: 'REVEAL' });
    return { password };
  }

  async create(data: any, context: CredentialAuditContext) {
    const input = this.validate(data, true);
    if (input.password) this.assertCryptoReady();

    const credential = await this.withCrypto(() =>
      this.prisma.$transaction(async (tx: any) => {
        // The record id is part of the AAD, so the row is created first and the secret added in
        // the same transaction; a failure rolls both back (plaintext is never written)
        let row = await tx.companyCredential.create({
          data: {
            name: input.name!,
            category: input.category ?? CompanyCredentialCategory.OTHER,
            provider: input.provider ?? null,
            login_url: input.login_url ?? null,
            username: input.username ?? null,
            password: null,
            notes: input.notes ?? null,
          },
        });
        if (input.password) {
          row = await tx.companyCredential.update({
            where: { id: row.id },
            data: { password: this.crypto.encrypt(input.password, { ...PASSWORD_AAD, recordId: row.id }) },
          });
        }
        await this.audit.record(context, { credentialType: 'company', credentialId: row.id, action: 'CREATE' }, tx);
        return row;
      }),
    );
    return this.format(credential);
  }

  /**
   * Partial update. Password: omitted/empty keeps the stored value,
   * a new value replaces it, `clear_password: true` removes it.
   */
  async update(id: number, data: any, context: CredentialAuditContext) {
    await this.getOrThrow(id);
    const input = this.validate(data, false);

    let password: string | null | undefined;
    if (data?.clear_password === true) {
      password = null;
    } else if (input.password) {
      this.assertCryptoReady();
      password = this.withCryptoSync(() => this.crypto.encrypt(input.password!, { ...PASSWORD_AAD, recordId: id }));
    }
    const secretChanged = password !== undefined;

    const credential = await this.prisma.$transaction(async (tx: any) => {
      const row = await tx.companyCredential.update({
        where: { id },
        data: {
          name: input.name,
          category: input.category,
          provider: input.provider,
          login_url: input.login_url,
          username: input.username,
          password,
          notes: input.notes,
        },
      });
      if (secretChanged) {
        await this.audit.record(context, { credentialType: 'company', credentialId: id, action: 'UPDATE_SECRET' }, tx);
      }
      return row;
    });
    return this.format(credential);
  }

  async remove(id: number, context: CredentialAuditContext) {
    await this.getOrThrow(id);
    await this.prisma.$transaction(async (tx: any) => {
      await tx.companyCredential.delete({ where: { id } });
      await this.audit.record(context, { credentialType: 'company', credentialId: id, action: 'DELETE' }, tx);
    });
  }

  /** gcm1 values and verified legacy EncryptionService values; anything else needs manual review. */
  private readPassword(stored: string, id: number): string {
    return this.withCryptoSync(() => {
      const format = this.crypto.classify(stored);
      if (format === 'gcm1') return this.crypto.decrypt(stored, { ...PASSWORD_AAD, recordId: id });
      if (format === 'legacy-cbc-secret-key') return this.crypto.decryptLegacy(stored).plaintext;
      throw new UnprocessableEntityException(
        'The stored password is not in a recognised encrypted format and needs manual review. Replace it to continue.',
      );
    });
  }

  private assertCryptoReady() {
    this.withCryptoSync(() => this.crypto.assertReady());
  }

  private withCryptoSync<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      throw credentialCryptoHttpError(error);
    }
  }

  private async withCrypto<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw credentialCryptoHttpError(error);
    }
  }

  private async getOrThrow(id: number) {
    const credential = await this.prisma.companyCredential.findUnique({ where: { id } });
    if (!credential) throw new NotFoundException('Grehasoft credential not found');
    return credential;
  }

  private parseCategory(value: any): CompanyCredentialCategory {
    const category = String(value).trim().toUpperCase() as CompanyCredentialCategory;
    if (!COMPANY_CREDENTIAL_CATEGORIES.includes(category)) {
      throw new BadRequestException(`Category must be one of: ${COMPANY_CREDENTIAL_CATEGORIES.join(', ')}.`);
    }
    return category;
  }

  /**
   * Validates and normalizes input. Fields not present in `data` stay undefined
   * (unchanged on update); empty optional strings become null.
   */
  private validate(data: any, isCreate: boolean) {
    const body = data || {};
    const result: {
      name?: string;
      category?: CompanyCredentialCategory;
      provider?: string | null;
      login_url?: string | null;
      username?: string | null;
      password?: string;
      notes?: string | null;
    } = {};

    if (isCreate || body.name !== undefined) {
      const name = String(body.name ?? '').trim();
      if (!name) throw new BadRequestException('Credential name is required.');
      if (name.length > 255) throw new BadRequestException('Credential name must be at most 255 characters.');
      result.name = name;
    }

    if (body.category !== undefined && body.category !== null && body.category !== '') {
      result.category = this.parseCategory(body.category);
    }

    const optionalText = (field: 'provider' | 'username' | 'notes', label: string, max?: number) => {
      if (body[field] === undefined) return;
      const value = body[field] === null ? '' : String(body[field]).trim();
      if (max && value.length > max) throw new BadRequestException(`${label} must be at most ${max} characters.`);
      result[field] = value || null;
    };
    optionalText('provider', 'Provider', 255);
    optionalText('username', 'Username / Email', 255);
    optionalText('notes', 'Notes');

    if (body.login_url !== undefined) {
      const url = body.login_url === null ? '' : String(body.login_url).trim();
      if (url) {
        if (url.length > 500) throw new BadRequestException('Login URL must be at most 500 characters.');
        let parsed: URL | null = null;
        try {
          parsed = new URL(url);
        } catch {
          parsed = null;
        }
        if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) {
          throw new BadRequestException('Login URL must be a valid http:// or https:// URL.');
        }
      }
      result.login_url = url || null;
    }

    if (body.password !== undefined && body.password !== null && body.password !== '') {
      const password = String(body.password);
      if (password.length > 1000) throw new BadRequestException('Password must be at most 1000 characters.');
      result.password = password;
    }

    return result;
  }
}
