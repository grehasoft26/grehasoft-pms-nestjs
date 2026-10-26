import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../core/prisma.service';

export const CREDENTIAL_AUDIT_ACTIONS = ['REVEAL', 'REVEAL_DENIED', 'CREATE', 'UPDATE_SECRET', 'DELETE'] as const;
export type CredentialAuditAction = (typeof CREDENTIAL_AUDIT_ACTIONS)[number];

/** Credential stores that write audit rows. Others are added as they move to the vault. */
export const CREDENTIAL_AUDIT_TYPES = ['company', 'website', 'server', 'seo', 'seo_work_log'] as const;
export type CredentialAuditType = (typeof CREDENTIAL_AUDIT_TYPES)[number];

/** Who did it and from where; taken from the authenticated request. */
export interface CredentialAuditContext {
  actorId: number | null;
  actorUsername: string;
  ipAddress: string | null;
  userAgent: string | null;
}

export const auditContextFrom = (req: any): CredentialAuditContext => {
  const userAgent = req?.headers?.['user-agent'];
  return {
    actorId: Number(req?.user?.id) || null,
    actorUsername: String(req?.user?.username ?? '').slice(0, 150) || 'unknown',
    // Socket address (the app does not trust X-Forwarded-For)
    ipAddress: req?.ip ? String(req.ip).slice(0, 45) : null,
    userAgent: typeof userAgent === 'string' && userAgent ? userAgent.slice(0, 255) : null,
  };
};

/**
 * Append-only credential audit trail (credential_audit_logs). Rows hold the actor, the
 * credential type and id, the action, time, IP and user agent: never plaintext, ciphertext or
 * keys. There is no update or delete API. Retention is one year (deletion is not automated yet).
 */
@Injectable()
export class CredentialAuditService {
  constructor(private readonly prisma: PrismaService) {}

  /** Pass the transaction client to record the event atomically with the change it describes. */
  record(
    context: CredentialAuditContext,
    event: { credentialType: CredentialAuditType; credentialId: number | null; action: CredentialAuditAction },
    client: any = this.prisma,
  ) {
    return client.credentialAuditLog.create({
      data: {
        actor_id: context.actorId,
        actor_username: context.actorUsername,
        credential_type: event.credentialType,
        credential_id: event.credentialId,
        action: event.action,
        ip_address: context.ipAddress,
        user_agent: context.userAgent,
      },
    });
  }

  async findAll(query: { page?: string; limit?: string; credential_type?: string; credential_id?: string; action?: string; actor_id?: string } = {}) {
    const where: any = {};
    if (query.credential_type) {
      if (!(CREDENTIAL_AUDIT_TYPES as readonly string[]).includes(query.credential_type)) {
        throw new BadRequestException(`credential_type must be one of: ${CREDENTIAL_AUDIT_TYPES.join(', ')}.`);
      }
      where.credential_type = query.credential_type;
    }
    if (query.action) {
      const action = String(query.action).toUpperCase();
      if (!(CREDENTIAL_AUDIT_ACTIONS as readonly string[]).includes(action)) {
        throw new BadRequestException(`action must be one of: ${CREDENTIAL_AUDIT_ACTIONS.join(', ')}.`);
      }
      where.action = action;
    }
    for (const [param, column] of [['credential_id', 'credential_id'], ['actor_id', 'actor_id']] as const) {
      if (query[param] === undefined || query[param] === '') continue;
      const id = Number(query[param]);
      if (!Number.isInteger(id) || id <= 0) throw new BadRequestException(`${param} must be a positive integer.`);
      where[column] = id;
    }

    const pageNum = Math.max(1, Number(query.page) || 1);
    const limitNum = Math.min(100, Math.max(1, Number(query.limit) || 20));
    const count = await this.prisma.credentialAuditLog.count({ where });
    const results = await this.prisma.credentialAuditLog.findMany({
      where,
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      skip: (pageNum - 1) * limitNum,
      take: limitNum,
    });
    return {
      count,
      next: pageNum * limitNum < count ? `/api/credential-audit?page=${pageNum + 1}` : null,
      previous: pageNum > 1 ? `/api/credential-audit?page=${pageNum - 1}` : null,
      results,
    };
  }
}
