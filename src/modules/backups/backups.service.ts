import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
} from '@nestjs/common';
import { PrismaService } from '../../core/prisma.service';
import { PdfService } from '../../core/pdf.service';
import { GenerateBackupDto } from './dto/generate-backup.dto';
import { BackupCategory } from './enums/backup-category.enum';
import { BackupRecord, BackupType, BackupStatus } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as unzipper from 'unzipper';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const archiver = require('archiver');

const execAsync = promisify(exec);

const ENTITY_DISPLAY_NAMES: Record<string, string> = {
  invoices: 'Invoices',
  invoice_items: 'Invoice Items',
  invoice_payments: 'Invoice Payments',
  proposals: 'Proposals',
  proposal_items: 'Proposal Items',
  clients: 'Clients / CRM',
  leads: 'Leads',
  lead_assignments: 'Lead Assignments',
  lead_followups: 'Lead Followups',
  portal_user_audit: 'Portal User Audits',
  projects: 'Projects',
  milestones: 'Milestones',
  project_members: 'Project Members',
  project_activity_logs: 'Project Activity Logs',
  tasks: 'Tasks',
  task_types: 'Task Types',
  task_assignments: 'Task Assignments',
  task_progress: 'Task Progress Updates',
  task_files: 'Task Files & Attachments',
  task_reviews: 'Task Reviews',
  task_comments: 'Task Comments',
  global_activity_logs: 'Global Activity Logs',
  employees: 'Employees',
  hr_documents: 'HR Documents',
  users: 'Team Members',
  roles: 'Roles & Permissions',
  departments: 'Departments',
  reminders: 'Reminders',
  servers: 'Servers',
  domains: 'Domains',
  website_credentials: 'Website Credentials',
  seo_website: 'SEO Websites',
  seo_keyword: 'SEO Keywords',
  seo_daily_work_log: 'SEO Daily Work Logs',
  seo_daily_work_proof: 'SEO Proof Files',
  seo_daily_work_log_item: 'SEO Work Log Items',
  seo_monthly_target: 'SEO Monthly Targets',
  seo_task: 'SEO Tasks',
  seo_reminder: 'SEO Reminders',
  seo_credential: 'SEO Credentials',
  seo_task_timeline: 'SEO Task Timelines',
  seo_activity_type: 'SEO Activity Types',
  tracking_user_profile: 'Tracking User Profiles',
  tracking_work_session: 'Tracking Work Sessions',
  tracking_activity_log: 'Tracking Activity Logs',
  tracking_app_activity: 'Tracking App Activities',
  tracking_screenshot: 'Tracking Screenshots',
  notifications: 'Notifications',
  client_notifications: 'Client Notifications',
};

@Injectable()
export class BackupsService {
  private readonly logger = new Logger(BackupsService.name);
  private readonly mediaRoot = path.resolve(process.cwd(), 'media');
  private readonly backupStorageDir = path.resolve(process.cwd(), 'private_storage', 'backups');
  private readonly tmpDir = path.resolve(process.cwd(), 'private_storage', 'tmp');
  private readonly cacheRootDir = path.resolve(process.cwd(), 'private_storage', 'cache', 'backups');

  constructor(
    private readonly prisma: PrismaService,
    private readonly pdfService: PdfService,
  ) {
    this.ensureDirectoryExists(this.backupStorageDir);
    this.ensureDirectoryExists(this.tmpDir);
    this.ensureDirectoryExists(this.cacheRootDir);
  }

  private ensureDirectoryExists(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  /**
   * Safe URL parser for DATABASE_URL with credential extraction
   */
  private parseDatabaseUrl(): {
    host: string;
    port: string;
    username: string;
    password: string;
    database: string;
  } {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      throw new InternalServerErrorException('DATABASE_URL environment variable is not defined.');
    }
    try {
      const parsed = new URL(dbUrl);
      return {
        host: parsed.hostname || 'localhost',
        port: parsed.port || '3306',
        username: decodeURIComponent(parsed.username || ''),
        password: decodeURIComponent(parsed.password || ''),
        database: parsed.pathname ? parsed.pathname.replace(/^\//, '') : '',
      };
    } catch (err) {
      throw new InternalServerErrorException('Failed to parse DATABASE_URL.');
    }
  }

  /**
   * Escape literal values safely for MySQL SQL dump output
   */
  private escapeSqlValue(val: any): string {
    if (val === null || val === undefined) {
      return 'NULL';
    }
    if (typeof val === 'number') {
      return String(val);
    }
    if (typeof val === 'bigint') {
      return val.toString();
    }
    if (typeof val === 'boolean') {
      return val ? '1' : '0';
    }
    if (val instanceof Date) {
      return `'${val.toISOString().slice(0, 23).replace('T', ' ')}'`;
    }
    if (typeof val === 'object') {
      val = JSON.stringify(val);
    }

    const str = String(val);
    const escaped = str
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/\0/g, '\\0')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\x1a/g, '\\Z');

