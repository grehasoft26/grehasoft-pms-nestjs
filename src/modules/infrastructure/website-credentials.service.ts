import { BadRequestException, ForbiddenException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService } from '../../core/prisma.service';
import { CredentialCryptoService } from '../../core/credential-crypto.service';
import { isSuperAdmin } from '../../core/utils/role-access.util';
import { canRevealCredentials, credentialCryptoHttpError } from '../../core/utils/credential-access.util';
import { CredentialAuditContext, CredentialAuditService } from '../credential-audit/credential-audit.service';
import { searchTerm } from './infrastructure-list.util';

/** The five secret columns of website_credentials. */
export const WEBSITE_PASSWORD_FIELDS = [
  'admin_password',
  'cpanel_password',
  'ftp_password',
  'client_email_password',
  'business_email_password',
] as const;
export type WebsitePasswordField = (typeof WEBSITE_PASSWORD_FIELDS)[number];

/** Placeholder returned for a stored password; sent back unchanged by edit forms it is ignored. */
export const PASSWORD_MASK = '••••••••';

const TABLE = 'website_credentials';
/** business_email_password is nullable; the other four store '' when empty. */
const emptyValue = (field: WebsitePasswordField) => (field === 'business_email_password' ? null : '');
const RELATIONS = {
  project: { select: { id: true, name: true } },
  domain: { select: { id: true, domain_name: true } },
};

/**
 * Client (website) credentials, also shown per domain (records are linked by domain_id).
 *
 * Passwords: new values are encrypted with CredentialCryptoService (AES-256-GCM, AAD bound to
 * table, field and record id). Responses only ever contain the masked placeholder, for every
 * user; plaintext is returned one field at a time by revealPassword (REVEAL_CREDENTIALS, audited,
 * project-scoped). Existing static-key and Django Fernet values stay readable; anything else is
 * refused for manual review. Stored values are never rewritten by reads.
 *
 * Scope: non-super-admins only see and change credentials of projects they are members of.
 */
