/** One permission in the catalog returned by GET /api/v1/permissions. */
export class PermissionCatalogEntryDto {
  /** Stable identifier stored on roles and checked by guards, e.g. "MANAGE_USERS". */
  id: string;
  label: string;
  category: string;
  description: string;
  /** Whether the requesting user may grant this permission to a role. */
  assignable: boolean;
}

/** Response of GET /api/v1/permissions. */
export class PermissionCatalogResponseDto {
  /** Category names in display order. */
  categories: string[];
  permissions: PermissionCatalogEntryDto[];
}
