import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma.service';
import { DEACTIVATED_ROLE_MESSAGE, applyRoleStatus } from '../utils/role-access.util';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        ExtractJwt.fromUrlQueryParameter('token'),
      ]),
      ignoreExpiration: false,
      secretOrKey: configService.get<string>('JWT_SECRET') || 'grehasoft-jwt-secret-key-production-change-me',
    });
  }

  async validate(payload: any) {
    const userId = Number(payload.sub || payload.user_id || payload.id);
    if (!userId) {
      throw new UnauthorizedException('Invalid token payload');
    }

    const user = await this.prisma.user.findFirst({
      where: {
        id: userId,
        deleted_at: null,
        is_active: true,
      },
      include: {
        role: true,
        department: true,
        client: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException('User no longer exists or is inactive');
    }

    // Users still assigned to a soft-deleted role are refused (is_superuser keeps access)
    const active = applyRoleStatus(user);
    if (!active) {
      throw new UnauthorizedException(DEACTIVATED_ROLE_MESSAGE);
    }

    return active;
  }
}
