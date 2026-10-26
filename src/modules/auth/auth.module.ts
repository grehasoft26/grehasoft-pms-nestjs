import { Module } from '@nestjs/common';
import { JwtModule, JwtModuleOptions } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigService } from '@nestjs/config';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { JwtStrategy } from '../../core/guards/jwt.strategy';
import { requireJwtSecret } from '../../core/utils/jwt-secret.util';

/** JwtModule options; same validated secret as JwtStrategy, no fallback (missing JWT_SECRET stops startup). */
export const jwtModuleOptionsFactory = (config: ConfigService): JwtModuleOptions => ({
  secret: requireJwtSecret(config),
  signOptions: { expiresIn: '1d' },
});

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: jwtModuleOptionsFactory,
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy],
  exports: [AuthService, JwtModule],
})
export class AuthModule {}
