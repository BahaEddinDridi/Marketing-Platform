import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { LeadModule } from './lead/lead.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { JwtStrategy } from './strategies/jwt.strategy';
import { RefreshTokenStrategy } from './strategies/refresh-token.strategy';
import { PrismaModule } from './prisma/prisma.module';
import { GoogleStrategy } from './strategies/google.strategy';
import { CampaignsModule } from './campaigns/campaigns.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { PasswordResetModule } from './password-reset/password-reset.module';
import { MicrosoftStrategy } from './strategies/microsoft.strategy';
import { MicrosoftLeadsStrategy } from './strategies/microsoft-leads.strategy';
import { MicrosoftTestStrategy } from './strategies/microsoft-test.strategy';

@Module({
  imports: [
    LeadModule,
    AuthModule,
    UsersModule,
    PrismaModule,
    ThrottlerModule.forRoot({
      throttlers: [
        {
          ttl: 60000,
          limit: 100,
        },
      ],
    }),
    ConfigModule.forRoot({ isGlobal: true }),
    JwtModule.register({}),
    CampaignsModule,
    AnalyticsModule,
    PasswordResetModule,
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    JwtStrategy,
    RefreshTokenStrategy,
    GoogleStrategy,
    MicrosoftStrategy,
    MicrosoftLeadsStrategy,
    MicrosoftTestStrategy
  ],
})
export class AppModule {}
