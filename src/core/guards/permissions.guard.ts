import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { CLIENT_ACCESS_KEY } from '../decorators/client-access.decorator';
import { getActiveRolePermissions, isActiveRole, isSuperAdmin } from '../utils/role-access.util';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredPermissions || requiredPermissions.length === 0) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest();

    if (!user) {
      throw new ForbiddenException('User not authenticated');
    }

    // Superuser bypass: is_superuser flag or the ACTIVE built-in SUPER_ADMIN role
    if (isSuperAdmin(user)) {
      return true;
    }

    // CLIENT users may call only routes explicitly marked @ClientAccess() (client-portal routes
    // whose services scope CLIENT callers to their own client). Previously any VIEW_-only route
    // was open to CLIENT, including writes and company-wide reports.
    const clientAccess = this.reflector.getAllAndOverride<boolean>(CLIENT_ACCESS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (clientAccess === true && isActiveRole(user.role) && user.role.name === 'CLIENT') {
      return true;
    }

    // Soft-deleted or missing roles grant no permissions
    const userPermissions = getActiveRolePermissions(user);

    // Any one of the listed permissions is sufficient
    const hasAny = requiredPermissions.some((perm) => userPermissions.includes(String(perm).toUpperCase()));

    if (!hasAny) {
      throw new ForbiddenException('You do not have permission to perform this action.');
    }

    return true;
  }
}