@Injectable()
export class WebsiteCredentialsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CredentialCryptoService,
    private readonly audit: CredentialAuditService,
  ) {}

  private async accessibleProjectIds(user: any): Promise<number[] | 'all'> {
    if (isSuperAdmin(user)) return 'all';
    const members = await this.prisma.projectMember.findMany({ where: { user_id: user.id }, select: { project_id: true } });
    return members.map((m: any) => m.project_id);
  }

  /** Non-super-admins must be members of the project (404 otherwise, like reads). */
  private async assertProjectAccess(user: any, projectId: number | null | undefined, notFoundMessage: string) {
    const ids = await this.accessibleProjectIds(user);
    if (ids === 'all') return;
    if (!projectId || !ids.includes(projectId)) throw new NotFoundException(notFoundMessage);
  }

  /** Response shape: relation names added, every password replaced by the mask (or left empty). */
  private format(c: any) {
    const res: any = {
      ...c,
      project: c.project_id,
      domain: c.domain_id,
      project_name: c.project?.name || null,
      domain_name: c.domain?.domain_name || null,
    };
    for (const field of WEBSITE_PASSWORD_FIELDS) res[field] = c[field] ? PASSWORD_MASK : emptyValue(field);
    return res;
  }

  async getCredentials(user: any, query: { page?: string; limit?: string; search?: string; all?: string } = {}) {
    const where: any = {};
    const ids = await this.accessibleProjectIds(user);
    if (ids !== 'all') {
      if (ids.length === 0) return query.all === 'true' ? [] : { count: 0, next: null, previous: null, results: [] };
      where.project_id = { in: ids };
    }

    // Columns use utf8mb4_unicode_ci, so `contains` (LIKE) is already case-insensitive on
    // MySQL/MariaDB; Prisma's `mode: 'insensitive'` is not supported there. Passwords are never searched.
    const search = searchTerm(query.search);
    if (search) {
      where.OR = [
        { admin_url: { contains: search } },
        { admin_username: { contains: search } },
        { cpanel_url: { contains: search } },
        { cpanel_username: { contains: search } },
        { ftp_host: { contains: search } },
        { ftp_username: { contains: search } },
        { client_email: { contains: search } },
        { business_email: { contains: search } },
        { project: { name: { contains: search } } },
        { domain: { domain_name: { contains: search } } },
      ];
    }

    if (query.all === 'true') {
      const rows = await this.prisma.websiteCredential.findMany({ where, include: RELATIONS, orderBy: { created_at: 'desc' } });
      return rows.map((c: any) => this.format(c));
    }

    const pageNum = Math.max(1, Number(query.page) || 1);
    const limitNum = Math.max(1, Number(query.limit) || 5);
    const count = await this.prisma.websiteCredential.count({ where });
    const rows = await this.prisma.websiteCredential.findMany({
      where,
      include: RELATIONS,
      orderBy: { id: 'desc' },
      skip: (pageNum - 1) * limitNum,
      take: limitNum,
    });
    return {
      count,
      next: pageNum * limitNum < count ? `/api/infrastructure/credentials?page=${pageNum + 1}` : null,
      previous: pageNum > 1 ? `/api/infrastructure/credentials?page=${pageNum - 1}` : null,
      results: rows.map((c: any) => this.format(c)),
    };
  }

  async getCredentialById(user: any, id: number) {
    const c = await this.prisma.websiteCredential.findUnique({ where: { id }, include: RELATIONS });
    if (!c) throw new NotFoundException('Credential not found');
    await this.assertProjectAccess(user, c.project_id, 'Credential not found');
    return this.format(c);
  }

  async createCredential(user: any, data: any, context: CredentialAuditContext) {
    const projectId = this.parseId(data.project_id ?? data.project, 'project');
    const domainId = this.parseId(data.domain_id ?? data.domain, 'domain');
    await this.assertProjectAccess(user, projectId, 'Project not found');
    await this.assertDomainInProject(domainId, projectId);

    const secrets = WEBSITE_PASSWORD_FIELDS.filter((f) => data[f]);
    if (secrets.length) this.withCrypto(() => this.crypto.assertReady());

    const row = await this.prisma
      .$transaction(async (tx: any) => {
        // The record id is part of the AAD, so the row is created without secrets first and the
        // secrets are added in the same transaction; any failure rolls both back
        let cred = await tx.websiteCredential.create({
          data: {
            project_id: projectId,
            domain_id: domainId,
            admin_url: data.admin_url || '',
            admin_username: data.admin_username || '',
            cpanel_url: data.cpanel_url || '',
            cpanel_username: data.cpanel_username || '',
            ftp_host: data.ftp_host || '',
            ftp_username: data.ftp_username || '',
            contact_form_email: data.contact_form_email || '',
            client_email: data.client_email || '',
            business_email: data.business_email || null,
            business_email_type: data.business_email_type || null,
            notes: data.notes || '',
            ...Object.fromEntries(WEBSITE_PASSWORD_FIELDS.map((f) => [f, emptyValue(f)])),
          },
          include: RELATIONS,
        });
        if (secrets.length) {
          cred = await tx.websiteCredential.update({
            where: { id: cred.id },
            data: Object.fromEntries(secrets.map((f) => [f, this.encrypt(String(data[f]), cred.id, f)])),
            include: RELATIONS,
          });
        }
        await this.audit.record(context, { credentialType: 'website', credentialId: cred.id, action: 'CREATE' }, tx);
        return cred;
      })
      .catch((error: unknown) => {
        throw credentialCryptoHttpError(error);
      });
    return this.format(row);
  }

  async updateCredential(user: any, id: number, data: any, context: CredentialAuditContext) {
    const existing = await this.prisma.websiteCredential.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Credential not found');
    await this.assertProjectAccess(user, existing.project_id, 'Credential not found');

    const projectId = data.project_id || data.project ? this.parseId(data.project_id ?? data.project, 'project') : undefined;
    const domainId = data.domain_id || data.domain ? this.parseId(data.domain_id ?? data.domain, 'domain') : undefined;
    if (projectId !== undefined && projectId !== existing.project_id) await this.assertProjectAccess(user, projectId, 'Project not found');
    if (projectId !== undefined || domainId !== undefined) {
      await this.assertDomainInProject(domainId ?? existing.domain_id, projectId ?? existing.project_id);
    }

    // undefined or the masked placeholder keeps the stored value; '' clears it; anything else replaces it
    const changes = WEBSITE_PASSWORD_FIELDS.filter((f) => data[f] !== undefined && data[f] !== PASSWORD_MASK);
    if (changes.some((f) => data[f])) this.withCrypto(() => this.crypto.assertReady());
    const passwordData = Object.fromEntries(
      changes.map((f) => [f, data[f] ? this.encrypt(String(data[f]), id, f) : emptyValue(f)]),
    );

    const row = await this.prisma.$transaction(async (tx: any) => {
      const cred = await tx.websiteCredential.update({
        where: { id },
        data: {
          project_id: projectId,
          domain_id: domainId,
          admin_url: data.admin_url,
          admin_username: data.admin_username,
          cpanel_url: data.cpanel_url,
          cpanel_username: data.cpanel_username,
          ftp_host: data.ftp_host,
          ftp_username: data.ftp_username,
          contact_form_email: data.contact_form_email,
          client_email: data.client_email,
          business_email: data.business_email,
          business_email_type: data.business_email_type,
          notes: data.notes,
          ...passwordData,
        },
        include: RELATIONS,
      });
      if (changes.length) {
        await this.audit.record(context, { credentialType: 'website', credentialId: id, action: 'UPDATE_SECRET' }, tx);
      }
      return cred;
    });
    return this.format(row);
  }

  async deleteCredential(user: any, id: number, context: CredentialAuditContext) {
    const existing = await this.prisma.websiteCredential.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Credential not found');
    await this.assertProjectAccess(user, existing.project_id, 'Credential not found');
    await this.prisma.$transaction(async (tx: any) => {
      await tx.websiteCredential.delete({ where: { id } });
      await this.audit.record(context, { credentialType: 'website', credentialId: id, action: 'DELETE' }, tx);
    });
  }

  /**
   * One decrypted password. Refusals (permission or project scope) are audited as REVEAL_DENIED;
   * the secret is returned only after the REVEAL row is written.
   */
  async revealPassword(user: any, id: number, field: unknown, context: CredentialAuditContext) {
    const deny = async () => {
      await this.audit
        .record(context, { credentialType: 'website', credentialId: id, action: 'REVEAL_DENIED' })
        .catch(() => undefined); // the request is refused either way
    };
    if (!canRevealCredentials(user)) {
      await deny();
      throw new ForbiddenException('You do not have permission to reveal credentials.');
    }
    if (typeof field !== 'string' || !(WEBSITE_PASSWORD_FIELDS as readonly string[]).includes(field)) {
      throw new BadRequestException(`field must be one of: ${WEBSITE_PASSWORD_FIELDS.join(', ')}.`);
    }
    const cred: any = await this.prisma.websiteCredential.findUnique({ where: { id } });
    if (!cred) throw new NotFoundException('Credential not found');
    try {
      await this.assertProjectAccess(user, cred.project_id, 'Credential not found');
    } catch (error) {
      await deny();
      throw error;
    }

    const stored = cred[field];
    const password = stored ? this.read(stored, id, field as WebsitePasswordField) : '';
    await this.audit.record(context, { credentialType: 'website', credentialId: id, action: 'REVEAL' });
    return { field, password };
  }

  private encrypt(plaintext: string, id: number, field: WebsitePasswordField): string {
    return this.withCrypto(() => this.crypto.encrypt(plaintext, { table: TABLE, field, recordId: id }));
  }

  /** gcm1, plus the formats this table held before (static-key hex, Django Fernet). */
  private read(stored: string, id: number, field: WebsitePasswordField): string {
    return this.withCrypto(() => {
      const format = this.crypto.classify(stored);
      if (format === 'gcm1') return this.crypto.decrypt(stored, { table: TABLE, field, recordId: id });
      if (format === 'legacy-cbc-static' || format === 'legacy-fernet') return this.crypto.decryptLegacy(stored).plaintext;
      throw new UnprocessableEntityException(
        'The stored password is not in a recognised encrypted format and needs manual review. Replace it to continue.',
      );
    });
  }

  private withCrypto<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      throw credentialCryptoHttpError(error);
    }
  }

  private parseId(value: unknown, label: string): number {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) throw new BadRequestException(`A valid ${label} is required.`);
    return id;
  }

  /** The domain must exist and, when it belongs to a project, to the credential's project. */
  private async assertDomainInProject(domainId: number, projectId: number) {
    const domain = await this.prisma.domain.findUnique({ where: { id: domainId }, select: { id: true, project_id: true } });
    if (!domain) throw new BadRequestException('Domain not found.');
    if (domain.project_id && domain.project_id !== projectId) {
      throw new BadRequestException('The domain belongs to a different project.');
    }
  }
}
