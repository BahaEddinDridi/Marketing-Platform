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
import { LinkedInService } from './linkedIn/linkedIn.service';
import { LinkedInController } from './linkedIn/linkedIn.controller';
import { LinkedInAuthConfigService } from 'src/middlewares/linkedIn/linkedin-auth-config.service';
import { LinkedInStrategyProvider } from 'src/middlewares/linkedIn/linkedin-strategy.provider';
import { LinkedInPageStrategyProvider } from 'src/middlewares/linkedIn/linkedin-page-strategy.provider';

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
  controllers: [AuthController, LinkedInController],
  providers: [
    AuthService,
    MicrosoftAuthConfigService,
    ConfigService,
    LinkedInService,
    MicrosoftStrategyProvider,
    MicrosoftLeadsStrategyProvider,
    LinkedInStrategyProvider,
    LinkedInPageStrategyProvider,
  ],
  exports: [
    AuthService,
    LinkedInService,
    MicrosoftAuthConfigService,
    'MICROSOFT_STRATEGY',
    'MICROSOFT_LEADS_STRATEGY',
    'LINKEDIN_STRATEGY',
    'LINKEDIN_PAGE_STRATEGY',
  ],
})
export class AuthModule {}
