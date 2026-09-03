import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
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

    // Superuser native Django bypass
    if (user.is_superuser || user.role?.name === 'SUPER_ADMIN') {
      return true;
    }

    // CLIENT role native Django bypass for read-only client-scoped endpoints
    if (user.role?.name === 'CLIENT' && requiredPermissions.every((p) => String(p).toUpperCase().startsWith('VIEW_'))) {
      return true;
    }

    if (!user.role || !user.role.permissions) {
      throw new ForbiddenException('You do not have permission to perform this action.');
    }

    const userPermissions: string[] = Array.isArray(user.role.permissions)
      ? (user.role.permissions as string[])
      : [];

    const hasAll = requiredPermissions.some((perm) =>
      userPermissions.map((p) => String(p).toUpperCase()).includes(String(perm).toUpperCase()),
    );

    if (!hasAll) {
      throw new ForbiddenException('You do not have permission to perform this action.');
    }

    return true;
  }
}
