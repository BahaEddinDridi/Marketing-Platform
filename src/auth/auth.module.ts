import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PrismaModule } from 'src/prisma/prisma.module';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { MicrosoftLeadsStrategy } from 'src/strategies/microsoft-leads.strategy';
import { OrganizationModule } from 'src/organization/organization.module';
import { MicrosoftAuthConfigService } from 'src/strategies/microsoft-auth-config.service';
import { ConfigService } from '@nestjs/config';
import { MicrosoftStrategy } from 'src/strategies/microsoft.strategy';
import { PrismaService } from 'src/prisma/prisma.service';
import { MicrosoftStrategyProvider } from 'src/middlewares/microsoft-strategy.provider';
import { MicrosoftLeadsStrategyProvider } from 'src/middlewares/microsoft-leads-strategy.provider';

@Module({
  imports: [
    PrismaModule,
    PassportModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET,
      signOptions: { expiresIn: '1h' },
    }),
    OrganizationModule,
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    MicrosoftAuthConfigService,
    ConfigService,
    MicrosoftStrategyProvider,
    MicrosoftLeadsStrategyProvider,
  ],
  exports: [
    AuthService,
    MicrosoftAuthConfigService,
    'MICROSOFT_STRATEGY',
    'MICROSOFT_LEADS_STRATEGY',
  ],
})
export class AuthModule {}
