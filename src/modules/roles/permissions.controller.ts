import { Controller, Get, UseGuards } from '@nestjs/common';
import { RolesService } from './roles.service';
import { JwtAuthGuard } from '../../core/guards/jwt-auth.guard';
import { PermissionsGuard } from '../../core/guards/permissions.guard';
import { Permissions } from '../../core/decorators/permissions.decorator';
import { CurrentUser } from '../../core/decorators/current-user.decorator';
import { ROLE_MANAGEMENT_PERMISSION } from '../../core/utils/permission-catalog';
import { PermissionCatalogResponseDto } from './dto/permission-catalog.dto';

// -------------------------------------------------------------
// PERMISSION CATALOG (/api/v1/permissions/) - read-only
// Only role managers need it (to build role permission checkboxes).
// -------------------------------------------------------------
@Controller('api/v1/permissions')
@UseGuards(JwtAuthGuard, PermissionsGuard)
export class PermissionsController {
  constructor(private readonly rolesService: RolesService) {}

  @Get()
  @Permissions(ROLE_MANAGEMENT_PERMISSION)
  getCatalog(@CurrentUser() reqUser: any): PermissionCatalogResponseDto {
    return this.rolesService.getPermissionCatalog(reqUser);
  }
}
