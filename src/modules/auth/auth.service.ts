import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../core/prisma.service';
import { PasswordUtil } from '../../core/utils/password.util';
import { formatUserResponse } from '../users/user.serializer';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
  ) {}

  async login(credentials: { username?: string; password?: string }) {
    const { username, password } = credentials;
    if (!username || !password) {
      throw new UnauthorizedException('Username and password are required.');
    }

    const user = await this.prisma.user.findFirst({
      where: {
        username,
        deleted_at: null,
      },
      include: {
        role: true,
        department: true,
        client: true,
      },
    });

    if (!user || !user.is_active) {
      throw new UnauthorizedException('No active account found with the given credentials');
    }

    const isValidPassword = await PasswordUtil.verifyPassword(password, user.password);
    if (!isValidPassword) {
      throw new UnauthorizedException('No active account found with the given credentials');
    }

    // Update last_login
    const now = new Date();
    await this.prisma.user.update({
      where: { id: user.id },
      data: { last_login: now },
    });

    user.last_login = now;

    const payload = {
      sub: user.id,
      username: user.username,
      email: user.email,
    };

    const access = this.jwtService.sign(payload, { expiresIn: '1d' });
    const refresh = this.jwtService.sign(payload, { expiresIn: '7d' });

    return {
      access,
      refresh,
      user: formatUserResponse(user),
    };
  }

  async refreshToken(refreshToken: string) {
    if (!refreshToken) {
      throw new UnauthorizedException('Refresh token is required');
    }

    try {
      const payload = this.jwtService.verify(refreshToken);
      const userId = Number(payload.sub || payload.user_id || payload.id);

      const user = await this.prisma.user.findFirst({
        where: { id: userId, deleted_at: null, is_active: true },
      });

      if (!user) {
        throw new UnauthorizedException('User not found or inactive');
      }

      const newPayload = {
        sub: user.id,
        username: user.username,
        email: user.email,
      };

      const access = this.jwtService.sign(newPayload, { expiresIn: '1d' });
      return { access };
    } catch {
      throw new UnauthorizedException('Invalid or expired refresh token');
    }
  }
}
