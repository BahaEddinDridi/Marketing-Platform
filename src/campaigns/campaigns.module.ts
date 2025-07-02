import { Module } from '@nestjs/common';
import { CampaignsService } from './campaigns.service';
import { CampaignsController } from './campaigns.controller';
import { PrismaModule } from 'src/prisma/prisma.module';
import { AuthModule } from 'src/auth/auth.module';
import { LinkedInAdsService } from './linkedin/linkedinAds.service';
import { LinkedInAdsController } from './linkedin/linkedinAds.controller';
import { LinkedInAudienceService } from './linkedin/linkedinAudienceTemplates.service';
import { LinkedInAudienceController } from './linkedin/linkedinAudienceTemplates.controller';
import { LinkedInCampaignsService } from './linkedin/linkedinCampaign.service';
import { AnalyticsModule } from 'src/analytics/analytics.module';

@Module({
  imports: [PrismaModule, AuthModule, AnalyticsModule],
  controllers: [CampaignsController, LinkedInAdsController, LinkedInAudienceController, ],
  providers: [CampaignsService, LinkedInAdsService, LinkedInAudienceService, LinkedInCampaignsService],
})
export class CampaignsModule {}
