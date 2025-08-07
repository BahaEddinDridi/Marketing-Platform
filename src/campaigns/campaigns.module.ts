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
import { GoogleCampaignsService } from './google/googleCampaign.service';
import { GoogleCampaignController } from './google/googleCampaign.controller';
import { GoogleCampaignBudgetService } from './google/googleCampaignBudget.service';
import { GoogleAdsService } from './google/googleAdGroup.service';
import { MetaCampaignService } from './meta/metaCampaign.service';
import { MetaCampaignController } from './meta/metaCampaign.controller';
import { MetaAdSetService } from './meta/metaAdSet.service';
import { NotificationsModule } from 'src/notifications/notifications.module';
import { GoogleAdsAIService } from './google/googleAd.service';

@Module({
  imports: [PrismaModule, AuthModule, AnalyticsModule, NotificationsModule],
  controllers: [
    CampaignsController,
    LinkedInAdsController,
    LinkedInAudienceController,
    GoogleCampaignController,
    MetaCampaignController
  ],
  providers: [
    CampaignsService,
    LinkedInAdsService,
    LinkedInAudienceService,
    LinkedInCampaignsService,
    GoogleCampaignsService,
    GoogleCampaignBudgetService,
    GoogleAdsService,
    GoogleAdsAIService,
    MetaCampaignService,
    MetaAdSetService
  ],
})
export class CampaignsModule {}
