import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { PrismaModule } from 'src/prisma/prisma.module';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { MicrosoftLeadsStrategy } from 'src/strategies/microsoft-leads.strategy';
import { OrganizationModule } from 'src/organization/organization.module';
import { MicrosoftStrategy } from 'src/strategies/microsoft.strategy';
import { LinkedInStrategy } from 'src/strategies/linkedin.strategy';
import { FacebookStrategy } from 'src/strategies/facebook.strategy';

@Module({
  imports: [
    PrismaModule,
    PassportModule,
    JwtModule.register({
      secret: process.env.JWT_SECRET,
      signOptions: { expiresIn: '1h' },
    }),
    OrganizationModule
  ],
  controllers: [AuthController],
  providers: [AuthService, MicrosoftLeadsStrategy, MicrosoftStrategy, LinkedInStrategy, FacebookStrategy],
  exports: [AuthService, MicrosoftLeadsStrategy],
})
export class AuthModule {}
