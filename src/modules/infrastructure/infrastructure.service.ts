import {
  Injectable,
  ForbiddenException,
  NotFoundException,
  BadRequestException,
  ConflictException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../core/prisma.service';
import { isSuperAdmin } from '../../core/utils/role-access.util';
import { CredentialCryptoService } from '../../core/credential-crypto.service';
import { canRevealCredentials, credentialCryptoHttpError } from '../../core/utils/credential-access.util';
import { CredentialAuditContext, CredentialAuditService } from '../credential-audit/credential-audit.service';
import {
  compactLikePattern,
  expiryFilterWhere,
  expiryOrderBy,
  parseToday,
  searchTerm,
} from './infrastructure-list.util';
import { parseDateOnly, toDateKey } from '../../core/utils/date-only.util';
import { RenewalPeriod, parseRenewalPeriod } from './renewal-period.util';
import { domainStatusFilter, parseDomainProvider, parseDomainStatus } from './domain-options';
import { lockAssetExpiry, recordManualExpiryChange, staleExpiryError } from './asset-renewals.service';

/** Column values for a parsed renewal period: undefined (not sent) leaves both unchanged. */
const renewalPeriodData = (period: RenewalPeriod | null | undefined) =>
  period === undefined
    ? {}
    : { renewal_period_value: period?.value ?? null, renewal_period_unit: period?.unit ?? null };

/** Server columns the form suggestions may show (never username or password). */
const SERVER_SUMMARY_SELECT = { id: true, name: true, provider: true, owner: true, ip_address: true, server_ip: true } as const;

/** AAD identifiers for servers.password; must match on encrypt and decrypt. */
const SERVER_PASSWORD_AAD = { table: 'servers', field: 'password' } as const;

@Injectable()
export class InfrastructureService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly credentialCrypto: CredentialCryptoService,
    private readonly credentialAudit: CredentialAuditService,
  ) {}

  // -------------------------------------------------------------
  // HELPER: ROLE CHECKS & PROJECT SCOPING
  // -------------------------------------------------------------
  private isAdmin(user: any): boolean {
    return isSuperAdmin(user);
  }

  private async getAccessibleProjectIds(user: any): Promise<number[]> {
    if (this.isAdmin(user)) return [];
    const members = await this.prisma.projectMember.findMany({
      where: { user_id: user.id },
      select: { project_id: true },
    });
    return members.map((m) => m.project_id);
  }

  // -------------------------------------------------------------
  // 0. SUMMARY (Infrastructure Overview cards)
  // -------------------------------------------------------------
  /**
   * Totals for the overview cards: COUNT queries over every record the user may see, with the
   * same scoping as the list endpoints (super admins: all; others: servers linked to their
   * projects' domains, and their projects' domains and client credentials). Previously the page
   * counted the rows of a paginated list, so totals stopped at the page size (5).
   * No rows are read, so no passwords are loaded or decrypted.
   */
  async getSummary(user: any): Promise<{ servers: number; domains: number; credentials: number }> {
    if (this.isAdmin(user)) {
      const [servers, domains, credentials] = await Promise.all([
        this.prisma.server.count(),
        this.prisma.domain.count(),
        this.prisma.websiteCredential.count(),
      ]);
      return { servers, domains, credentials };
    }
    const projectIds = await this.getAccessibleProjectIds(user);
    if (projectIds.length === 0) return { servers: 0, domains: 0, credentials: 0 };
    const inProjects = { project_id: { in: projectIds } };
    const [servers, domains, credentials] = await Promise.all([
      this.prisma.server.count({ where: { domains: { some: inProjects } } }),
      this.prisma.domain.count({ where: inProjects }),
      this.prisma.websiteCredential.count({ where: inProjects }),
    ]);
    return { servers, domains, credentials };
  }

  // -------------------------------------------------------------
  // 1. SERVERS
  // -------------------------------------------------------------
  async getServers(
    user: any,
    query: { page?: string; limit?: string; search?: string; all?: string; fields?: string; ordering?: string; expiry?: string; today?: string } = {},
  ) {
    const where: any = {};
    // Validated before any query (400 on bad values)
    const expiryWhere = expiryFilterWhere(query.expiry, parseToday(query.today));
    const orderBy = expiryOrderBy(query.ordering);
    // fields=expiry: unpaginated list of id/name/expiry_date for expiry notifications (no credentials)
    const expiryOnly = query.fields === 'expiry';
    // fields=summary: the form suggestions; only these columns are read (no username or password)
    const summary: { select?: typeof SERVER_SUMMARY_SELECT } = query.fields === 'summary' ? { select: SERVER_SUMMARY_SELECT } : {};
    const shape = (s: any) => (query.fields === 'summary' ? s : this.formatServer(s));

    if (!this.isAdmin(user)) {
      const projectIds = await this.getAccessibleProjectIds(user);
      if (projectIds.length === 0) {
        return query.all === 'true' || expiryOnly ? [] : { count: 0, next: null, previous: null, results: [] };
      }
      where.domains = {
        some: {
          project_id: { in: projectIds },
        },
      };
    }

    // Partial, case-insensitive match (the columns use a case-insensitive collation; Prisma's
    // `mode: 'insensitive'` is not supported on MySQL and made every search fail). Credentials
    // (username, password) are never searched.
    const search = searchTerm(query.search);
    if (search) {
      // The name also matches with spaces ignored ("server1" finds "server 1"). Prisma cannot
      // compare REPLACE(name), so the ids come from a parameterized query and are added as one
      // more alternative: the project scope above still applies to them, and only ids are read.
      const namePattern = compactLikePattern(search);
      const compactNameIds = namePattern
        ? (
            await this.prisma.$queryRaw<Array<{ id: number }>>(
              Prisma.sql`SELECT id FROM servers WHERE REPLACE(LOWER(name), ' ', '') LIKE ${namePattern} ESCAPE '!'`,
            )
          ).map((row) => Number(row.id))
        : [];
      where.OR = [
        { name: { contains: search } },
        { provider: { contains: search } },
        { notes: { contains: search } },
        // also matched by the page's previous (client-side) search
        { owner: { contains: search } },
        { ip_address: { contains: search } },
        // A server's IP may be stored in server_ip instead (set through the API, as in the original app)
        { server_ip: { contains: search } },
        ...(compactNameIds.length ? [{ id: { in: compactNameIds } }] : []),
      ];
    }
    if (expiryWhere) where.AND = [expiryWhere];

    if (expiryOnly) {
      // Selects only these columns, so the password is never read or decrypted
      return this.prisma.server.findMany({
        where: { ...where, expiry_date: { not: null } },
        select: { id: true, name: true, expiry_date: true },
        orderBy: { expiry_date: 'asc' },
      });
    }

    if (query.all === 'true') {
      const servers = await this.prisma.server.findMany({
        where,
        orderBy: { name: 'asc' },
        ...summary,
      });
      return servers.map(shape);
    }

    const pageNum = Math.max(1, Number(query.page) || 1);
    const limitNum = Math.max(1, Number(query.limit) || 5);
    const skip = (pageNum - 1) * limitNum;

    const count = await this.prisma.server.count({ where });

    const results = await this.prisma.server.findMany({
      where,
      orderBy,
      skip,
      take: limitNum,
      ...summary,
    });

    return {
      count,
      next: pageNum * limitNum < count ? `/api/infrastructure/servers?page=${pageNum + 1}` : null,
      previous: pageNum > 1 ? `/api/infrastructure/servers?page=${pageNum - 1}` : null,
      results: results.map(shape),
    };
  }

  /**
   * GET /infrastructure/servers/check-duplicates: warnings for the Add/Edit Server form, never a
   * rejection (server names and IPs may legitimately repeat). Checked across all servers, like
   * domain names; only booleans are returned, so nothing about other servers is revealed.
   * name: same name ignoring case and surrounding spaces; ip: the IP in ip_address or server_ip.
   */
  async checkServerDuplicates(query: { name?: unknown; ip?: unknown; exclude?: unknown }): Promise<{ name: boolean; ip: boolean }> {
    const exclude = query.exclude === undefined || query.exclude === null || query.exclude === '' ? undefined : Number(query.exclude);
    if (exclude !== undefined && (!Number.isInteger(exclude) || exclude <= 0)) {
      throw new BadRequestException('exclude must be a server id.');
    }
    const name = typeof query.name === 'string' ? query.name.trim().toLowerCase() : '';
    const ip = typeof query.ip === 'string' ? query.ip.trim() : '';
    const notSelf = exclude ? Prisma.sql` AND id <> ${exclude}` : Prisma.empty;
    const [byName, byIp] = await Promise.all([
      name ? this.prisma.$queryRaw<Array<{ id: number }>>(Prisma.sql`SELECT id FROM servers WHERE LOWER(TRIM(name)) = ${name}${notSelf} LIMIT 1`) : [],
      ip
        ? this.prisma.$queryRaw<Array<{ id: number }>>(Prisma.sql`SELECT id FROM servers WHERE (TRIM(ip_address) = ${ip} OR TRIM(server_ip) = ${ip})${notSelf} LIMIT 1`)
        : [],
    ]);
    return { name: byName.length > 0, ip: byIp.length > 0 };
  }

  async getServerById(user: any, id: number) {
    const server = await this.prisma.server.findUnique({ where: { id } });
    if (!server) throw new NotFoundException('Server not found');
    // Same scope as the list: non-admins only see servers used by their projects' domains
    if (!this.isAdmin(user)) {
      const projectIds = await this.getAccessibleProjectIds(user);
      const linked = projectIds.length
        ? await this.prisma.domain.count({ where: { server_id: id, project_id: { in: projectIds } } })
        : 0;
      if (!linked) throw new NotFoundException('Server not found');
    }
    return this.formatServer(server);
  }

  /** Non-admins may only read records of projects they are members of (404 otherwise). */
  private async assertProjectReadable(user: any, projectId: number | null | undefined, notFoundMessage: string) {
    if (this.isAdmin(user)) return;
    const projectIds = await this.getAccessibleProjectIds(user);
    if (!projectId || !projectIds.includes(projectId)) throw new NotFoundException(notFoundMessage);
  }

  /**
   * A server belongs to the projects of the domains that use it. Non-super-admins may change or
   * delete it only when it is linked to their projects and to no project they cannot access
   * (otherwise 404, like reads), so a server shared with another project stays untouched.
   * Creating a server is unchanged: it has no project until a domain uses it.
   */
  private async assertServerWritable(user: any, id: number) {
    if (this.isAdmin(user)) return;
    const projectIds = await this.getAccessibleProjectIds(user);
    const linked = await this.prisma.domain.findMany({ where: { server_id: id }, select: { project_id: true } });
    const allAccessible = linked.length > 0 && linked.every((d: any) => d.project_id && projectIds.includes(d.project_id));
    if (!allAccessible) throw new NotFoundException('Server not found');
  }

  async createServer(user: any, data: any, context: CredentialAuditContext) {
    const purchaseDate = this.parseDateOnly(data.purchase_date, 'Purchase date') ?? null;
    const expiryDate = this.parseDateOnly(data.expiry_date, 'Expiry date') ?? null;
    this.validateServerDetails(data.phone_number, purchaseDate, expiryDate);
    const renewalPeriod = parseRenewalPeriod(data.renewal_period_value, data.renewal_period_unit);
    const password = data.password ? String(data.password) : '';
    if (password) this.withCredentialCrypto(() => this.credentialCrypto.assertReady());

    const server = await this.prisma
      .$transaction(async (tx: any) => {
        // The record id is part of the AAD, so the row is created without the password first and
        // the encrypted password added in the same transaction; any failure rolls both back
        let row = await tx.server.create({
          data: {
            name: data.name,
            provider: data.provider || '',
            owner: data.owner || '',
            server_ip: data.server_ip || '',
            ip_address: data.ip_address || '',
            notes: data.notes || '',
            username: data.username || '',
            password: '',
            phone_number: data.phone_number ? String(data.phone_number).trim() : '',
            purchase_date: purchaseDate,
            expiry_date: expiryDate,
            ...renewalPeriodData(renewalPeriod),
          },
        });
        if (password) {
          row = await tx.server.update({ where: { id: row.id }, data: { password: this.encryptServerPassword(password, row.id) } });
          await this.credentialAudit.record(context, { credentialType: 'server', credentialId: row.id, action: 'CREATE' }, tx);
        }
        return row;
      })
      .catch((error: unknown) => {
        throw credentialCryptoHttpError(error);
      });
    return this.formatServer(server);
  }

  async updateServer(user: any, id: number, data: any, context: CredentialAuditContext) {
    const server = await this.prisma.server.findUnique({ where: { id } });
    if (!server) throw new NotFoundException('Server not found');
    await this.assertServerWritable(user, id);

    const purchaseDate = this.parseDateOnly(data.purchase_date, 'Purchase date');
    const expiryDate = this.parseDateOnly(data.expiry_date, 'Expiry date');
    this.validateServerDetails(
      data.phone_number,
      purchaseDate !== undefined ? purchaseDate : server.purchase_date,
      expiryDate !== undefined ? expiryDate : server.expiry_date,
    );
    const renewalPeriod = parseRenewalPeriod(data.renewal_period_value, data.renewal_period_unit);
    const expiry = this.expiryWrite(expiryDate, data.expected_expiry_date, server.expiry_date);

    // The masked placeholder sent back by edit forms must not overwrite the stored password;
    // '' clears it, any other value replaces it
    const password =
      data.password === undefined || data.password === InfrastructureService.PASSWORD_MASK
        ? undefined
        : data.password
          ? (this.withCredentialCrypto(() => this.credentialCrypto.assertReady()), this.encryptServerPassword(String(data.password), id))
          : '';
    const secretChanged = password !== undefined;

    const update = (client: any) => client.server.update({
      where: { id },
      data: {
        name: data.name,
        provider: data.provider,
        owner: data.owner,
        server_ip: data.server_ip,
        ip_address: data.ip_address,
        notes: data.notes,
        username: data.username,
        password,
        phone_number: data.phone_number !== undefined ? (data.phone_number ? String(data.phone_number).trim() : '') : undefined,
        purchase_date: purchaseDate,
        expiry_date: expiry.value,
        ...renewalPeriodData(renewalPeriod),
      },
    });
    // A password change is audited in the same transaction as the write
    const updated =
      expiry.locked || secretChanged
        ? await this.prisma.$transaction(async (tx: any) => {
            const previous = expiry.locked ? await this.lockUnchangedExpiry(tx, 'server', id, expiry.baseline) : undefined;
            const row = await update(tx);
            if (expiry.locked) {
              await recordManualExpiryChange(tx, { type: 'server', id, name: row.name ?? server.name, previous: previous!, next: expiry.value!, user });
            }
            if (secretChanged) {
              await this.credentialAudit.record(context, { credentialType: 'server', credentialId: id, action: 'UPDATE_SECRET' }, tx);
            }
            return row;
          })
        : await update(this.prisma);
    return this.formatServer(updated);
  }

  /**
   * One decrypted server password. Same scope as reads; refusals (permission or scope) are audited
   * as REVEAL_DENIED and the password is returned only after the REVEAL row is written.
   */
  async revealServerPassword(user: any, id: number, context: CredentialAuditContext) {
    const deny = () =>
      this.credentialAudit
        .record(context, { credentialType: 'server', credentialId: id, action: 'REVEAL_DENIED' })
        .catch(() => undefined); // the request is refused either way
    if (!canRevealCredentials(user)) {
      await deny();
      throw new ForbiddenException('You do not have permission to reveal credentials.');
    }
    const server = await this.prisma.server.findUnique({ where: { id }, select: { id: true, password: true } });
    if (!server) throw new NotFoundException('Server not found');
    if (!this.isAdmin(user)) {
      const projectIds = await this.getAccessibleProjectIds(user);
      const linked = projectIds.length
        ? await this.prisma.domain.count({ where: { server_id: id, project_id: { in: projectIds } } })
        : 0;
      if (!linked) {
        await deny();
        throw new NotFoundException('Server not found');
      }
    }
    const password = server.password ? this.readServerPassword(server.password, id) : '';
    await this.credentialAudit.record(context, { credentialType: 'server', credentialId: id, action: 'REVEAL' });
    return { password };
  }

  private encryptServerPassword(plaintext: string, id: number): string {
    return this.withCredentialCrypto(() => this.credentialCrypto.encrypt(plaintext, { ...SERVER_PASSWORD_AAD, recordId: id }));
  }

  /** gcm1, plus the static-key hex servers were written with before (the column is Node-only, no Django values). */
  private readServerPassword(stored: string, id: number): string {
    return this.withCredentialCrypto(() => {
      const format = this.credentialCrypto.classify(stored);
      if (format === 'gcm1') return this.credentialCrypto.decrypt(stored, { ...SERVER_PASSWORD_AAD, recordId: id });
      if (format === 'legacy-cbc-static') return this.credentialCrypto.decryptLegacy(stored).plaintext;
      throw new UnprocessableEntityException(
        'The stored password is not in a recognised encrypted format and needs manual review. Replace it to continue.',
      );
    });
  }

  private withCredentialCrypto<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      throw credentialCryptoHttpError(error);
    }
  }

  /**
   * How an ordinary edit (PUT/PATCH) writes the expiry date, without overwriting a renewal or
   * another edit made meanwhile:
   * - expected_expiry_date (optional) is the expiry the edit form loaded. When the submitted date
   *   equals it, the user did not change the expiry: it is not written at all, so a renewal made
   *   after the form was opened is kept and the other fields are still saved.
   * - Any other expiry write runs in a transaction that locks the row (as renewals do) and is
   *   refused with 409 when the stored expiry is no longer the one the form loaded (or, without
   *   expected_expiry_date, the one read at the start of this request).
   * - expiry_date not sent: the column is not written.
   */
  private expiryWrite(submitted: Date | null | undefined, expectedRaw: unknown, stored: Date | null) {
    const expected = this.parseDateOnly(expectedRaw, 'Expected expiry date');
    const untouched = expected !== undefined && submitted !== undefined && toDateKey(submitted) === toDateKey(expected);
    const value = untouched ? undefined : submitted;
    const locked = value !== undefined && (expected !== undefined || toDateKey(value) !== toDateKey(stored));
    return { value, locked, baseline: expected !== undefined ? expected : stored };
  }

  /** Locks the row and checks the stored expiry is still `baseline` (409 otherwise); returns it. */
  private async lockUnchangedExpiry(tx: any, type: 'domain' | 'server', id: number, baseline: Date | null) {
    const current = await lockAssetExpiry(tx, type, id);
    if (current === undefined) throw new NotFoundException(type === 'domain' ? 'Domain not found' : 'Server not found');
    if (toDateKey(current) !== toDateKey(baseline)) throw staleExpiryError(type, current);
    return current;
  }

  private static readonly PASSWORD_MASK = '••••••••';

  /** Responses never carry the password, for any user: the mask when one is stored, else ''. */
  private formatServer(server: any) {
    return { ...server, password: server.password ? InfrastructureService.PASSWORD_MASK : '' };
  }

  /** Date-only parsing shared by servers and domains (see core/utils/date-only.util). */
  private parseDateOnly(value: any, label: string): Date | null | undefined {
    return parseDateOnly(value, label);
  }

  private validateServerDetails(phoneNumber: any, purchaseDate: Date | null, expiryDate: Date | null) {
    if (phoneNumber && !/^\+?[0-9\s\-().]{7,20}$/.test(String(phoneNumber).trim())) {
      throw new BadRequestException('Phone number may contain only digits, spaces, +, -, ( ) and must be 7-20 characters.');
    }
    this.validateDateOrder(purchaseDate, expiryDate);
  }

  private validateDateOrder(purchaseDate: Date | null | undefined, expiryDate: Date | null | undefined) {
    if (purchaseDate && expiryDate && expiryDate < purchaseDate) {
      throw new BadRequestException('Expiry date cannot be earlier than purchase date.');
    }
  }

  async deleteServer(user: any, id: number, context: CredentialAuditContext) {
    const server = await this.prisma.server.findUnique({ where: { id } });
    if (!server) throw new NotFoundException('Server not found');
    await this.assertServerWritable(user, id);
    // Deleting a server that holds a password is a credential deletion (audited atomically)
    return this.prisma.$transaction(async (tx: any) => {
      const deleted = await tx.server.delete({ where: { id } });
      if (server.password) {
        await this.credentialAudit.record(context, { credentialType: 'server', credentialId: id, action: 'DELETE' }, tx);
      }
      return deleted;
    });
  }

  // -------------------------------------------------------------
  // 2. DOMAINS
  // -------------------------------------------------------------
  async getDomains(
    user: any,
    query: { page?: string; limit?: string; search?: string; all?: string; ordering?: string; expiry?: string; today?: string; status?: string } | string = {},
  ) {
    const queryObj: { page?: string; limit?: string; search?: string; all?: string; ordering?: string; expiry?: string; today?: string; status?: string } =
      typeof query === 'string' ? { search: query } : query;
    const where: any = {};
    // Validated before any query (400 on bad values)
    const expiryWhere = expiryFilterWhere(queryObj.expiry, parseToday(queryObj.today));
    const orderBy = expiryOrderBy(queryObj.ordering);
    // The stored status the user chose (not derived from the expiry date)
    const status = domainStatusFilter(queryObj.status);
    if (status) where.status = status;

    if (!this.isAdmin(user)) {
      const projectIds = await this.getAccessibleProjectIds(user);
      if (projectIds.length === 0) {
        return queryObj.all === 'true' ? [] : { count: 0, next: null, previous: null, results: [] };
      }
      where.project_id = { in: projectIds };
    }

    // Partial match. No `mode: 'insensitive'`: Prisma rejects it on MySQL (every search threw, so
    // the page showed "No domains found"); these columns use a case-insensitive collation
    // (utf8mb4_unicode_ci), so `contains` (LIKE '%term%') already ignores case.
    const search = searchTerm(queryObj.search);
    if (search) {
      where.OR = [
        { domain_name: { contains: search } },
        { provider: { contains: search } },
        { project: { name: { contains: search } } },
        { server: { name: { contains: search } } },
      ];
    }
    if (expiryWhere) where.AND = [expiryWhere];

    if (queryObj.all === 'true') {
      const domains = await this.prisma.domain.findMany({
        where,
        include: {
          project: { select: { id: true, name: true } },
          server: { select: { id: true, name: true } },
        },
        orderBy: { expiry_date: 'desc' },
      });

      return domains.map((d) => ({
        ...d,
        project: d.project_id,
        server: d.server_id,
        project_name: d.project?.name || null,
        server_name: d.server?.name || null,
      }));
    }

    const pageNum = Math.max(1, Number(queryObj.page) || 1);
    const limitNum = Math.max(1, Number(queryObj.limit) || 5);
    const skip = (pageNum - 1) * limitNum;

    const count = await this.prisma.domain.count({ where });

    const domains = await this.prisma.domain.findMany({
      where,
      include: {
        project: { select: { id: true, name: true } },
        server: { select: { id: true, name: true } },
      },
      orderBy,
      skip,
      take: limitNum,
    });

    const formatted = domains.map((d) => ({
      ...d,
      project: d.project_id,
      server: d.server_id,
      project_name: d.project?.name || null,
      server_name: d.server?.name || null,
    }));

    return {
      count,
      next: pageNum * limitNum < count ? `/api/infrastructure/domains?page=${pageNum + 1}` : null,
      previous: pageNum > 1 ? `/api/infrastructure/domains?page=${pageNum - 1}` : null,
      results: formatted,
    };
  }

  async getDomainById(user: any, id: number) {
    const domain = await this.prisma.domain.findUnique({
      where: { id },
      include: {
        project: { select: { id: true, name: true } },
        server: { select: { id: true, name: true } },
      },
    });
    if (!domain) throw new NotFoundException('Domain not found');
    await this.assertProjectReadable(user, domain.project_id, 'Domain not found');

    return {
      ...domain,
      project: domain.project_id,
      server: domain.server_id,
      project_name: domain.project?.name || null,
      server_name: domain.server?.name || null,
    };
  }

  // ---- Domain name uniqueness -----------------------------------------------------------
  // Names are unique ignoring case and surrounding spaces (normalized: trimmed, lower-case).
  // Domains are hard-deleted, so every existing row counts. There is no database UNIQUE
  // constraint yet (existing duplicates must be resolved first; see
  // prisma/proposed-migrations/20261019180000_unique_domain_name), so concurrent saves are
  // serialized in the database instead: the duplicate check is a locking read
  // (SELECT ... FOR UPDATE) inside the same transaction as the insert/update, so a second save of
  // the same name waits for the first to commit and then sees its row.

  static readonly DOMAIN_EXISTS_MESSAGE = 'Domain already exists.';

  /**
   * The stored form of a domain name (case kept for display; comparisons ignore it): trimmed; a
   * pasted http(s):// address is reduced to its host (scheme, user info, port, path, query and
   * fragment removed); one trailing dot removed. "www." is kept: www.example.com and example.com
   * are different domains. Required.
   */
  normalizeDomainName(value: unknown): string {
    let name = typeof value === 'string' ? value.trim() : '';
    const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(name);
    if (scheme && !/^https?$/i.test(scheme[1])) {
      const message = 'Enter a domain name (an http:// or https:// address is also accepted).';
      throw new BadRequestException({ statusCode: 400, error: 'Bad Request', message, domain_name: message });
    }
    if (scheme) name = name.slice(scheme[0].length).replace(/^[^/?#@]*@/, '');
    name = name.split(/[/?#]/)[0].replace(/:\d+$/, '').replace(/\.$/, '').trim();
    if (!name) throw new BadRequestException({ statusCode: 400, error: 'Bad Request', message: 'Domain name is required.', domain_name: 'Domain name is required.' });
    if (name.length > 255) throw new BadRequestException({ statusCode: 400, error: 'Bad Request', message: 'Domain name is too long.', domain_name: 'Domain name is too long.' });
    return name;
  }

  /** 409 with the message on `message` and on the field, for the form. */
  private domainExistsError() {
    const message = InfrastructureService.DOMAIN_EXISTS_MESSAGE;
    return new ConflictException({ statusCode: 409, error: 'Conflict', message, domain_name: message });
  }

  /** Comparison key of a domain name: normalized and lower-case (a stored legacy value that no longer parses falls back to trim/lower-case). */
  private domainKey(value: unknown): string {
    try {
      return this.normalizeDomainName(value).toLowerCase();
    } catch {
      return String(value ?? '').trim().toLowerCase();
    }
  }

  /**
   * Whether another domain has the same normalized name (optionally excluding one record). Stored
   * names are compared trimmed, lower-case and without a trailing dot, so rows saved before the
   * trailing-dot rule still count.
   */
  private async domainNameTaken(client: any, name: string, excludeId?: number, lock = false): Promise<boolean> {
    const key = this.domainKey(name);
    const rows: Array<{ id: number }> = await client.$queryRaw(
      Prisma.sql`SELECT id FROM domains WHERE LOWER(TRIM(TRAILING '.' FROM TRIM(domain_name))) = ${key}${
        excludeId ? Prisma.sql` AND id <> ${excludeId}` : Prisma.empty
      }${lock ? Prisma.sql` FOR UPDATE` : Prisma.empty}`,
    );
    return rows.length > 0;
  }

  /** GET /infrastructure/domains/check-name: availability for the form (MANAGE_INFRASTRUCTURE). */
  async checkDomainName(name: unknown, excludeId?: unknown): Promise<{ exists: boolean }> {
    const normalized = this.normalizeDomainName(name);
    const exclude = excludeId === undefined || excludeId === null || excludeId === '' ? undefined : Number(excludeId);
    if (exclude !== undefined && (!Number.isInteger(exclude) || exclude <= 0)) {
      throw new BadRequestException('exclude must be a domain id.');
    }
    return { exists: await this.domainNameTaken(this.prisma, normalized, exclude) };
  }

  /**
   * Runs a domain write after a locked duplicate check, in one transaction. A deadlock between
   * concurrent saves (InnoDB picks a victim) is retried, and the retry then sees the committed
   * row. A UNIQUE violation (once the constraint exists) maps to the same 409.
   */
  private async writeUniqueDomainName(name: string, excludeId: number | undefined, write: (tx: any) => Promise<any>): Promise<any> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.prisma.$transaction(async (tx: any) => {
          if (await this.domainNameTaken(tx, name, excludeId, true)) throw this.domainExistsError();
          return write(tx);
        });
      } catch (error: any) {
        if (error instanceof ConflictException) throw error;
        if (error?.code === 'P2002') throw this.domainExistsError();
        const deadlock = error?.code === 'P2034' || String(error?.meta?.code) === '1213' || /deadlock/i.test(String(error?.message));
        if (deadlock && attempt < 3) continue;
        throw error;
      }
    }
  }

  async createDomain(user: any, data: any) {
    // Same date-only parsing as servers: invalid dates are a 400 (previously new Date(), so a bad
    // value reached Prisma as an Invalid Date and failed with a 500)
    const purchaseDate = this.parseDateOnly(data.purchase_date, 'Purchase date') ?? null;
    const expiryDate = this.parseDateOnly(data.expiry_date, 'Expiry date') ?? null;
    this.validateDateOrder(purchaseDate, expiryDate);
    const renewalPeriod = parseRenewalPeriod(data.renewal_period_value, data.renewal_period_unit);
    const domainName = this.normalizeDomainName(data.domain_name);
    // Not sent (older clients): Active, the column default
    const status = data.status === undefined || data.status === null || data.status === '' ? 'active' : parseDomainStatus(data.status);
    const provider = parseDomainProvider(data.provider);

    const domain = await this.writeUniqueDomainName(domainName, undefined, (tx) => tx.domain.create({
      data: {
        project_id: this.parseOptionalProjectId(data) ?? null,
        domain_name: domainName,
        provider,
        status,
        purchase_date: purchaseDate,
        expiry_date: expiryDate,
        renewal_cost: data.renewal_cost ? Number(data.renewal_cost) : null,
        server_id: data.server_id || data.server ? Number(data.server_id || data.server) : null,
        notes: data.notes || '',
        ...renewalPeriodData(renewalPeriod),
      },
      include: { project: true, server: true },
    }));

    return {
      ...domain,
      project: domain.project_id,
      server: domain.server_id,
      project_name: domain.project?.name || null,
      server_name: domain.server?.name || null,
    };
  }

  async updateDomain(user: any, id: number, data: any) {
    const existing = await this.prisma.domain.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Domain not found');

    const purchaseDate = this.parseDateOnly(data.purchase_date, 'Purchase date');
    const parsedExpiry = this.parseDateOnly(data.expiry_date, 'Expiry date');
    const expiryDate = parsedExpiry !== undefined ? parsedExpiry : existing.expiry_date;
    // Checked only when a date is being saved, so editing other fields of a record with
    // inconsistent legacy dates still works
    if (purchaseDate !== undefined || parsedExpiry !== undefined) {
      this.validateDateOrder(purchaseDate !== undefined ? purchaseDate : existing.purchase_date, expiryDate);
    }
    const renewalPeriod = parseRenewalPeriod(data.renewal_period_value, data.renewal_period_unit);
    const expiry = this.expiryWrite(parsedExpiry, data.expected_expiry_date, existing.expiry_date);
    // Only a real rename is checked: saving other fields (or re-sending the same name with other
    // spacing/case) never fails, even for a record that already has a duplicate
    const domainName = data.domain_name !== undefined ? this.normalizeDomainName(data.domain_name) : undefined;
    const renamed = domainName !== undefined && this.domainKey(domainName) !== this.domainKey(existing.domain_name);
    // Not sent: unchanged. A provider saved before the list existed may be re-sent as it is
    const status = data.status !== undefined ? parseDomainStatus(data.status) : undefined;
    const provider = data.provider !== undefined ? parseDomainProvider(data.provider, existing.provider) : undefined;

    const updateRow = (client: any) => client.domain.update({
      where: { id },
      data: {
        project_id: this.parseOptionalProjectId(data),
        domain_name: domainName,
        provider,
        status,
        purchase_date: purchaseDate,
        // Not written unless it is being changed (writing back the value read above could undo a
        // renewal committed meanwhile)
        expiry_date: expiry.value,
        renewal_cost: data.renewal_cost !== undefined ? (data.renewal_cost ? Number(data.renewal_cost) : null) : undefined,
        server_id: data.server_id !== undefined ? (data.server_id || data.server ? Number(data.server_id || data.server) : null) : undefined,
        notes: data.notes,
        ...renewalPeriodData(renewalPeriod),
      },
      include: { project: true, server: true },
    });
    // An expiry change locks the row (see expiryWrite) and is recorded in the renewal history, in
    // the same transaction as the update
    const updateDomain = async (client: any) => {
      const previous = expiry.locked ? await this.lockUnchangedExpiry(client, 'domain', id, expiry.baseline) : null;
      const row = await updateRow(client);
      if (expiry.locked) {
        await recordManualExpiryChange(client, { type: 'domain', id, name: row.domain_name ?? existing.domain_name, previous, next: expiry.value!, user });
      }
      return row;
    };
    const domain = renamed
      ? await this.writeUniqueDomainName(domainName!, id, updateDomain)
      : expiry.locked
        ? await this.prisma.$transaction((tx: any) => updateDomain(tx))
        : await updateDomain(this.prisma);

    return {
      ...domain,
      project: domain.project_id,
      server: domain.server_id,
      project_name: domain.project?.name || null,
      server_name: domain.server?.name || null,
    };
  }

  /**
   * Domain project is optional. Reads `project_id` or `project`:
   * not sent -> undefined (unchanged), null/"" -> null (no project), otherwise a positive integer id.
   */
  private parseOptionalProjectId(data: any): number | null | undefined {
    const key = data.project_id !== undefined ? 'project_id' : data.project !== undefined ? 'project' : null;
    if (!key) return undefined;
    const value = data[key];
    if (value === null || value === '') return null;
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) {
      throw new BadRequestException('Project must be a valid project id.');
    }
    return id;
  }

  async deleteDomain(user: any, id: number) {
    const domain = await this.prisma.domain.findUnique({ where: { id } });
    if (!domain) throw new NotFoundException('Domain not found');
    return this.prisma.domain.delete({ where: { id } });
  }

  // Client (website) credentials: WebsiteCredentialsService (website-credentials.service.ts)
}
