import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma.service';
import { DEACTIVATED_ROLE_MESSAGE, applyRoleStatus } from '../utils/role-access.util';
import { requireJwtSecret } from '../utils/jwt-secret.util';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      // Authorization: Bearer only. A token in the URL (?token=) leaks into server and proxy logs,
      // browser history and Referer headers, so it is never accepted; downloads use authenticated
      // requests (axios + blob) or their own signed, purpose-limited links (invoice public links).
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      // No fallback: a missing JWT_SECRET stops the application from starting
      secretOrKey: requireJwtSecret(configService),
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
