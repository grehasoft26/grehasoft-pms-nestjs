/**
 * Canonical permission catalog and built-in role names.
 *
 * PERMISSION_DEFINITIONS is the single source of truth for permission identifiers.
 * It covers every name used by the backend guards (@Permissions), prisma/seed.ts and
 * existing role records. Role create/update accepts only these identifiers, and the
 * role-management UI renders its checkboxes from GET /api/v1/permissions.
 * A consistency test (permission-catalog.spec.ts) fails if a guard or the seed uses a
 * name missing here. Identifiers are stable; never rename one that roles already store.
 *
 * BUILT_IN_ROLE_NAMES are the seeded roles whose NAMES drive authorization or behaviour
 * (backend services compare role names; the frontend portal registry routes by role name).
 * Their names are immutable and reserved; see RolesService.
 */

export const PERMISSION_CATEGORIES = [
  'Dashboard',
  'Projects & Tasks',
  'Clients & Sales',
  'Finance',
  'Reminders',
  'SEO',
  'HR',
  'Credentials',
  'Administration',
] as const;

export type PermissionCategory = (typeof PERMISSION_CATEGORIES)[number];

export interface PermissionDefinition {
  id: string;
  label: string;
  category: PermissionCategory;
  description: string;
}

export const PERMISSION_DEFINITIONS: readonly PermissionDefinition[] = [
  { id: 'VIEW_DASHBOARD', label: 'View dashboard', category: 'Dashboard', description: 'Open the main dashboard.' },

  { id: 'VIEW_PROJECTS', label: 'View projects', category: 'Projects & Tasks', description: 'See projects and their details.' },
  { id: 'MANAGE_PROJECTS', label: 'Manage projects', category: 'Projects & Tasks', description: 'Create, edit and delete projects, members and milestones.' },
  { id: 'VIEW_TASKS', label: 'View tasks', category: 'Projects & Tasks', description: 'See tasks.' },
  { id: 'MANAGE_TASKS', label: 'Manage tasks', category: 'Projects & Tasks', description: 'Create, edit, assign and delete tasks.' },

  { id: 'VIEW_CLIENTS', label: 'View clients', category: 'Clients & Sales', description: 'See client records.' },
  { id: 'MANAGE_CLIENTS', label: 'Manage clients', category: 'Clients & Sales', description: 'Create, edit and delete clients.' },
  { id: 'VIEW_LEADS', label: 'View leads', category: 'Clients & Sales', description: 'See CRM leads.' },
  { id: 'MANAGE_LEADS', label: 'Manage leads', category: 'Clients & Sales', description: 'Create, edit, assign and follow up leads.' },
  { id: 'VIEW_PROPOSALS', label: 'View proposals', category: 'Clients & Sales', description: 'See proposals.' },
  { id: 'MANAGE_PROPOSALS', label: 'Manage proposals', category: 'Clients & Sales', description: 'Create, edit and send proposals.' },

  { id: 'VIEW_INVOICES', label: 'View invoices', category: 'Finance', description: 'See invoices and invoice templates.' },
  { id: 'MANAGE_INVOICES', label: 'Manage invoices', category: 'Finance', description: 'Create and edit invoices and invoice templates.' },
  { id: 'VIEW_EXPENSES', label: 'View expenses', category: 'Finance', description: 'See expenses and expense categories.' },
  { id: 'MANAGE_EXPENSES', label: 'Manage expenses', category: 'Finance', description: 'Create, edit and delete expenses and categories.' },
  { id: 'VIEW_FINANCIAL_REPORTS', label: 'View financial reports', category: 'Finance', description: 'See the financial dashboard and reports.' },

  { id: 'VIEW_REMINDERS', label: 'View reminders', category: 'Reminders', description: 'See reminders.' },
  { id: 'MANAGE_REMINDERS', label: 'Manage reminders', category: 'Reminders', description: 'Create, edit and complete reminders.' },

  { id: 'MANAGE_SEO', label: 'Manage SEO (legacy)', category: 'SEO', description: 'Legacy SEO permission kept for existing roles.' },
  { id: 'VIEW_SEO_DASHBOARD', label: 'View SEO dashboard', category: 'SEO', description: 'Open the SEO dashboard.' },
  { id: 'VIEW_SEO_WEBSITES', label: 'View SEO websites', category: 'SEO', description: 'See SEO websites.' },
  { id: 'MANAGE_SEO_WEBSITES', label: 'Manage SEO websites', category: 'SEO', description: 'Create and edit SEO websites.' },
  { id: 'VIEW_SEO_ACTIVITIES', label: 'View SEO activities', category: 'SEO', description: 'See SEO activities.' },
  { id: 'MANAGE_SEO_ACTIVITIES', label: 'Manage SEO activities', category: 'SEO', description: 'Log and edit SEO activities.' },
  { id: 'IMPORT_SEO_ACTIVITIES', label: 'Import SEO activities', category: 'SEO', description: 'Bulk-import SEO activities.' },
  { id: 'MANAGE_SEO_TARGETS', label: 'Manage SEO targets', category: 'SEO', description: 'Set monthly SEO targets.' },
  { id: 'VIEW_SEO_TASKS', label: 'View SEO tasks', category: 'SEO', description: 'See SEO tasks.' },
  { id: 'MANAGE_SEO_TASKS', label: 'Manage SEO tasks', category: 'SEO', description: 'Create and assign SEO tasks.' },
  { id: 'VIEW_SEO_REMINDERS', label: 'View SEO reminders', category: 'SEO', description: 'See SEO reminders.' },
  { id: 'MANAGE_SEO_REMINDERS', label: 'Manage SEO reminders', category: 'SEO', description: 'Create and edit SEO reminders.' },
  { id: 'VIEW_SEO_REPORTS', label: 'View SEO reports', category: 'SEO', description: 'See SEO reports.' },
  { id: 'MANAGE_SEO_REPORTS', label: 'Manage SEO reports', category: 'SEO', description: 'Create and edit SEO reports.' },
  { id: 'PUBLISH_SEO_REPORTS', label: 'Publish SEO reports', category: 'SEO', description: 'Publish SEO reports to clients.' },
  { id: 'EXPORT_SEO_REPORTS', label: 'Export SEO reports', category: 'SEO', description: 'Export SEO reports.' },

  { id: 'GENERATE_HR_DOCS', label: 'Generate HR documents', category: 'HR', description: 'Generate HR documents such as letters.' },

  { id: 'MANAGE_CREDENTIALS', label: 'Manage credentials', category: 'Credentials', description: 'Manage credential records and replace stored secrets.' },
  { id: 'REVEAL_CREDENTIALS', label: 'Reveal credentials', category: 'Credentials', description: 'Reveal stored credentials through authorized endpoints.' },
  { id: 'VIEW_CREDENTIAL_AUDIT', label: 'View credential audit', category: 'Credentials', description: 'View credential access and permission-change audit records.' },

  { id: 'MANAGE_USERS', label: 'Manage users', category: 'Administration', description: 'Create, edit, deactivate users and assign roles.' },
  { id: 'MANAGE_ROLES', label: 'Manage roles', category: 'Administration', description: 'Create, edit and delete roles and their permissions.' },
  { id: 'MANAGE_DEPARTMENTS', label: 'Manage departments', category: 'Administration', description: 'Create and edit departments.' },
  { id: 'MANAGE_SETTINGS', label: 'Manage settings', category: 'Administration', description: 'System settings: task types, work tracking and reports, expense categories.' },
  { id: 'MANAGE_INFRASTRUCTURE', label: 'Manage infrastructure', category: 'Administration', description: 'Servers, domains and credentials.' },
  { id: 'MANAGE_BACKUPS', label: 'Manage backups', category: 'Administration', description: 'Create, download and restore system backups.' },
];

