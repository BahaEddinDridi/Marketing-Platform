import { Module } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { AnalyticsController } from './analytics.controller';
import { PrismaModule } from 'src/prisma/prisma.module';
import { LinkedInAnalyticsService } from './linkedin/linkedinAnalytics.service';
import { LinkedInAnalyticsController } from './linkedin/linkedinAnalytics.controller';
import { AuthModule } from 'src/auth/auth.module';

@Module({
  imports: [PrismaModule, AuthModule],
  controllers: [AnalyticsController, LinkedInAnalyticsController],
  providers: [AnalyticsService, LinkedInAnalyticsService],
  exports: [AnalyticsService, LinkedInAnalyticsService],
})
export class AnalyticsModule {}
