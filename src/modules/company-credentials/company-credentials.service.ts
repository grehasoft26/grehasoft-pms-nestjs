import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from '@nestjs/common';
import { CompanyCredentialCategory } from '@prisma/client';
import { PrismaService } from '../../core/prisma.service';
import { EncryptionService } from '../../core/encryption.service';

export const COMPANY_CREDENTIAL_CATEGORIES = Object.values(CompanyCredentialCategory);

/**
 * Internal Grehasoft company credentials.
 * Separate from client WebsiteCredential records (InfrastructureService), which are untouched.
 *
 * Passwords are encrypted with EncryptionService (AES-256-CBC, random IV, key from SECRET_KEY)
 * and are never included in list/detail responses; only super admins can reveal them
 * through the dedicated password endpoint.
 */
@Injectable()
export class CompanyCredentialsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  private isSuperAdmin(user: any): boolean {
    const role = user?.role?.name || user?.role_name;
    return !!user?.is_superuser || role === 'SUPER_ADMIN';
  }

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

  /** Decrypted password; super admins only. */
  async revealPassword(user: any, id: number) {
    if (!this.isSuperAdmin(user)) {
      throw new ForbiddenException('Only super admins can view Grehasoft credential passwords.');
    }
    const credential = await this.getOrThrow(id);
    return { password: credential.password ? this.encryption.decrypt(credential.password) : '' };
  }

  async create(data: any) {
    const input = this.validate(data, true);
    const credential = await this.prisma.companyCredential.create({
      data: {
        name: input.name!,
        category: input.category ?? CompanyCredentialCategory.OTHER,
        provider: input.provider ?? null,
        login_url: input.login_url ?? null,
        username: input.username ?? null,
        password: input.password ? this.encryption.encrypt(input.password) : null,
        notes: input.notes ?? null,
      },
    });
    return this.format(credential);
  }

  /**
   * Partial update. Password: omitted/empty keeps the stored value,
   * a new value replaces it, `clear_password: true` removes it.
   */
  async update(id: number, data: any) {
    await this.getOrThrow(id);
    const input = this.validate(data, false);

    let password: string | null | undefined;
    if (data?.clear_password === true) {
      password = null;
    } else if (input.password) {
      password = this.encryption.encrypt(input.password);
    }

    const credential = await this.prisma.companyCredential.update({
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
    return this.format(credential);
  }

  async remove(id: number) {
    await this.getOrThrow(id);
    await this.prisma.companyCredential.delete({ where: { id } });
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