export const KNOWN_PERMISSIONS: readonly string[] = PERMISSION_DEFINITIONS.map((p) => p.id);

export type KnownPermission = string;

const KNOWN_PERMISSION_SET: ReadonlySet<string> = new Set(KNOWN_PERMISSIONS);

export const isKnownPermission = (value: string): value is KnownPermission => KNOWN_PERMISSION_SET.has(value);

/** Permission that controls role management (backend guards and the frontend Roles page). */
export const ROLE_MANAGEMENT_PERMISSION = 'MANAGE_ROLES';

/**
 * Invoice and invoice-payment access (Phase 2.2). Previously these APIs required only login.
 * VIEW_LEADS is included because the frontend Finance > Invoices menu is gated on it, so users
 * who could reach invoices through the UI keep access. Tightening this is a pending decision.
 */
/**
 * Credential Vault permissions. Only super admins may grant or revoke them: through role
 * create/update (RolesService) and through user role assignment (UsersService).
 */
export const CREDENTIAL_PERMISSIONS = ['MANAGE_CREDENTIALS', 'REVEAL_CREDENTIALS', 'VIEW_CREDENTIAL_AUDIT'] as const;

const CREDENTIAL_PERMISSION_SET: ReadonlySet<string> = new Set(CREDENTIAL_PERMISSIONS);

export const isCredentialPermission = (value: string): boolean => CREDENTIAL_PERMISSION_SET.has(String(value).toUpperCase());

/** Credential permissions (upper-cased, unique) in a role's stored permissions; [] for non-arrays. */
export const credentialPermissionsIn = (permissions: unknown): string[] =>
  Array.isArray(permissions)
    ? [...new Set(permissions.filter((p): p is string => typeof p === 'string').map((p) => p.toUpperCase()).filter(isCredentialPermission))]
    : [];

export const INVOICE_READ_PERMISSIONS = ['MANAGE_INVOICES', 'VIEW_INVOICES', 'VIEW_LEADS'] as const;
export const INVOICE_WRITE_PERMISSIONS = ['MANAGE_INVOICES', 'VIEW_LEADS'] as const;

export const BUILT_IN_ROLE_NAMES = [
  'SUPER_ADMIN',
  'ADMIN',
  'PROJECT_MANAGER',
  'TEAM_MEMBER',
  'SALES_MANAGER',
  'SALES_EXECUTIVE',
  'CLIENT',
  'SEO_MANAGER',
  'SEO_EXECUTIVE',
] as const;

const BUILT_IN_ROLE_SET: ReadonlySet<string> = new Set(BUILT_IN_ROLE_NAMES);

/** True for built-in role names (case-insensitive, like the roles.name collation). */
export const isBuiltInRoleName = (name: string | null | undefined): boolean =>
  !!name && BUILT_IN_ROLE_SET.has(String(name).trim().toUpperCase());

/**
 * Privileged built-in roles: only super admins may assign them, or change the role of a
 * user who holds one (UsersService). Names are immutable built-ins, so name checks are safe.
 */
export const PRIVILEGED_ROLE_NAMES = ['SUPER_ADMIN', 'ADMIN'] as const;

const PRIVILEGED_ROLE_SET: ReadonlySet<string> = new Set(PRIVILEGED_ROLE_NAMES);

export const isPrivilegedRoleName = (name: string | null | undefined): boolean =>
  !!name && PRIVILEGED_ROLE_SET.has(String(name).trim().toUpperCase());
