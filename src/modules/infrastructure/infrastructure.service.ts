import { Injectable, ForbiddenException, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../core/prisma.service';
import { isSuperAdmin } from '../../core/utils/role-access.util';
import * as crypto from 'crypto';
import { expiryFilterWhere, expiryOrderBy, parseToday, searchTerm } from './infrastructure-list.util';
import { parseDateOnly, toDateKey } from '../../core/utils/date-only.util';
import { RenewalPeriod, parseRenewalPeriod } from './renewal-period.util';
import { domainStatusFilter, parseDomainProvider, parseDomainStatus } from './domain-options';
import { lockAssetExpiry, recordManualExpiryChange, staleExpiryError } from './asset-renewals.service';

/** Column values for a parsed renewal period: undefined (not sent) leaves both unchanged. */
const renewalPeriodData = (period: RenewalPeriod | null | undefined) =>
  period === undefined
    ? {}
    : { renewal_period_value: period?.value ?? null, renewal_period_unit: period?.unit ?? null };

@Injectable()
export class InfrastructureService {
  constructor(private readonly prisma: PrismaService) {}

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
      where.OR = [
        { name: { contains: search } },
        { provider: { contains: search } },
        { notes: { contains: search } },
        // also matched by the page's previous (client-side) search
        { owner: { contains: search } },
        { ip_address: { contains: search } },
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

    const isAdm = this.isAdmin(user);

    if (query.all === 'true') {
      const servers = await this.prisma.server.findMany({
        where,
        orderBy: { name: 'asc' },
      });
      return servers.map((s) => this.formatServer(s, isAdm));
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
    });

    return {
      count,
      next: pageNum * limitNum < count ? `/api/infrastructure/servers?page=${pageNum + 1}` : null,
      previous: pageNum > 1 ? `/api/infrastructure/servers?page=${pageNum - 1}` : null,
      results: results.map((s) => this.formatServer(s, isAdm)),
    };
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
    return this.formatServer(server, this.isAdmin(user));
  }

  /** Non-admins may only read records of projects they are members of (404 otherwise). */
  private async assertProjectReadable(user: any, projectId: number | null | undefined, notFoundMessage: string) {
    if (this.isAdmin(user)) return;
    const projectIds = await this.getAccessibleProjectIds(user);
    if (!projectId || !projectIds.includes(projectId)) throw new NotFoundException(notFoundMessage);
  }

  async createServer(user: any, data: any) {
    const purchaseDate = this.parseDateOnly(data.purchase_date, 'Purchase date') ?? null;
    const expiryDate = this.parseDateOnly(data.expiry_date, 'Expiry date') ?? null;
    this.validateServerDetails(data.phone_number, purchaseDate, expiryDate);
    const renewalPeriod = parseRenewalPeriod(data.renewal_period_value, data.renewal_period_unit);

    const server = await this.prisma.server.create({
      data: {
        name: data.name,
        provider: data.provider || '',
        owner: data.owner || '',
        server_ip: data.server_ip || '',
        ip_address: data.ip_address || '',
        notes: data.notes || '',
        username: data.username || '',
        password: data.password ? this.encryptPassword(data.password) : '',
        phone_number: data.phone_number ? String(data.phone_number).trim() : '',
        purchase_date: purchaseDate,
        expiry_date: expiryDate,
        ...renewalPeriodData(renewalPeriod),
      },
    });
    return this.formatServer(server, this.isAdmin(user));
  }

  async updateServer(user: any, id: number, data: any) {
    const server = await this.prisma.server.findUnique({ where: { id } });
    if (!server) throw new NotFoundException('Server not found');

    const purchaseDate = this.parseDateOnly(data.purchase_date, 'Purchase date');
    const expiryDate = this.parseDateOnly(data.expiry_date, 'Expiry date');
    this.validateServerDetails(
      data.phone_number,
      purchaseDate !== undefined ? purchaseDate : server.purchase_date,
      expiryDate !== undefined ? expiryDate : server.expiry_date,
    );
    const renewalPeriod = parseRenewalPeriod(data.renewal_period_value, data.renewal_period_unit);
    const expiry = this.expiryWrite(expiryDate, data.expected_expiry_date, server.expiry_date);

    // The masked placeholder sent back by non-admins must not overwrite the stored password
    const password =
      data.password === undefined || data.password === InfrastructureService.PASSWORD_MASK
        ? undefined
        : data.password ? this.encryptPassword(data.password) : '';

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
    const updated = expiry.locked
      ? await this.prisma.$transaction(async (tx: any) => {
          const previous = await this.lockUnchangedExpiry(tx, 'server', id, expiry.baseline);
          const row = await update(tx);
          await recordManualExpiryChange(tx, { type: 'server', id, name: row.name ?? server.name, previous, next: expiry.value!, user });
          return row;
        })
      : await update(this.prisma);
    return this.formatServer(updated, this.isAdmin(user));
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

  private formatServer(server: any, isAdm: boolean) {
    if (!server.password) return server;
    return {
      ...server,
      password: isAdm ? this.decryptPassword(server.password) : InfrastructureService.PASSWORD_MASK,
    };
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

  async deleteServer(user: any, id: number) {
    const server = await this.prisma.server.findUnique({ where: { id } });
    if (!server) throw new NotFoundException('Server not found');
    return this.prisma.server.delete({ where: { id } });
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

  /** The stored form of a domain name: trimmed (case kept for display). Required. */
  normalizeDomainName(value: unknown): string {
    const name = typeof value === 'string' ? value.trim() : '';
    if (!name) throw new BadRequestException({ statusCode: 400, error: 'Bad Request', message: 'Domain name is required.', domain_name: 'Domain name is required.' });
    if (name.length > 255) throw new BadRequestException({ statusCode: 400, error: 'Bad Request', message: 'Domain name is too long.', domain_name: 'Domain name is too long.' });
    return name;
  }

  /** 409 with the message on `message` and on the field, for the form. */
  private domainExistsError() {
    const message = InfrastructureService.DOMAIN_EXISTS_MESSAGE;
    return new ConflictException({ statusCode: 409, error: 'Conflict', message, domain_name: message });
  }

  /** Whether another domain has the same normalized name (optionally excluding one record). */
  private async domainNameTaken(client: any, name: string, excludeId?: number, lock = false): Promise<boolean> {
    const key = name.trim().toLowerCase();
    const rows: Array<{ id: number }> = await client.$queryRaw(
      Prisma.sql`SELECT id FROM domains WHERE LOWER(TRIM(domain_name)) = ${key}${
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
    const renamed = domainName !== undefined && domainName.toLowerCase() !== String(existing.domain_name).trim().toLowerCase();
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

  // -------------------------------------------------------------
  // 3. WEBSITE CREDENTIALS
  private formatCredential(c: any, isAdm: boolean) {
    const res: any = {
      ...c,
      project: c.project_id,
      domain: c.domain_id,
      project_name: c.project?.name || null,
      domain_name: c.domain?.domain_name || null,
    };

    if (!isAdm) {
      if (res.admin_password) res.admin_password = '••••••••';
      if (res.cpanel_password) res.cpanel_password = '••••••••';
      if (res.ftp_password) res.ftp_password = '••••••••';
      if (res.client_email_password) res.client_email_password = '••••••••';
      if (res.business_email_password) res.business_email_password = '••••••••';
    } else {
      if (res.admin_password) res.admin_password = this.decryptPassword(res.admin_password);
      if (res.cpanel_password) res.cpanel_password = this.decryptPassword(res.cpanel_password);
      if (res.ftp_password) res.ftp_password = this.decryptPassword(res.ftp_password);
      if (res.client_email_password) res.client_email_password = this.decryptPassword(res.client_email_password);
      if (res.business_email_password) res.business_email_password = this.decryptPassword(res.business_email_password);
    }

    return res;
  }

  // -------------------------------------------------------------
  // 3. WEBSITE CREDENTIALS
  // -------------------------------------------------------------
  async getCredentials(user: any, query: { page?: string; limit?: string; search?: string; all?: string } = {}) {
    const where: any = {};

    if (!this.isAdmin(user)) {
      const projectIds = await this.getAccessibleProjectIds(user);
      if (projectIds.length === 0) {
        return query.all === 'true' ? [] : { count: 0, next: null, previous: null, results: [] };
      }
      where.project_id = { in: projectIds };
    }

    if (query.search) {
      where.OR = [
        { url: { contains: query.search, mode: 'insensitive' } },
        { username: { contains: query.search, mode: 'insensitive' } },
        { project: { name: { contains: query.search, mode: 'insensitive' } } },
      ];
    }

    const isAdm = this.isAdmin(user);

    if (query.all === 'true') {
      const credentials = await this.prisma.websiteCredential.findMany({
        where,
        include: {
          project: { select: { id: true, name: true } },
          domain: { select: { id: true, domain_name: true } },
        },
        orderBy: { created_at: 'desc' },
      });

      return credentials.map((c) => this.formatCredential(c, isAdm));
    }

    const pageNum = Math.max(1, Number(query.page) || 1);
    const limitNum = Math.max(1, Number(query.limit) || 5);
    const skip = (pageNum - 1) * limitNum;

    const count = await this.prisma.websiteCredential.count({ where });

    const credentials = await this.prisma.websiteCredential.findMany({
      where,
      include: {
        project: { select: { id: true, name: true } },
        domain: { select: { id: true, domain_name: true } },
      },
      orderBy: { id: 'desc' },
      skip,
      take: limitNum,
    });

    const formatted = credentials.map((c) => this.formatCredential(c, isAdm));

    return {
      count,
      next: pageNum * limitNum < count ? `/api/infrastructure/credentials?page=${pageNum + 1}` : null,
      previous: pageNum > 1 ? `/api/infrastructure/credentials?page=${pageNum - 1}` : null,
      results: formatted,
    };
  }

  async getCredentialById(user: any, id: number) {
    const c = await this.prisma.websiteCredential.findUnique({
      where: { id },
      include: {
        project: { select: { id: true, name: true } },
        domain: { select: { id: true, domain_name: true } },
      },
    });
    if (!c) throw new NotFoundException('Credential not found');
    await this.assertProjectReadable(user, c.project_id, 'Credential not found');

    const isAdm = this.isAdmin(user);
    const res: any = {
      ...c,
      project: c.project_id,
      domain: c.domain_id,
      project_name: c.project?.name || null,
      domain_name: c.domain?.domain_name || null,
    };

    if (!isAdm) {
      if (res.admin_password) res.admin_password = '••••••••';
      if (res.cpanel_password) res.cpanel_password = '••••••••';
      if (res.ftp_password) res.ftp_password = '••••••••';
      if (res.client_email_password) res.client_email_password = '••••••••';
      if (res.business_email_password) res.business_email_password = '••••••••';
    } else {
      if (res.admin_password) res.admin_password = this.decryptPassword(res.admin_password);
      if (res.cpanel_password) res.cpanel_password = this.decryptPassword(res.cpanel_password);
      if (res.ftp_password) res.ftp_password = this.decryptPassword(res.ftp_password);
      if (res.client_email_password) res.client_email_password = this.decryptPassword(res.client_email_password);
      if (res.business_email_password) res.business_email_password = this.decryptPassword(res.business_email_password);
    }

    return res;
  }

  async createCredential(user: any, data: any) {
    const cred = await this.prisma.websiteCredential.create({
      data: {
        project_id: Number(data.project_id || data.project),
        domain_id: Number(data.domain_id || data.domain),
        admin_url: data.admin_url || '',
        admin_username: data.admin_username || '',
        admin_password: data.admin_password ? this.encryptPassword(data.admin_password) : '',
        cpanel_url: data.cpanel_url || '',
        cpanel_username: data.cpanel_username || '',
        cpanel_password: data.cpanel_password ? this.encryptPassword(data.cpanel_password) : '',
        ftp_host: data.ftp_host || '',
        ftp_username: data.ftp_username || '',
        ftp_password: data.ftp_password ? this.encryptPassword(data.ftp_password) : '',
        contact_form_email: data.contact_form_email || '',
        client_email: data.client_email || '',
        client_email_password: data.client_email_password ? this.encryptPassword(data.client_email_password) : '',
        business_email: data.business_email || null,
        business_email_password: data.business_email_password ? this.encryptPassword(data.business_email_password) : null,
        business_email_type: data.business_email_type || null,
        notes: data.notes || '',
      },
      include: { project: true, domain: true },
    });

    return {
      ...cred,
      project: cred.project_id,
      domain: cred.domain_id,
      project_name: cred.project?.name || null,
      domain_name: cred.domain?.domain_name || null,
      admin_password: data.admin_password || '',
      cpanel_password: data.cpanel_password || '',
      ftp_password: data.ftp_password || '',
      client_email_password: data.client_email_password || '',
      business_email_password: data.business_email_password || '',
    };
  }

  async updateCredential(user: any, id: number, data: any) {
    const existing = await this.prisma.websiteCredential.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Credential not found');

    // The masked placeholder sent back by edit forms must not overwrite the stored password
    const pw = (value: any, empty: '' | null) =>
      value === undefined || value === InfrastructureService.PASSWORD_MASK ? undefined : value ? this.encryptPassword(value) : empty;

    const cred = await this.prisma.websiteCredential.update({
      where: { id },
      data: {
        project_id: data.project_id || data.project ? Number(data.project_id || data.project) : undefined,
        domain_id: data.domain_id || data.domain ? Number(data.domain_id || data.domain) : undefined,
        admin_url: data.admin_url,
        admin_username: data.admin_username,
        admin_password: pw(data.admin_password, ''),
        cpanel_url: data.cpanel_url,
        cpanel_username: data.cpanel_username,
        cpanel_password: pw(data.cpanel_password, ''),
        ftp_host: data.ftp_host,
        ftp_username: data.ftp_username,
        ftp_password: pw(data.ftp_password, ''),
        contact_form_email: data.contact_form_email,
        client_email: data.client_email,
        client_email_password: pw(data.client_email_password, ''),
        business_email: data.business_email,
        business_email_password: pw(data.business_email_password, null),
        business_email_type: data.business_email_type,
        notes: data.notes,
      },
      include: { project: true, domain: true },
    });

    // Same masking/decryption as reads (previously returned the stored ciphertext)
    return this.formatCredential(cred, this.isAdmin(user));
  }

  async deleteCredential(user: any, id: number) {
    const cred = await this.prisma.websiteCredential.findUnique({ where: { id } });
    if (!cred) throw new NotFoundException('Credential not found');
    return this.prisma.websiteCredential.delete({ where: { id } });
  }

  // -------------------------------------------------------------
  // ENCRYPTION HELPERS
  // -------------------------------------------------------------
  private encryptPassword(text: string): string {
    if (!text) return '';
    try {
      const cipher = crypto.createCipheriv(
        'aes-256-cbc',
        Buffer.from('12345678901234567890123456789012'),
        Buffer.from('1234567890123456'),
      );
      let encrypted = cipher.update(text, 'utf8', 'hex');
      encrypted += cipher.final('hex');
      return encrypted;
    } catch {
      return text;
    }
  }

  private decryptPassword(text: string): string {
    if (!text) return '';
    try {
      const decipher = crypto.createDecipheriv(
        'aes-256-cbc',
        Buffer.from('12345678901234567890123456789012'),
        Buffer.from('1234567890123456'),
      );
      let decrypted = decipher.update(text, 'hex', 'utf8');
      decrypted += decipher.final('utf8');
      return decrypted;
    } catch {
      return text;
    }
  }
}