    return `'${escaped}'`;
  }

  /**
   * Generate executable INSERT INTO statement for array of records
   */
  private generateTableSql(tableName: string, rows: Record<string, any>[]): string {
    if (!rows || rows.length === 0) {
      return `-- No records exported for ${tableName}\n\n`;
    }

    const columns = Object.keys(rows[0]);
    const colList = columns.map((c) => `\`${c}\``).join(', ');

    let sql = `-- Records for ${tableName}\n`;
    for (const row of rows) {
      const values = columns.map((col) => this.escapeSqlValue(row[col])).join(', ');
      sql += `INSERT INTO \`${tableName}\` (${colList}) VALUES (${values});\n`;
    }
    sql += '\n';
    return sql;
  }

  /**
   * Redact sensitive credentials/passwords for JSON snapshot output
   */
  private sanitizeRecordForSnapshot(tableName: string, row: Record<string, any>): Record<string, any> {
    const clean = { ...row };
    if (tableName === 'users' || tableName === 'users.json') {
      if (clean.password) clean.password = '[REDACTED]';
    } else if (tableName === 'website_credentials' || tableName === 'website_credentials.json') {
      if (clean.admin_password) clean.admin_password = '[REDACTED]';
      if (clean.cpanel_password) clean.cpanel_password = '[REDACTED]';
      if (clean.ftp_password) clean.ftp_password = '[REDACTED]';
      if (clean.client_email_password) clean.client_email_password = '[REDACTED]';
      if (clean.business_email_password) clean.business_email_password = '[REDACTED]';
    } else if (tableName === 'seo_credential' || tableName === 'seo_credential.json') {
      if (clean.password) clean.password = '[REDACTED]';
    } else if (tableName === 'seo_daily_work_log_item' || tableName === 'seo_daily_work_log_item.json') {
      if (clean.password) clean.password = '[REDACTED]';
    }
    return clean;
  }

  /**
   * Atomic check & lock generation request
   */
  async generateBackup(user: any, dto: GenerateBackupDto): Promise<BackupRecord> {
    if (!dto || !dto.backupType || !Object.values(BackupType).includes(dto.backupType)) {
      throw new BadRequestException('Invalid or missing backupType.');
    }

    if (dto.backupType === BackupType.CATEGORY) {
      if (!dto.categories || !Array.isArray(dto.categories) || dto.categories.length === 0) {
        throw new BadRequestException('At least one category must be selected for CATEGORY backup.');
      }
      const validCategories = Object.values(BackupCategory);
      for (const cat of dto.categories) {
        if (!validCategories.includes(cat)) {
          throw new BadRequestException(`Invalid category specified: ${cat}`);
        }
      }
    }

    const active = await this.prisma.$transaction(async (tx) => {
      const running = await tx.backupRecord.findFirst({
        where: {
          status: { in: [BackupStatus.PENDING, BackupStatus.RUNNING] },
        },
      });
      if (running) {
        throw new ConflictException('A backup operation is currently in progress.');
      }

      const timestamp = new Date()
        .toISOString()
        .replace(/[-:]/g, '')
        .replace('T', '-')
        .split('.')[0];
      const typeStr = dto.backupType === BackupType.FULL_SYSTEM ? 'full' : 'category';
      const filename = `grehasoft-backup-${typeStr}-${timestamp}.zip`;

      return await tx.backupRecord.create({
        data: {
          filename,
          backup_type: dto.backupType,
          selected_categories: dto.categories ? (dto.categories as any) : null,
          status: BackupStatus.PENDING,
          created_by_id: user.id,
        },
      });
    });

    // Execute background worker (non-blocking)
    setImmediate(() => {
      this.executeBackupJob(active.id, dto).catch((err) => {
        this.logger.error(`Unhandled background backup error for record #${active.id}: ${err.message}`);
      });
    });

    return active;
  }

  /**
   * Background Backup Execution Engine (Dual-Purpose Archive Generator)
   */
  private async executeBackupJob(recordId: number, dto: GenerateBackupDto): Promise<void> {
    const workDir = path.join(this.tmpDir, `backup_job_${recordId}_${Date.now()}`);
    this.ensureDirectoryExists(workDir);

    try {
      await this.prisma.backupRecord.update({
        where: { id: recordId },
        data: { status: BackupStatus.RUNNING },
      });

      const dbDir = path.join(workDir, 'database');
      const dataDir = path.join(workDir, 'data');
      const docsDir = path.join(workDir, 'documents');
      const mediaDir = path.join(workDir, 'media');

      this.ensureDirectoryExists(dbDir);
      this.ensureDirectoryExists(dataDir);
      this.ensureDirectoryExists(docsDir);
      this.ensureDirectoryExists(mediaDir);

      let sqlFilename = 'database.sql';
      let mediaIncluded: string[] = [];
      let totalFilesCopied = 0;

      const entityCounts: Record<string, number> = {};
      const documentCounts: Record<string, number> = {};

      if (dto.backupType === BackupType.FULL_SYSTEM) {
        sqlFilename = 'database.sql';
        await this.dumpFullDatabase(path.join(dbDir, sqlFilename));
        totalFilesCopied = await this.copyFullMedia(mediaDir);
        mediaIncluded = ['./media/*'];

        // Generate full snapshots for all 49 database tables & documents
        await this.exportFullSnapshotsAndDocuments(dataDir, docsDir, entityCounts, documentCounts);
      } else {
        const categories = dto.categories || [];
        sqlFilename = `${categories.join('_').toLowerCase() || 'category'}.sql`;
        const categoryResult = await this.exportCategorySnapshotsAndDocuments(
          categories,
          path.join(dbDir, sqlFilename),
          dataDir,
          docsDir,
          mediaDir,
          entityCounts,
          documentCounts,
        );
        totalFilesCopied = categoryResult.fileCount;
        mediaIncluded = categoryResult.mediaIncluded;
      }

      const totalDocuments = Object.values(documentCounts).reduce((a, b) => a + b, 0);

      // Generate Manifest v2
      const manifest = {
        manifest_version: '2.0',
        application_name: 'Grehasoft PMS',
        backup_id: recordId,
        backup_type: dto.backupType,
        selected_categories: dto.categories || null,
        created_at: new Date().toISOString(),
        database_dump_filename: `database/${sqlFilename}`,
        entity_counts: entityCounts,
        document_counts: documentCounts,
        total_documents: totalDocuments,
        media_included: mediaIncluded,
        total_files_included: totalFilesCopied,
      };
      fs.writeFileSync(path.join(workDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

      // Create ZIP Archive
      const record = await this.prisma.backupRecord.findUnique({ where: { id: recordId } });
      const archivePath = path.join(this.backupStorageDir, record.filename);
      const archiveSize = await this.createZipArchive(workDir, archivePath);

      // Mark COMPLETED
      await this.prisma.backupRecord.update({
        where: { id: recordId },
        data: {
          status: BackupStatus.COMPLETED,
          completed_at: new Date(),
          size_bytes: archiveSize,
        },
      });

      this.logger.log(`Backup #${recordId} completed successfully. Size: ${archiveSize} bytes.`);
    } catch (error) {
      this.logger.error(`Backup #${recordId} failed: ${error.message}`, error.stack);
      const safeErrorMsg = error.message || 'An error occurred during backup generation.';

      await this.prisma.backupRecord.update({
        where: { id: recordId },
        data: {
          status: BackupStatus.FAILED,
          completed_at: new Date(),
          error_message: safeErrorMsg.substring(0, 1000),
        },
      }).catch((e) => this.logger.error(`Failed to update FAILED status: ${e.message}`));
    } finally {
      if (fs.existsSync(workDir)) {
        fs.rmSync(workDir, { recursive: true, force: true });
      }
    }
  }

  /**
   * Full Database Dump using mysqldump with MYSQL_PWD credential isolation
   */
  private async dumpFullDatabase(outputPath: string): Promise<void> {
    const creds = this.parseDatabaseUrl();
    const env = { ...process.env, MYSQL_PWD: creds.password };

    const cmd = `mysqldump --host="${creds.host}" --port="${creds.port}" --user="${creds.username}" --single-transaction --quick --routines --triggers --events "${creds.database}" > "${outputPath}"`;

    try {
      await execAsync(cmd, { env });
    } catch (err) {
      this.logger.error(`mysqldump execution failed: ${err.message}`);
      throw new InternalServerErrorException(`Full database dump failed: ${err.message}`);
    }
  }

  /**
   * Copy complete ./media storage for Full System Backup
   */
  private async copyFullMedia(destMediaDir: string): Promise<number> {
    if (!fs.existsSync(this.mediaRoot)) {
      return 0;
    }
    let count = 0;
    const copyRecursive = (src: string, dest: string) => {
      const entries = fs.readdirSync(src, { withFileTypes: true });
      this.ensureDirectoryExists(dest);
      for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
          copyRecursive(srcPath, destPath);
        } else if (entry.isFile()) {
          fs.copyFileSync(srcPath, destPath);
          count++;
        }
      }
    };
    copyRecursive(this.mediaRoot, destMediaDir);
    return count;
  }

  /**
   * Write sanitized table JSON snapshot file to data/ directory
   */
  private writeJsonSnapshot(
    dataDir: string,
    entityName: string,
    rows: Record<string, any>[],
    entityCounts: Record<string, number>,
  ): void {
    const sanitizedRows = rows.map((r) => this.sanitizeRecordForSnapshot(entityName, r));
    fs.writeFileSync(
      path.join(dataDir, `${entityName}.json`),
      JSON.stringify(sanitizedRows, null, 2),
      'utf8',
    );
    entityCounts[entityName] = sanitizedRows.length;
  }

  /**
   * Generate Full System Data Snapshots for ALL 49 Prisma Tables & Documents
   */
  private async exportFullSnapshotsAndDocuments(
    dataDir: string,
    docsDir: string,
    entityCounts: Record<string, number>,
    documentCounts: Record<string, number>,
  ): Promise<void> {
    // Export ALL 49 Prisma models to data/*.json
    const roles = await this.prisma.role.findMany();
    const depts = await this.prisma.department.findMany();
    const users = await this.prisma.user.findMany();
    const clients = await this.prisma.client.findMany();
    const portalAudits = await this.prisma.portalUserAudit.findMany();
    const projects = await this.prisma.project.findMany();
    const milestones = await this.prisma.milestone.findMany();
    const projectMembers = await this.prisma.projectMember.findMany();
    const projectActivityLogs = await this.prisma.projectActivityLog.findMany();
    const leads = await this.prisma.lead.findMany();
    const leadAssignments = await this.prisma.leadAssignment.findMany();
    const leadFollowups = await this.prisma.leadFollowup.findMany();
    const taskTypes = await this.prisma.taskType.findMany();
    const tasks = await this.prisma.task.findMany();
    const taskAssignments = await this.prisma.taskAssignment.findMany();
    const taskProgresses = await this.prisma.taskProgress.findMany();
    const taskFiles = await this.prisma.taskFile.findMany();
    const taskReviews = await this.prisma.taskReview.findMany();
    const taskComments = await this.prisma.taskComment.findMany();
    const globalLogs = await this.prisma.globalActivityLog.findMany();
    const seoActivityTypes = await this.prisma.sEOActivityType.findMany();
    const seoWebsites = await this.prisma.sEOWebsite.findMany();
    const seoKeywords = await this.prisma.sEOKeyword.findMany();
    const seoDailyWorkLogs = await this.prisma.sEODailyWorkLog.findMany();
    const seoDailyWorkProofs = await this.prisma.sEODailyWorkProof.findMany();
    const seoDailyWorkLogItems = await this.prisma.sEODailyWorkLogItem.findMany();
    const seoMonthlyTargets = await this.prisma.sEOMonthlyTarget.findMany();
    const seoTasks = await this.prisma.sEOTask.findMany();
    const seoReminders = await this.prisma.sEOReminder.findMany();
    const seoCredentials = await this.prisma.sEOCredential.findMany();
    const seoTaskTimelines = await this.prisma.sEOTaskTimeline.findMany();
    const invoices = await this.prisma.invoice.findMany({ include: { items: true, payments: true, client: true } });
    const invoiceItems = await this.prisma.invoiceItem.findMany();
    const invoicePayments = await this.prisma.invoicePayment.findMany();
    const proposals = await this.prisma.proposal.findMany({ include: { items: true, client: true, lead: true } });
    const proposalItems = await this.prisma.proposalItem.findMany();
    const reminders = await this.prisma.reminder.findMany();
    const servers = await this.prisma.server.findMany();
    const domains = await this.prisma.domain.findMany();
    const websiteCredentials = await this.prisma.websiteCredential.findMany();
    const employees = await this.prisma.employee.findMany();
    const hrDocs = await this.prisma.hRDocument.findMany({ include: { employee: { include: { user: true } } } });
    const trackingProfiles = await this.prisma.trackingUserProfile.findMany();
    const workSessions = await this.prisma.workSession.findMany();
    const trackingActivityLogs = await this.prisma.trackingActivityLog.findMany();
    const appActivities = await this.prisma.appActivity.findMany();
    const screenshots = await this.prisma.screenshot.findMany();
    const notifications = await this.prisma.notification.findMany();
    const clientNotifications = await this.prisma.clientNotification.findMany();

    this.writeJsonSnapshot(dataDir, 'roles', roles, entityCounts);
    this.writeJsonSnapshot(dataDir, 'departments', depts, entityCounts);
    this.writeJsonSnapshot(dataDir, 'users', users, entityCounts);
    this.writeJsonSnapshot(dataDir, 'clients', clients, entityCounts);
    this.writeJsonSnapshot(dataDir, 'portal_user_audit', portalAudits, entityCounts);
    this.writeJsonSnapshot(dataDir, 'projects', projects, entityCounts);
    this.writeJsonSnapshot(dataDir, 'milestones', milestones, entityCounts);
    this.writeJsonSnapshot(dataDir, 'project_members', projectMembers, entityCounts);
    this.writeJsonSnapshot(dataDir, 'project_activity_logs', projectActivityLogs, entityCounts);
    this.writeJsonSnapshot(dataDir, 'leads', leads, entityCounts);
    this.writeJsonSnapshot(dataDir, 'lead_assignments', leadAssignments, entityCounts);
    this.writeJsonSnapshot(dataDir, 'lead_followups', leadFollowups, entityCounts);
    this.writeJsonSnapshot(dataDir, 'task_types', taskTypes, entityCounts);
    this.writeJsonSnapshot(dataDir, 'tasks', tasks, entityCounts);
    this.writeJsonSnapshot(dataDir, 'task_assignments', taskAssignments, entityCounts);
    this.writeJsonSnapshot(dataDir, 'task_progress', taskProgresses, entityCounts);
    this.writeJsonSnapshot(dataDir, 'task_files', taskFiles, entityCounts);
    this.writeJsonSnapshot(dataDir, 'task_reviews', taskReviews, entityCounts);
    this.writeJsonSnapshot(dataDir, 'task_comments', taskComments, entityCounts);
    this.writeJsonSnapshot(dataDir, 'global_activity_logs', globalLogs, entityCounts);
    this.writeJsonSnapshot(dataDir, 'seo_activity_type', seoActivityTypes, entityCounts);
    this.writeJsonSnapshot(dataDir, 'seo_website', seoWebsites, entityCounts);
    this.writeJsonSnapshot(dataDir, 'seo_keyword', seoKeywords, entityCounts);
    this.writeJsonSnapshot(dataDir, 'seo_daily_work_log', seoDailyWorkLogs, entityCounts);
    this.writeJsonSnapshot(dataDir, 'seo_daily_work_proof', seoDailyWorkProofs, entityCounts);
    this.writeJsonSnapshot(dataDir, 'seo_daily_work_log_item', seoDailyWorkLogItems, entityCounts);
    this.writeJsonSnapshot(dataDir, 'seo_monthly_target', seoMonthlyTargets, entityCounts);
    this.writeJsonSnapshot(dataDir, 'seo_task', seoTasks, entityCounts);
    this.writeJsonSnapshot(dataDir, 'seo_reminder', seoReminders, entityCounts);
    this.writeJsonSnapshot(dataDir, 'seo_credential', seoCredentials, entityCounts);
    this.writeJsonSnapshot(dataDir, 'seo_task_timeline', seoTaskTimelines, entityCounts);
    this.writeJsonSnapshot(dataDir, 'invoices', invoices, entityCounts);
    this.writeJsonSnapshot(dataDir, 'invoice_items', invoiceItems, entityCounts);
    this.writeJsonSnapshot(dataDir, 'invoice_payments', invoicePayments, entityCounts);
    this.writeJsonSnapshot(dataDir, 'proposals', proposals, entityCounts);
    this.writeJsonSnapshot(dataDir, 'proposal_items', proposalItems, entityCounts);
    this.writeJsonSnapshot(dataDir, 'reminders', reminders, entityCounts);
    this.writeJsonSnapshot(dataDir, 'servers', servers, entityCounts);
    this.writeJsonSnapshot(dataDir, 'domains', domains, entityCounts);
    this.writeJsonSnapshot(dataDir, 'website_credentials', websiteCredentials, entityCounts);
    this.writeJsonSnapshot(dataDir, 'employees', employees, entityCounts);
    this.writeJsonSnapshot(dataDir, 'hr_documents', hrDocs, entityCounts);
    this.writeJsonSnapshot(dataDir, 'tracking_user_profile', trackingProfiles, entityCounts);
    this.writeJsonSnapshot(dataDir, 'tracking_work_session', workSessions, entityCounts);
    this.writeJsonSnapshot(dataDir, 'tracking_activity_log', trackingActivityLogs, entityCounts);
    this.writeJsonSnapshot(dataDir, 'tracking_app_activity', appActivities, entityCounts);
    this.writeJsonSnapshot(dataDir, 'tracking_screenshot', screenshots, entityCounts);
    this.writeJsonSnapshot(dataDir, 'notifications', notifications, entityCounts);
    this.writeJsonSnapshot(dataDir, 'client_notifications', clientNotifications, entityCounts);

    // Generate Invoices PDFs using exported snapshot record payloads
    const invDocsDir = path.join(docsDir, 'invoices');
    this.ensureDirectoryExists(invDocsDir);
    let invPdfCount = 0;
    for (const inv of invoices) {
      try {
        const pdfBuffer = await this.pdfService.generateInvoicePdf(inv);
        const safeInvNum = (inv.invoice_number || `invoice_${inv.id}`).replace(/[\/\\]/g, '_');
        const pdfPath = path.join(invDocsDir, `${safeInvNum}.pdf`);
        fs.writeFileSync(pdfPath, pdfBuffer);
        invPdfCount++;
      } catch (err) {
        this.logger.warn(`Failed to render PDF for invoice #${inv.id}: ${err.message}`);
      }
    }
    documentCounts['invoices'] = invPdfCount;

    // Generate Proposals PDFs using exported snapshot record payloads
    const propDocsDir = path.join(docsDir, 'proposals');
    this.ensureDirectoryExists(propDocsDir);
    let propPdfCount = 0;
    for (const prop of proposals) {
      try {
        const pdfBuffer = await this.pdfService.generateProposalPdf(prop);
        const pdfPath = path.join(propDocsDir, `proposal_${prop.id}.pdf`);
        fs.writeFileSync(pdfPath, pdfBuffer);
        propPdfCount++;
      } catch (err) {
        this.logger.warn(`Failed to render PDF for proposal #${prop.id}: ${err.message}`);
      }
    }
    documentCounts['proposals'] = propPdfCount;

    // Archive Task Attachment Files
    const taskDocsDir = path.join(docsDir, 'tasks');
    this.ensureDirectoryExists(taskDocsDir);
    let taskFileCount = 0;
    for (const tf of taskFiles) {
      if (tf.file_path) {
        const cleanRelPath = tf.file_path.replace(/^media[\/\\]/, '');
        const srcPath = path.resolve(this.mediaRoot, cleanRelPath);
        if (srcPath.startsWith(this.mediaRoot) && fs.existsSync(srcPath)) {
          const targetPath = path.join(taskDocsDir, path.basename(srcPath));
          fs.copyFileSync(srcPath, targetPath);
          taskFileCount++;
        }
      }
    }
    documentCounts['tasks'] = taskFileCount;

    // Archive HR Document PDFs
    const hrDocsDir = path.join(docsDir, 'hr');
    this.ensureDirectoryExists(hrDocsDir);
    let hrPdfCount = 0;
    for (const hrd of hrDocs) {
      if (hrd.pdf_file) {
        const cleanRelPath = hrd.pdf_file.replace(/^media[\/\\]/, '');
        const srcPath = path.resolve(this.mediaRoot, cleanRelPath);
        if (srcPath.startsWith(this.mediaRoot) && fs.existsSync(srcPath)) {
          const targetPath = path.join(hrDocsDir, path.basename(srcPath));
          fs.copyFileSync(srcPath, targetPath);
          hrPdfCount++;
          continue;
        }
      }
      try {
        const title = (hrd.doc_type || 'hr_doc').toUpperCase();
        const ctx = {
          employee_name: hrd.employee?.user?.name || 'Employee',
          designation: hrd.employee?.position || 'Staff',
          payload: hrd.payload || {},
        };
        const pdfBuf = await this.pdfService.generateHrDocumentPdf(title, ctx);
        const targetPath = path.join(hrDocsDir, `${hrd.doc_type}_${hrd.id}.pdf`);
        fs.writeFileSync(targetPath, pdfBuf);
        hrPdfCount++;
      } catch (err) {
        this.logger.warn(`Failed to render HR doc PDF #${hrd.id}: ${err.message}`);
      }
    }
    documentCounts['hr'] = hrPdfCount;
  }

  /**
   * Export Record-Scoped Category Data & Snapshots
   */
  private async exportCategorySnapshotsAndDocuments(
    categories: BackupCategory[],
    sqlOutputPath: string,
    dataDir: string,
    docsDir: string,
    destMediaDir: string,
    entityCounts: Record<string, number>,
    documentCounts: Record<string, number>,
  ): Promise<{ fileCount: number; mediaIncluded: string[] }> {
    let sqlContent = `-- Grehasoft PMS Category Backup Dump\n`;
    sqlContent += `-- Generated: ${new Date().toISOString()}\n`;
    sqlContent += `-- Categories: ${categories.join(', ')}\n\n`;
    sqlContent += `SET FOREIGN_KEY_CHECKS=0;\n`;
    sqlContent += `SET SQL_MODE="NO_AUTO_VALUE_ON_ZERO";\n\n`;

    const referencedMediaPaths = new Set<string>();
    const mediaIncluded: string[] = [];

    const clientIds = new Set<number>();
    const userIds = new Set<number>();
    const deptIds = new Set<number>();
    const roleIds = new Set<number>();
    const taskTypeIds = new Set<number>();
    const leadIds = new Set<number>();

    // Processing FINANCE
    if (categories.includes(BackupCategory.FINANCE)) {
      const invoices = await this.prisma.invoice.findMany({ include: { items: true, payments: true, client: true } });
      const invoiceIds = invoices.map((i) => i.id);
      invoices.forEach((i) => {
        if (i.client_id) clientIds.add(i.client_id);
      });

      const invoiceItems = invoiceIds.length > 0
        ? await this.prisma.invoiceItem.findMany({ where: { invoice_id: { in: invoiceIds } } })
        : [];
      const invoicePayments = invoiceIds.length > 0
        ? await this.prisma.invoicePayment.findMany({ where: { invoice_id: { in: invoiceIds } } })
        : [];

      const proposals = await this.prisma.proposal.findMany({ include: { items: true, client: true, lead: true } });
      const proposalIds = proposals.map((p) => p.id);
      proposals.forEach((p) => {
        if (p.client_id) clientIds.add(p.client_id);
        if (p.lead_id) leadIds.add(p.lead_id);
      });

      const proposalItems = proposalIds.length > 0
        ? await this.prisma.proposalItem.findMany({ where: { proposal_id: { in: proposalIds } } })
        : [];

      sqlContent += `-- Category: FINANCE --\n`;
      sqlContent += this.generateTableSql('invoices', invoices);
      sqlContent += this.generateTableSql('invoice_items', invoiceItems);
      sqlContent += this.generateTableSql('invoice_payments', invoicePayments);
      sqlContent += this.generateTableSql('proposals', proposals);
      sqlContent += this.generateTableSql('proposal_items', proposalItems);

      this.writeJsonSnapshot(dataDir, 'invoices', invoices, entityCounts);
      this.writeJsonSnapshot(dataDir, 'invoice_items', invoiceItems, entityCounts);
      this.writeJsonSnapshot(dataDir, 'invoice_payments', invoicePayments, entityCounts);
      this.writeJsonSnapshot(dataDir, 'proposals', proposals, entityCounts);
      this.writeJsonSnapshot(dataDir, 'proposal_items', proposalItems, entityCounts);

      // Generate Invoice & Proposal PDFs
      const invDocsDir = path.join(docsDir, 'invoices');
      this.ensureDirectoryExists(invDocsDir);
      let invPdfCount = 0;
      for (const inv of invoices) {
        try {
          const pdfBuf = await this.pdfService.generateInvoicePdf(inv);
          const safeInvNum = (inv.invoice_number || `invoice_${inv.id}`).replace(/[\/\\]/g, '_');
          fs.writeFileSync(path.join(invDocsDir, `${safeInvNum}.pdf`), pdfBuf);
          invPdfCount++;
        } catch (err) {
          this.logger.warn(`Failed to render invoice PDF #${inv.id}: ${err.message}`);
        }
      }
      documentCounts['invoices'] = invPdfCount;

      const propDocsDir = path.join(docsDir, 'proposals');
      this.ensureDirectoryExists(propDocsDir);
      let propPdfCount = 0;
      for (const prop of proposals) {
        try {
          const pdfBuf = await this.pdfService.generateProposalPdf(prop);
          fs.writeFileSync(path.join(propDocsDir, `proposal_${prop.id}.pdf`), pdfBuf);
          propPdfCount++;
        } catch (err) {
          this.logger.warn(`Failed to render proposal PDF #${prop.id}: ${err.message}`);
        }
      }
      documentCounts['proposals'] = propPdfCount;
    }

    // Processing CLIENTS / CRM
    if (categories.includes(BackupCategory.CLIENTS)) {
      const clients = await this.prisma.client.findMany();
      clients.forEach((c) => clientIds.add(c.id));

      const leads = await this.prisma.lead.findMany();
      const lIds = leads.map((l) => l.id);
      leads.forEach((l) => {
        if (l.client_id) clientIds.add(l.client_id);
      });

      const leadAssignments = lIds.length > 0
        ? await this.prisma.leadAssignment.findMany({ where: { lead_id: { in: lIds } } })
        : [];
      leadAssignments.forEach((la) => {
        if (la.sales_exec_id) userIds.add(la.sales_exec_id);
      });

      const leadFollowups = lIds.length > 0
        ? await this.prisma.leadFollowup.findMany({ where: { lead_id: { in: lIds } } })
        : [];
      leadFollowups.forEach((lf) => {
        if (lf.created_by_id) userIds.add(lf.created_by_id);
      });

      const portalAudits = await this.prisma.portalUserAudit.findMany();
      portalAudits.forEach((pa) => {
        if (pa.client_id) clientIds.add(pa.client_id);
        if (pa.portal_user_id) userIds.add(pa.portal_user_id);
        if (pa.performed_by_id) userIds.add(pa.performed_by_id);
      });

      sqlContent += `-- Category: CLIENTS / CRM --\n`;
      sqlContent += this.generateTableSql('clients', clients);
      sqlContent += this.generateTableSql('leads', leads);
      sqlContent += this.generateTableSql('lead_assignments', leadAssignments);
      sqlContent += this.generateTableSql('lead_followups', leadFollowups);
      sqlContent += this.generateTableSql('portal_user_audit', portalAudits);

      this.writeJsonSnapshot(dataDir, 'clients', clients, entityCounts);
      this.writeJsonSnapshot(dataDir, 'leads', leads, entityCounts);
      this.writeJsonSnapshot(dataDir, 'lead_assignments', leadAssignments, entityCounts);
      this.writeJsonSnapshot(dataDir, 'lead_followups', leadFollowups, entityCounts);
      this.writeJsonSnapshot(dataDir, 'portal_user_audit', portalAudits, entityCounts);
    }

    // Processing OPERATIONS
    if (categories.includes(BackupCategory.OPERATIONS)) {
      const projects = await this.prisma.project.findMany();
      const projIds = projects.map((p) => p.id);
      projects.forEach((p) => {
        if (p.client_id) clientIds.add(p.client_id);
        if (p.department_id) deptIds.add(p.department_id);
        if (p.project_manager_id) userIds.add(p.project_manager_id);
        if (p.created_by_id) userIds.add(p.created_by_id);
      });

      const milestones = projIds.length > 0
        ? await this.prisma.milestone.findMany({ where: { project_id: { in: projIds } } })
        : [];
      const projectMembers = projIds.length > 0
        ? await this.prisma.projectMember.findMany({ where: { project_id: { in: projIds } } })
        : [];
      projectMembers.forEach((pm) => userIds.add(pm.user_id));

      const projectActivityLogs = projIds.length > 0
        ? await this.prisma.projectActivityLog.findMany({ where: { project_id: { in: projIds } } })
        : [];
      projectActivityLogs.forEach((pal) => userIds.add(pal.user_id));

      const tasks = projIds.length > 0
        ? await this.prisma.task.findMany({ where: { project_id: { in: projIds } } })
        : [];
      const taskIds = tasks.map((t) => t.id);
      tasks.forEach((t) => {
        if (t.task_type_id) taskTypeIds.add(t.task_type_id);
        if (t.created_by_id) userIds.add(t.created_by_id);
      });

      const taskAssignments = taskIds.length > 0
        ? await this.prisma.taskAssignment.findMany({ where: { task_id: { in: taskIds } } })
        : [];
      taskAssignments.forEach((ta) => {
        if (ta.employee_id) userIds.add(ta.employee_id);
        if (ta.assigned_by_id) userIds.add(ta.assigned_by_id);
      });

      const taskProgresses = taskIds.length > 0
        ? await this.prisma.taskProgress.findMany({ where: { task_id: { in: taskIds } } })
        : [];
      taskProgresses.forEach((tp) => userIds.add(tp.updated_by_id));

      const taskFiles = taskIds.length > 0
        ? await this.prisma.taskFile.findMany({ where: { task_id: { in: taskIds } } })
        : [];
      const taskFileIds = taskFiles.map((tf) => tf.id);
      taskFiles.forEach((tf) => {
        if (tf.uploaded_by_id) userIds.add(tf.uploaded_by_id);
        if (tf.file_path) referencedMediaPaths.add(tf.file_path);
      });

      const taskReviews = taskFileIds.length > 0
        ? await this.prisma.taskReview.findMany({ where: { task_file_id: { in: taskFileIds } } })
        : [];
      taskReviews.forEach((tr) => userIds.add(tr.reviewer_id));

      const taskComments = taskIds.length > 0
        ? await this.prisma.taskComment.findMany({ where: { task_id: { in: taskIds } } })
        : [];
      taskComments.forEach((tc) => userIds.add(tc.user_id));

      sqlContent += `-- Category: OPERATIONS --\n`;
      sqlContent += this.generateTableSql('projects', projects);
      sqlContent += this.generateTableSql('milestones', milestones);
      sqlContent += this.generateTableSql('project_members', projectMembers);
      sqlContent += this.generateTableSql('project_activity_logs', projectActivityLogs);
      sqlContent += this.generateTableSql('tasks', tasks);
      sqlContent += this.generateTableSql('task_assignments', taskAssignments);
      sqlContent += this.generateTableSql('task_progress', taskProgresses);
      sqlContent += this.generateTableSql('task_files', taskFiles);
      sqlContent += this.generateTableSql('task_reviews', taskReviews);
      sqlContent += this.generateTableSql('task_comments', taskComments);

      this.writeJsonSnapshot(dataDir, 'projects', projects, entityCounts);
      this.writeJsonSnapshot(dataDir, 'milestones', milestones, entityCounts);
      this.writeJsonSnapshot(dataDir, 'project_members', projectMembers, entityCounts);
      this.writeJsonSnapshot(dataDir, 'project_activity_logs', projectActivityLogs, entityCounts);
      this.writeJsonSnapshot(dataDir, 'tasks', tasks, entityCounts);
      this.writeJsonSnapshot(dataDir, 'task_assignments', taskAssignments, entityCounts);
      this.writeJsonSnapshot(dataDir, 'task_progress', taskProgresses, entityCounts);
      this.writeJsonSnapshot(dataDir, 'task_files', taskFiles, entityCounts);
      this.writeJsonSnapshot(dataDir, 'task_reviews', taskReviews, entityCounts);
      this.writeJsonSnapshot(dataDir, 'task_comments', taskComments, entityCounts);

      mediaIncluded.push('./media/task_files/');

      // Copy task files to documents/tasks/
      const taskDocsDir = path.join(docsDir, 'tasks');
      this.ensureDirectoryExists(taskDocsDir);
      let tfCount = 0;
      for (const tf of taskFiles) {
        if (tf.file_path) {
          const cleanRelPath = tf.file_path.replace(/^media[\/\\]/, '');
          const srcPath = path.resolve(this.mediaRoot, cleanRelPath);
          if (srcPath.startsWith(this.mediaRoot) && fs.existsSync(srcPath)) {
            fs.copyFileSync(srcPath, path.join(taskDocsDir, path.basename(srcPath)));
            tfCount++;
          }
        }
      }
      documentCounts['tasks'] = tfCount;
    }

    // Processing HR
    if (categories.includes(BackupCategory.HR)) {
      const employees = await this.prisma.employee.findMany();
      const empIds = employees.map((e) => e.id);
      employees.forEach((e) => {
        userIds.add(e.user_id);
        if (e.department_id) deptIds.add(e.department_id);
      });

      const hrDocs = empIds.length > 0
        ? await this.prisma.hRDocument.findMany({ where: { employee_id: { in: empIds } }, include: { employee: { include: { user: true } } } })
        : [];
      hrDocs.forEach((hrd) => {
        if (hrd.created_by_id) userIds.add(hrd.created_by_id);
        if (hrd.pdf_file) referencedMediaPaths.add(hrd.pdf_file);
      });

      sqlContent += `-- Category: HR --\n`;
      sqlContent += this.generateTableSql('employees', employees);
      sqlContent += this.generateTableSql('hr_documents', hrDocs);

      this.writeJsonSnapshot(dataDir, 'employees', employees, entityCounts);
      this.writeJsonSnapshot(dataDir, 'hr_documents', hrDocs, entityCounts);

      mediaIncluded.push('./media/hr_documents/');

      // Copy/render HR documents
      const hrDocsDir = path.join(docsDir, 'hr');
      this.ensureDirectoryExists(hrDocsDir);
      let hrPdfCount = 0;
      for (const hrd of hrDocs) {
        if (hrd.pdf_file) {
          const cleanRelPath = hrd.pdf_file.replace(/^media[\/\\]/, '');
          const srcPath = path.resolve(this.mediaRoot, cleanRelPath);
          if (srcPath.startsWith(this.mediaRoot) && fs.existsSync(srcPath)) {
            fs.copyFileSync(srcPath, path.join(hrDocsDir, path.basename(srcPath)));
            hrPdfCount++;
            continue;
          }
        }
        try {
          const title = (hrd.doc_type || 'hr_doc').toUpperCase();
          const ctx = {
            employee_name: hrd.employee?.user?.name || 'Employee',
            designation: hrd.employee?.position || 'Staff',
            payload: hrd.payload || {},
          };
          const pdfBuf = await this.pdfService.generateHrDocumentPdf(title, ctx);
          fs.writeFileSync(path.join(hrDocsDir, `${hrd.doc_type}_${hrd.id}.pdf`), pdfBuf);
          hrPdfCount++;
        } catch (err) {
          this.logger.warn(`Failed to render HR PDF #${hrd.id}: ${err.message}`);
        }
      }
      documentCounts['hr'] = hrPdfCount;
    }

    // Export Parent Reference Records
    if (clientIds.size > 0 && !categories.includes(BackupCategory.CLIENTS)) {
      const cArr = Array.from(clientIds);
      const clients = await this.prisma.client.findMany({ where: { id: { in: cArr } } });
      sqlContent += `-- Parent Reference Records: clients --\n`;
      sqlContent += this.generateTableSql('clients', clients);
      this.writeJsonSnapshot(dataDir, 'clients', clients, entityCounts);
    }

    if (userIds.size > 0) {
      const uArr = Array.from(userIds);
      const users = await this.prisma.user.findMany({ where: { id: { in: uArr } } });
      users.forEach((u) => {
        if (u.role_id) roleIds.add(u.role_id);
        if (u.department_id) deptIds.add(u.department_id);
      });
      sqlContent += `-- Parent Reference Records: users --\n`;
      sqlContent += this.generateTableSql('users', users);
      this.writeJsonSnapshot(dataDir, 'users', users, entityCounts);
    }

    if (roleIds.size > 0) {
      const rArr = Array.from(roleIds);
      const roles = await this.prisma.role.findMany({ where: { id: { in: rArr } } });
      sqlContent += `-- Reference Records: roles --\n`;
      sqlContent += this.generateTableSql('roles', roles);
      this.writeJsonSnapshot(dataDir, 'roles', roles, entityCounts);
    }

    if (deptIds.size > 0) {
      const dArr = Array.from(deptIds);
      const depts = await this.prisma.department.findMany({ where: { id: { in: dArr } } });
      sqlContent += `-- Reference Records: departments --\n`;
      sqlContent += this.generateTableSql('departments', depts);
      this.writeJsonSnapshot(dataDir, 'departments', depts, entityCounts);
    }

    if (taskTypeIds.size > 0) {
      const ttArr = Array.from(taskTypeIds);
      const taskTypes = await this.prisma.taskType.findMany({ where: { id: { in: ttArr } } });
      sqlContent += `-- Reference Records: task_types --\n`;
      sqlContent += this.generateTableSql('task_types', taskTypes);
      this.writeJsonSnapshot(dataDir, 'task_types', taskTypes, entityCounts);
    }

    sqlContent += `SET FOREIGN_KEY_CHECKS=1;\n`;
    fs.writeFileSync(sqlOutputPath, sqlContent, 'utf8');

    // Scoped Media Copying
    let fileCount = 0;
    for (const relPath of referencedMediaPaths) {
      if (!relPath) continue;
      const cleanRelPath = relPath.replace(/^media[\/\\]/, '');
      const fullSrcPath = path.resolve(this.mediaRoot, cleanRelPath);

      if (!fullSrcPath.startsWith(this.mediaRoot)) {
        continue;
      }

      if (
        fs.existsSync(fullSrcPath) &&
        !cleanRelPath.startsWith('icons') &&
        !cleanRelPath.startsWith('logo')
      ) {
        const destPath = path.join(destMediaDir, cleanRelPath);
        this.ensureDirectoryExists(path.dirname(destPath));
        fs.copyFileSync(fullSrcPath, destPath);
        fileCount++;
      }
    }

    return { fileCount, mediaIncluded: Array.from(new Set(mediaIncluded)) };
  }

  /**
   * Zip Builder using archiver
   */
  private createZipArchive(sourceDir: string, targetZipPath: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const output = fs.createWriteStream(targetZipPath);
      const archive = archiver('zip', { zlib: { level: 9 } });

      output.on('close', () => {
        resolve(archive.pointer());
      });

      archive.on('error', (err) => {
        reject(err);
      });

      archive.pipe(output);
      archive.directory(sourceDir, false);
      archive.finalize();
    });
  }

  /**
   * Get all backup records
   */
  async findAll(): Promise<any[]> {
    return this.prisma.backupRecord.findMany({
      orderBy: { created_at: 'desc' },
      include: {
        created_by: {
          select: {
            id: true,
            username: true,
            email: true,
            name: true,
          },
        },
      },
    });
  }

  /**
   * Get backup status by ID
   */
  async findOne(id: number): Promise<any> {
    const record = await this.prisma.backupRecord.findUnique({
      where: { id },
      include: {
        created_by: {
          select: {
            id: true,
            username: true,
            email: true,
            name: true,
          },
        },
      },
    });

    if (!record) {
      throw new NotFoundException(`Backup record #${id} not found.`);
    }
    return record;
  }

  /**
   * Path Security Verification & Download Stream File Provider
   */
  async getDownloadPath(id: number): Promise<{ filePath: string; filename: string }> {
    const record = await this.findOne(id);

    if (record.status !== BackupStatus.COMPLETED) {
      throw new BadRequestException(`Backup #${id} is not ready for download (status: ${record.status}).`);
    }

    const filePath = path.resolve(this.backupStorageDir, record.filename);

    if (!filePath.startsWith(this.backupStorageDir)) {
      throw new ForbiddenException('Invalid backup file path traversal attempt.');
    }

    if (!fs.existsSync(filePath)) {
      throw new NotFoundException(`Backup archive file "${record.filename}" was not found on disk.`);
    }

    return { filePath, filename: record.filename };
  }

  /**
   * Delete backup archive & BackupRecord
   */
  async remove(id: number): Promise<void> {
    const record = await this.findOne(id);
    const filePath = path.resolve(this.backupStorageDir, record.filename);

    if (filePath.startsWith(this.backupStorageDir) && fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (err) {
        this.logger.error(`Failed to delete archive file ${filePath}: ${err.message}`);
      }
    }

    const cacheDir = path.join(this.cacheRootDir, `backup_${id}`);
    if (fs.existsSync(cacheDir)) {
      try {
        fs.rmSync(cacheDir, { recursive: true, force: true });
      } catch {}
    }

    await this.prisma.backupRecord.delete({ where: { id } });
  }

  // ============================================================================
  // BACKUP EXPLORER ENGINE & CACHE MANAGEMENT
  // ============================================================================

  /**
   * Stream extract ZIP into temporary cache directory with 30-minute TTL cleanup
   */
  private async ensureExtractedCache(id: number): Promise<string> {
    const record = await this.findOne(id);

    if (record.status !== BackupStatus.COMPLETED) {
      throw new BadRequestException(`Backup #${id} is not COMPLETED (status: ${record.status}).`);
    }

    const zipPath = path.resolve(this.backupStorageDir, record.filename);
    if (!zipPath.startsWith(this.backupStorageDir) || !fs.existsSync(zipPath)) {
      throw new NotFoundException(`Archive file "${record.filename}" was not found on disk.`);
    }

    this.cleanExpiredCaches();

    const targetCacheDir = path.join(this.cacheRootDir, `backup_${id}`);
    const manifestPath = path.join(targetCacheDir, 'manifest.json');

    if (fs.existsSync(manifestPath)) {
      const now = new Date();
      fs.utimesSync(targetCacheDir, now, now);
      return targetCacheDir;
    }

    this.ensureDirectoryExists(targetCacheDir);
    try {
      await fs
        .createReadStream(zipPath)
        .pipe(unzipper.Extract({ path: targetCacheDir }))
        .promise();
    } catch (err) {
      this.logger.error(`Failed to extract backup #${id} for explorer: ${err.message}`);
      throw new InternalServerErrorException(`Failed to extract backup archive for browsing.`);
    }

    return targetCacheDir;
  }

  /**
   * Fast inline eviction of expired explorer cache folders (>30 min)
   */
  private cleanExpiredCaches(): void {
    if (!fs.existsSync(this.cacheRootDir)) return;
    const now = Date.now();
    const ttlMs = 30 * 60 * 1000;

    try {
      const entries = fs.readdirSync(this.cacheRootDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const dirPath = path.join(this.cacheRootDir, entry.name);
          const stat = fs.statSync(dirPath);
          if (now - stat.mtimeMs > ttlMs) {
            fs.rmSync(dirPath, { recursive: true, force: true });
          }
        }
      }
    } catch (err) {
      this.logger.warn(`Failed during cache cleanup check: ${err.message}`);
    }
  }

  /**
   * Explorer Summary Endpoint API (with Legacy Archive Detection)
   */
  async getExplorerSummary(id: number): Promise<any> {
    const cacheDir = await this.ensureExtractedCache(id);
    const manifestPath = path.join(cacheDir, 'manifest.json');

    let manifest: any = null;
    if (fs.existsSync(manifestPath)) {
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      } catch {}
    }

    if (!manifest || manifest.manifest_version !== '2.0') {
      return {
        backup_id: id,
        filename: (await this.findOne(id)).filename,
        is_legacy: true,
        supports_explorer: false,
        message: 'This backup was created with a legacy format (v1.0 or plain SQL) and does not support historical snapshot browsing.',
      };
    }

    const dataDir = path.join(cacheDir, 'data');
    const entities: any[] = [];

    if (fs.existsSync(dataDir)) {
      const files = fs.readdirSync(dataDir).filter((f) => f.endsWith('.json'));
      for (const file of files) {
        const entityName = file.replace('.json', '');
        const jsonPath = path.join(dataDir, file);
        try {
          const content = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
          entities.push({
            name: entityName,
            display_name: ENTITY_DISPLAY_NAMES[entityName] || entityName,
            count: Array.isArray(content) ? content.length : 0,
          });
        } catch {}
      }
    }

    return {
      backup_id: id,
      filename: manifest.filename || (await this.findOne(id)).filename,
      backup_type: manifest.backup_type,
      selected_categories: manifest.selected_categories,
      created_at: manifest.created_at,
      is_legacy: false,
      supports_explorer: true,
      manifest,
      entities,
    };
  }

  /**
   * Explorer Entity Record List API (Paginated & Searchable)
   */
  async getExplorerEntityRecords(
    id: number,
    entityName: string,
    query: { page?: string; limit?: string; search?: string },
  ): Promise<any> {
    const cacheDir = await this.ensureExtractedCache(id);
    const jsonPath = path.join(cacheDir, 'data', `${entityName}.json`);

    if (!fs.existsSync(jsonPath)) {
      throw new NotFoundException(`Entity "${entityName}" does not exist in backup snapshot #${id}.`);
    }

    let records: any[] = [];
    try {
      records = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    } catch {
      throw new InternalServerErrorException(`Failed to parse entity "${entityName}" snapshot data.`);
    }

    if (query.search) {
      const searchLower = query.search.toLowerCase();
      records = records.filter((r) => JSON.stringify(r).toLowerCase().includes(searchLower));
    }

    const page = Math.max(1, parseInt(query.page || '1', 10));
    const limit = Math.max(1, parseInt(query.limit || '10', 10));

    const totalCount = records.length;
    const skip = (page - 1) * limit;
    const paginated = records.slice(skip, skip + limit);

    return {
      entity: entityName,
      display_name: ENTITY_DISPLAY_NAMES[entityName] || entityName,
      total_count: totalCount,
      page,
      limit,
      records: paginated,
    };
  }

  /**
   * Explorer Detailed Record View API (Strictly Live-DB Independent)
   */
  async getExplorerRecordDetail(id: number, entityName: string, recordId: number): Promise<any> {
    const cacheDir = await this.ensureExtractedCache(id);
    const jsonPath = path.join(cacheDir, 'data', `${entityName}.json`);

    if (!fs.existsSync(jsonPath)) {
      throw new NotFoundException(`Entity "${entityName}" does not exist in backup snapshot #${id}.`);
    }

    const records = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const targetRecord = records.find((r: any) => Number(r.id) === Number(recordId));

    if (!targetRecord) {
      throw new NotFoundException(`Record #${recordId} in "${entityName}" was not found in backup #${id}.`);
    }

    // Resolve FK relationships exclusively from snapshot JSON files
    const relations: Record<string, any> = {};

    const readSnapshotFile = (file: string) => {
      const p = path.join(cacheDir, 'data', `${file}.json`);
      if (fs.existsSync(p)) {
        try {
          return JSON.parse(fs.readFileSync(p, 'utf8'));
        } catch {}
      }
      return [];
    };

    if (entityName === 'invoices') {
      const clients = readSnapshotFile('clients');
      if (targetRecord.client_id) {
        relations.client = clients.find((c: any) => c.id === targetRecord.client_id) || null;
      }
      const items = readSnapshotFile('invoice_items');
      relations.items = items.filter((i: any) => i.invoice_id === targetRecord.id);
      const payments = readSnapshotFile('invoice_payments');
      relations.payments = payments.filter((p: any) => p.invoice_id === targetRecord.id);
    } else if (entityName === 'clients') {
      const projects = readSnapshotFile('projects');
      relations.projects = projects.filter((p: any) => p.client_id === targetRecord.id);
      const invoices = readSnapshotFile('invoices');
      relations.invoices = invoices.filter((i: any) => i.client_id === targetRecord.id);
      const leads = readSnapshotFile('leads');
      relations.leads = leads.filter((l: any) => l.client_id === targetRecord.id);
      const proposals = readSnapshotFile('proposals');
      relations.proposals = proposals.filter((pr: any) => pr.client_id === targetRecord.id);
    } else if (entityName === 'projects') {
      const clients = readSnapshotFile('clients');
      if (targetRecord.client_id) {
        relations.client = clients.find((c: any) => c.id === targetRecord.client_id) || null;
      }
      const milestones = readSnapshotFile('milestones');
      relations.milestones = milestones.filter((m: any) => m.project_id === targetRecord.id);
      const members = readSnapshotFile('project_members');
      relations.members = members.filter((m: any) => m.project_id === targetRecord.id);
      const tasks = readSnapshotFile('tasks');
      relations.tasks = tasks.filter((t: any) => t.project_id === targetRecord.id);
    } else if (entityName === 'tasks') {
      const projects = readSnapshotFile('projects');
      if (targetRecord.project_id) {
        relations.project = projects.find((p: any) => p.id === targetRecord.project_id) || null;
      }
      const files = readSnapshotFile('task_files');
      relations.files = files.filter((f: any) => f.task_id === targetRecord.id);
      const assignments = readSnapshotFile('task_assignments');
      relations.assignments = assignments.filter((a: any) => a.task_id === targetRecord.id);
      const comments = readSnapshotFile('task_comments');
      relations.comments = comments.filter((c: any) => c.task_id === targetRecord.id);
      const reviews = readSnapshotFile('task_reviews');
      const fileIds = relations.files.map((f: any) => f.id);
      relations.reviews = reviews.filter((r: any) => fileIds.includes(r.task_file_id));
    } else if (entityName === 'employees') {
      const users = readSnapshotFile('users');
      if (targetRecord.user_id) {
        relations.user = users.find((u: any) => u.id === targetRecord.user_id) || null;
      }
      const depts = readSnapshotFile('departments');
      if (targetRecord.department_id) {
        relations.department = depts.find((d: any) => d.id === targetRecord.department_id) || null;
      }
      const hrDocs = readSnapshotFile('hr_documents');
      relations.hr_documents = hrDocs.filter((d: any) => d.employee_id === targetRecord.id);
    } else if (entityName === 'proposals') {
      const clients = readSnapshotFile('clients');
      if (targetRecord.client_id) {
        relations.client = clients.find((c: any) => c.id === targetRecord.client_id) || null;
      }
      const leads = readSnapshotFile('leads');
      if (targetRecord.lead_id) {
        relations.lead = leads.find((l: any) => l.id === targetRecord.lead_id) || null;
      }
      const items = readSnapshotFile('proposal_items');
      relations.items = items.filter((i: any) => i.proposal_id === targetRecord.id);
    }

    // Discover linked files in documents/
    const docs: any[] = [];
    const docsDir = path.join(cacheDir, 'documents');
    if (fs.existsSync(docsDir)) {
      if (entityName === 'invoices') {
        const safeInvNum = (targetRecord.invoice_number || `invoice_${targetRecord.id}`).replace(/[\/\\]/g, '_');
        const pdfRelPath = `documents/invoices/${safeInvNum}.pdf`;
        if (fs.existsSync(path.join(cacheDir, pdfRelPath))) {
          docs.push({ title: 'Invoice PDF', relative_path: pdfRelPath });
        }
      } else if (entityName === 'proposals') {
        const pdfRelPath = `documents/proposals/proposal_${targetRecord.id}.pdf`;
        if (fs.existsSync(path.join(cacheDir, pdfRelPath))) {
          docs.push({ title: 'Proposal PDF', relative_path: pdfRelPath });
        }
      } else if (entityName === 'hr_documents') {
        const pdfRelPath = `documents/hr/${targetRecord.doc_type}_${targetRecord.id}.pdf`;
        if (fs.existsSync(path.join(cacheDir, pdfRelPath))) {
          docs.push({ title: 'HR Document PDF', relative_path: pdfRelPath });
        }
      } else if (entityName === 'tasks') {
        const taskFiles = readSnapshotFile('task_files');
        const tFiles = taskFiles.filter((f: any) => f.task_id === targetRecord.id);
        for (const tf of tFiles) {
          if (tf.file_path) {
            const relPath = `documents/tasks/${path.basename(tf.file_path)}`;
            if (fs.existsSync(path.join(cacheDir, relPath))) {
              docs.push({ title: tf.file_path, relative_path: relPath });
            }
          }
        }
      }
    }

    return {
      entity: entityName,
      record: targetRecord,
      relations,
      documents: docs,
    };
  }

  /**
   * Explorer List All Snapshot Documents API
   */
  async getExplorerDocuments(id: number): Promise<any[]> {
    const cacheDir = await this.ensureExtractedCache(id);
    const docsDir = path.join(cacheDir, 'documents');

    if (!fs.existsSync(docsDir)) {
      return [];
    }

    const fileList: any[] = [];
    const walkSync = (currentDir: string) => {
      const entries = fs.readdirSync(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(currentDir, entry.name);
        if (entry.isDirectory()) {
          walkSync(fullPath);
        } else if (entry.isFile()) {
          const relPath = path.relative(cacheDir, fullPath).replace(/\\/g, '/');
          const stat = fs.statSync(fullPath);
          fileList.push({
            filename: entry.name,
            relative_path: relPath,
            size_bytes: stat.size,
            category: relPath.split('/')[1] || 'general',
          });
        }
      }
    };

    walkSync(docsDir);
    return fileList;
  }

  /**
   * Explorer Stream / Download Document File Provider with Path Traversal Protection
   */
  async getExplorerDocumentPath(id: number, relativePath: string): Promise<{ filePath: string; filename: string }> {
    if (!relativePath) {
      throw new BadRequestException('Query parameter "path" is required.');
    }

    const cacheDir = await this.ensureExtractedCache(id);
    const safeFilePath = path.resolve(cacheDir, relativePath);

    // Strict path traversal containment check
    if (!safeFilePath.startsWith(cacheDir)) {
      throw new ForbiddenException('Invalid document path traversal attempt.');
    }

    if (!fs.existsSync(safeFilePath)) {
      throw new NotFoundException(`Requested document "${relativePath}" was not found in backup #${id}.`);
    }

    return { filePath: safeFilePath, filename: path.basename(safeFilePath) };
  }
}
