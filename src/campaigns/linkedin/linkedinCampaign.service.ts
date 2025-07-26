import {
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LinkedInService } from 'src/auth/linkedIn/linkedIn.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { LinkedInAdsService } from './linkedinAds.service';
import { CampaignsService } from '../campaigns.service';
import * as schedule from 'node-schedule';
import axios from 'axios';
import Bottleneck from 'bottleneck';
import { LinkedInAnalyticsService } from 'src/analytics/linkedin/linkedinAnalytics.service';
import { CampaignStatus, ObjectiveType, Status } from '@prisma/client';
import { NotificationsService } from 'src/notifications/notifications.service';

@Injectable()
export class LinkedInCampaignsService {
  private readonly logger = new Logger(LinkedInCampaignsService.name);
  private readonly cronMap = {
    EVERY_20_SECONDS: '*/20 * * * * *',
    EVERY_30_MINUTES: '*/30 * * * *',
    EVERY_HOUR: '0 * * * *',
    EVERY_2_HOURS: '0 */2 * * *',
    EVERY_3_HOURS: '0 */3 * * *',
  };
  private jobs = new Map<string, schedule.Job>();
  private runningSyncs = new Set<string>();
  private readonly limiter = new Bottleneck({
    maxConcurrent: 5, // Allow up to 5 concurrent requests (adjust based on LinkedIn API limits)
    minTime: 200, // Minimum 200ms between requests (adjust based on rate limits)
  });
  constructor(
    private prisma: PrismaService,
    private readonly linkedinService: LinkedInService,
    private readonly configService: ConfigService,
    private readonly linkedInAdsService: LinkedInAdsService,
    private readonly campaignsService: CampaignsService,
    private readonly linkedInAnalyticsService: LinkedInAnalyticsService,
    private readonly notificationService: NotificationsService,
  ) {
    this.startDynamicSync();
  }

  private async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async scheduleOrgSync(orgId: string, syncInterval?: string) {
    const config = await this.prisma.linkedInCampaignConfig.findUnique({
      where: { orgId },
      select: { autoSyncEnabled: true, syncInterval: true },
    });

    if (!config?.autoSyncEnabled) {
      this.logger.log(
        `Auto-sync disabled for org ${orgId}, skipping scheduling`,
      );
      return;
    }

    const existingJob = this.jobs.get(orgId);
    if (existingJob) {
      existingJob.cancel();
      this.jobs.delete(orgId);
      this.logger.log(`Cancelled old sync job for org ${orgId}`);
    }

    const interval = syncInterval || config?.syncInterval || 'EVERY_HOUR';
    const cronExpression = this.cronMap[interval] || this.cronMap.EVERY_HOUR;

    this.logger.log(
      `Scheduling org ${orgId} with ${interval} (${cronExpression})`,
    );

    const job = schedule.scheduleJob(cronExpression, async () => {
      if (this.runningSyncs.has(orgId)) {
        this.logger.warn(`Sync already running for org ${orgId}, skipping`);
        return;
      }

      this.runningSyncs.add(orgId);
      this.logger.log(`Starting sync for org ${orgId}`);
      try {
        await this.limiter.schedule(() =>
          this.syncCampaignsAndAnalytics(orgId),
        );
        await this.notificationService.notifyUsersOfOrg(
          orgId,
          'receiveSyncSuccess',
          {
            title: 'LinkedIn Sync Successful',
            message: `LinkedIn campaigns were successfully synced for your organization.`,
            type: 'success',
            meta: { orgId },
          },
        );
        this.logger.log(`Sync completed for org ${orgId}`);
      } catch (error: any) {
        this.logger.error(
          `Sync failed for org ${orgId}: ${error.message}`,
          error.stack,
        );
      } finally {
        this.runningSyncs.delete(orgId);
      }
    });
    this.jobs.set(orgId, job);
  }

  private async startDynamicSync() {
    this.logger.log('Starting dynamic sync for single-org');
    const orgId = 'single-org';

    try {
      const config = await this.prisma.linkedInCampaignConfig.findUnique({
        where: { orgId },
        select: {
          orgId: true,
          autoSyncEnabled: true,
          syncInterval: true,
        },
      });

      const existingJob = this.jobs.get(orgId);

      if (!config || !config.autoSyncEnabled) {
        if (existingJob) {
          existingJob.cancel();
          this.jobs.delete(orgId);
          this.logger.log(
            `Cancelled sync job for org ${orgId} as config is missing or auto-sync is disabled`,
          );
        }
        if (!config) {
          this.logger.warn('LinkedInCampaignConfig for single-org not found');
        } else {
          this.logger.log(
            `Auto-sync disabled for org ${orgId}, no sync scheduled`,
          );
        }
        return;
      }

      // Schedule a new job only if auto-sync is enabled and no job exists
      if (config.autoSyncEnabled && !this.jobs.has(config.orgId)) {
        await this.scheduleOrgSync(config.orgId, config.syncInterval);
      }
    } catch (error: any) {
      this.logger.error(
        'Error starting dynamic sync:',
        error.message,
        error.stack,
      );
    }
  }

  private async syncCampaignsAndAnalytics(orgId: string) {
    this.logger.log(`Syncing campaigns and analytics for org ${orgId}`);

    const config = await this.prisma.linkedInCampaignConfig.findUnique({
      where: { orgId },
      include: {
        adAccounts: true,
        campaignGroups: {
          include: {
            campaigns: {
              select: {
                external_id: true,
                status: true,
                objective: true,
                start_date: true,
                Ads: {
                  select: {
                    id: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!config || !config.autoSyncEnabled) {
      this.logger.log(`No config found or auto-sync disabled for org ${orgId}`);
      return;
    }

    if (!config.campaignGroups.length) {
      this.logger.log(`No campaign groups configured for org ${orgId}`);
      return;
    }

    const leadGenerationMetrics = [
      'impressions',
      'clicks',
      'landingPageClicks',
      'qualifiedLeads',
      'costInLocalCurrency',
      'costPerQualifiedLead',
      'externalWebsiteConversions',
      'reactions',
      'shares',
      'follows',
      'pivotValues',
      'dateRange',
    ];

    const brandAwarenessMetrics = [
      'impressions',
      'clicks',
      'videoViews',
      'videoCompletions',
      'reactions',
      'shares',
      'comments',
      'follows',
      'averageDwellTime',
      'cardClicks',
      'pivotValues',
      'dateRange',
    ];

    // Define the campaign type based on Prisma schema
    type Campaign = {
      external_id: string | null;
      objective: ObjectiveType | null;
      status: CampaignStatus;
      start_date: Date | null;
      Ads: { id: string }[];
    };

    // Group campaigns by ad account
    const campaignsByAdAccount = new Map<string, Campaign[]>();
    for (const group of config.campaignGroups) {
      const adAccount = config.adAccounts.find(
        (acc) => group.adAccountId === acc.id,
      );
      if (!adAccount) {
        this.logger.warn(`No ad account found for campaign group ${group.id}`);
        continue;
      }

      const validCampaigns = group.campaigns
        .filter((campaign) =>
          ['ACTIVE', 'PAUSED', 'DRAFT', 'COMPLETED'].includes(campaign.status),
        )
        .filter(
          (
            campaign,
          ): campaign is any & {
            external_id: string;
            objective: ObjectiveType;
          } => campaign.external_id !== null && campaign.objective !== null,
        );

      if (validCampaigns.length === 0) {
        this.logger.log(`No active campaigns found for group ${group.id}`);
        continue;
      }

      const existingCampaigns = campaignsByAdAccount.get(adAccount.id) || [];
      campaignsByAdAccount.set(adAccount.id, [
        ...existingCampaigns,
        ...validCampaigns,
      ]);
    }

    if (campaignsByAdAccount.size === 0) {
      this.logger.log(`No valid campaigns found for org ${orgId}`);
      return;
    }

    // Process campaigns by ad account
    for (const [adAccountId, campaigns] of campaignsByAdAccount) {
      // Batch campaign IDs for campaign sync (max 20)
      const campaignIds = campaigns
        .map((campaign) => campaign.external_id)
        .filter((id): id is string => id !== null);
      const campaignIdBatches: string[][] = [];
      for (let i = 0; i < campaignIds.length; i += 20) {
        campaignIdBatches.push(campaignIds.slice(i, i + 20));
      }

      // Sync campaigns in batches
      for (const batch of campaignIdBatches) {
        await this.limiter.schedule(() =>
          this.fetchAndSyncLinkedInCampaignsByIds(batch, adAccountId),
        );
      }

      // Group campaigns by objective type for analytics
      const leadGenCampaigns = campaigns
        .filter((campaign) => campaign.objective === 'LEAD_GENERATION')
        .map((campaign) => ({
          urn: `urn:li:sponsoredCampaign:${campaign.external_id}`,
          start_date: campaign.start_date,
          ads: campaign.Ads,
        }));
      const otherCampaigns = campaigns
        .filter((campaign) => campaign.objective !== 'LEAD_GENERATION')
        .map((campaign) => ({
          urn: `urn:li:sponsoredCampaign:${campaign.external_id}`,
          start_date: campaign.start_date,
          ads: campaign.Ads,
        }));

      // Set end date to current time
      const endDate = new Date();

      // Helper function to get earliest start date in a batch, defaulting to current time if null
      const getEarliestStartDate = (
        batch: { start_date: Date | null }[],
      ): Date => {
        const validStartDates = batch
          .map((c) => c.start_date)
          .filter((date): date is Date => date !== null);
        if (validStartDates.length === 0) {
          return new Date(); // Default to current time
        }
        return new Date(
          Math.min(...validStartDates.map((date) => date.getTime())),
        );
      };

      // Sync lead generation campaign and ad analytics in batches
      const leadGenUrnBatches: {
        urn: string;
        start_date: Date | null;
        ads: { id: string }[];
      }[][] = [];
      for (let i = 0; i < leadGenCampaigns.length; i += 20) {
        leadGenUrnBatches.push(leadGenCampaigns.slice(i, i + 20));
      }
      for (const batch of leadGenUrnBatches) {
        const startDate = getEarliestStartDate(batch);
        // Campaign analytics: ALL granularity
        await this.limiter.schedule(() =>
          this.linkedInAnalyticsService.fetchLinkedInCampaignAnalytics(
            batch.map((c) => c.urn),
            'ALL',
            startDate,
            endDate,
            leadGenerationMetrics,
          ),
        );
        // Campaign analytics: DAILY granularity
        const dailyDate = new Date(); // Current time for both start and end
        await this.limiter.schedule(() =>
          this.linkedInAnalyticsService.fetchLinkedInCampaignAnalytics(
            batch.map((c) => c.urn),
            'DAILY',
            dailyDate,
            dailyDate,
            leadGenerationMetrics,
          ),
        );

        // Ad analytics: ALL and DAILY granularity using campaign's startDate
        const leadGenAds = batch
          .flatMap((campaign) => campaign.ads)
          .filter((ad) => ad.id !== null)
          .map((ad) => `urn:li:sponsoredCreative:${ad.id}`);
        if (leadGenAds.length > 0) {
          // ALL granularity for ads
          await this.limiter.schedule(() =>
            this.linkedInAnalyticsService.fetchLinkedInAdAnalytics(
              leadGenAds,
              'ALL',
              startDate, // Same as campaign batch
              endDate,
              leadGenerationMetrics,
            ),
          );
          // DAILY granularity for ads
          await this.limiter.schedule(() =>
            this.linkedInAnalyticsService.fetchLinkedInAdAnalytics(
              leadGenAds,
              'DAILY',
              dailyDate,
              dailyDate,
              leadGenerationMetrics,
            ),
          );
        }
      }

      // Sync brand awareness campaign and ad analytics in batches
      const otherUrnBatches: {
        urn: string;
        start_date: Date | null;
        ads: { id: string }[];
      }[][] = [];
      for (let i = 0; i < otherCampaigns.length; i += 20) {
        otherUrnBatches.push(otherCampaigns.slice(i, i + 20));
      }
      for (const batch of otherUrnBatches) {
        const startDate = getEarliestStartDate(batch);
        // Campaign analytics: ALL granularity
        await this.limiter.schedule(() =>
          this.linkedInAnalyticsService.fetchLinkedInCampaignAnalytics(
            batch.map((c) => c.urn),
            'ALL',
            startDate,
            endDate,
            brandAwarenessMetrics,
          ),
        );
        // Campaign analytics: DAILY granularity
        const dailyDate = new Date(); // Current time for both start and end
        await this.limiter.schedule(() =>
          this.linkedInAnalyticsService.fetchLinkedInCampaignAnalytics(
            batch.map((c) => c.urn),
            'DAILY',
            dailyDate,
            dailyDate,
            brandAwarenessMetrics,
          ),
        );

        // Ad analytics: ALL and DAILY granularity using campaign's startDate
        const otherAds = batch
          .flatMap((campaign) => campaign.ads)
          .filter((ad) => ad.id !== null)
          .map((ad) => `urn:li:sponsoredCreative:${ad.id}`);
        if (otherAds.length > 0) {
          // ALL granularity for ads
          await this.limiter.schedule(() =>
            this.linkedInAnalyticsService.fetchLinkedInAdAnalytics(
              otherAds,
              'ALL',
              startDate, // Same as campaign batch
              endDate,
              brandAwarenessMetrics,
            ),
          );
          // DAILY granularity for ads
          await this.limiter.schedule(() =>
            this.linkedInAnalyticsService.fetchLinkedInAdAnalytics(
              otherAds,
              'DAILY',
              dailyDate,
              dailyDate,
              brandAwarenessMetrics,
            ),
          );
        }
      }
    }

    // Update lastSyncedAt
    await this.prisma.linkedInCampaignConfig.update({
      where: { orgId },
      data: { lastSyncedAt: new Date() },
    });
  }

  async fetchAndSyncLinkedInCampaignsByIds(
    campaignIds: string[],
    adAccountId: string,
  ): Promise<void> {
    this.logger.log(
      `Fetching LinkedIn campaigns by IDs: ${campaignIds.join(', ')} for ad account: ${adAccountId}`,
    );

    const accessToken = await this.linkedinService.getValidAccessToken();
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'LinkedIn-Version': '202505',
      'X-RestLi-Protocol-Version': '2.0.0',
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    try {
      // Fetch existing campaigns from database to compare version_tag
      const existingCampaigns = await this.prisma.marketingCampaign.findMany({
        where: {
          external_id: { in: campaignIds },
          ad_account_id: adAccountId,
        },
        select: {
          external_id: true,
          version_tag: true,
        },
      });

      const versionMap = new Map(
        existingCampaigns.map((c) => [c.external_id, c.version_tag]),
      );

      // Construct batch request URL
      const idsList = `List(${campaignIds.join(',')})`; // Join IDs without encoding
      const params = { ids: idsList };

      const response = await axios.get<{
        results: { [key: string]: any };
        errors: { [key: string]: any };
      }>(
        `https://api.linkedin.com/rest/adAccounts/${adAccountId}/adCampaigns`,
        {
          headers,
          params,
        },
      );

      const fetchedCampaigns = Object.values(response.data.results || {}).map(
        (campaign) => ({
          ...campaign,
          adAccountId,
        }),
      );

      this.logger.log(
        `Fetched ${fetchedCampaigns.length} campaigns for ad account ${adAccountId}`,
      );

      const campaignsToSync = fetchedCampaigns.filter((campaign) => {
        const dbVersion = versionMap.get(campaign.id.toString());
        const apiVersion = campaign.version?.versionTag || null;
        const needsUpdate = !dbVersion || dbVersion !== apiVersion;
        if (needsUpdate) {
          this.logger.debug(
            `Campaign ${campaign.id} needs sync: DB version=${dbVersion}, API version=${apiVersion}`,
          );
        }
        return needsUpdate;
      });

      if (campaignsToSync.length === 0) {
        this.logger.log('No campaigns need syncing');
        return;
      }

      // Save filtered campaigns using existing method
      await this.campaignsService.saveLinkedInCampaigns(campaignsToSync);
      this.logger.log(
        `Synced ${campaignsToSync.length} campaigns with updated versions`,
      );

      // Optionally trigger ad sync
      this.logger.log('Initiating ad sync for updated campaigns');
      await this.linkedInAdsService.syncCampaignAds();
    } catch (error: any) {
      if (error.response) {
        this.logger.error(
          `LinkedIn API Error: ${error.response.status} - ${JSON.stringify(error.response.data)}`,
          {
            request: {
              url: error.config?.url,
              method: error.config?.method,
              params: error.config?.params,
              headers: error.config?.headers,
            },
          },
        );
        if (error.response.status === 401) {
          throw new UnauthorizedException('Invalid or expired access token');
        }
        if (error.response.status === 403) {
          throw new ForbiddenException(
            'Missing required scopes (r_ads, r_ads_reporting)',
          );
        }
        if (error.response.status === 429) {
          throw new Error('Rate limit exceeded');
        }
      }
      this.logger.error(`Failed to fetch campaigns by IDs: ${error.message}`);
      throw new Error('Failed to fetch and sync LinkedIn campaigns');
    }
  }

  async createOrUpdateLinkedInCampaignConfig(
    orgId: string,
    config: {
      syncInterval: string;
      autoSyncEnabled: boolean;
      adAccountIds: string[];
      campaignGroupIds: string[];
    },
  ) {
    this.logger.log(
      `Creating or updating LinkedInCampaignConfig for org: ${orgId}`,
    );

    // Validate inputs
    const validSyncIntervals = [
      'EVERY_20_SECONDS',
      'EVERY_30_MINUTES',
      'EVERY_HOUR',
      'EVERY_2_HOURS',
      'EVERY_3_HOURS',
    ];
    if (!validSyncIntervals.includes(config.syncInterval)) {
      this.logger.error(`Invalid syncInterval: ${config.syncInterval}`);
      throw new Error(
        `syncInterval must be one of: ${validSyncIntervals.join(', ')}`,
      );
    }

    // Validate org exists
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
    });
    if (!org) {
      this.logger.error(`Organization not found for id: ${orgId}`);
      throw new Error('Organization not found');
    }

    // Validate LinkedIn platform exists
    const platform = await this.prisma.marketingPlatform.findFirst({
      where: { orgId, platform_name: 'LinkedIn' },
    });
    if (!platform) {
      this.logger.error('LinkedIn platform not found for organization');
      throw new Error('LinkedIn platform not configured');
    }
    this.logger.log('ad accounts ids', config.adAccountIds);
    this.logger.log('campaign group ids', config.campaignGroupIds);
    // Validate adAccountIds
    if (config.adAccountIds.length > 0) {
      const adAccounts = await this.prisma.adAccount.findMany({
        where: {
          id: { in: config.adAccountIds },
          organizationId: orgId,
        },
        select: { id: true },
      });
      if (adAccounts.length !== config.adAccountIds.length) {
        this.logger.error(
          'One or more adAccountIds are invalid or do not belong to the organization',
        );
        throw new Error('Invalid ad account IDs');
      }
    }

    // Validate campaignGroupIds
    if (config.campaignGroupIds.length > 0) {
      const campaignGroups = await this.prisma.campaignGroup.findMany({
        where: {
          id: { in: config.campaignGroupIds },
          adAccount: { organizationId: orgId },
        },
        select: { id: true },
      });
      if (campaignGroups.length !== config.campaignGroupIds.length) {
        this.logger.error(
          'One or more campaignGroupIds are invalid or do not belong to the organization',
        );
        throw new Error('Invalid campaign group IDs');
      }
    }

    // Upsert LinkedInCampaignConfig
    try {
      const configRecord = await this.prisma.linkedInCampaignConfig.upsert({
        where: { orgId },
        update: {
          syncInterval: config.syncInterval,
          autoSyncEnabled: config.autoSyncEnabled,
          adAccounts: {
            set: config.adAccountIds.map((id) => ({ id })),
          },
          campaignGroups: {
            set: config.campaignGroupIds.map((id) => ({ id })),
          },
          updatedAt: new Date(),
        },
        create: {
          orgId,
          syncInterval: config.syncInterval,
          autoSyncEnabled: config.autoSyncEnabled,
          adAccounts: {
            connect: config.adAccountIds.map((id) => ({ id })),
          },
          campaignGroups: {
            connect: config.campaignGroupIds.map((id) => ({ id })),
          },
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        include: {
          adAccounts: {
            select: {
              id: true,
              accountUrn: true,
              role: true,
            },
          },
          campaignGroups: {
            select: {
              id: true,
              name: true,
              urn: true,
            },
          },
        },
      });

      this.logger.log(
        `Successfully saved LinkedInCampaignConfig for org: ${orgId}`,
      );

      await this.startDynamicSync();
      return {
        id: configRecord.id,
        orgId: configRecord.orgId,
        syncInterval: configRecord.syncInterval,
        autoSyncEnabled: configRecord.autoSyncEnabled,
        lastSyncedAt: configRecord.lastSyncedAt,
        createdAt: configRecord.createdAt,
        updatedAt: configRecord.updatedAt,
        adAccounts: configRecord.adAccounts,
        campaignGroups: configRecord.campaignGroups,
      };
    } catch (error: any) {
      this.logger.error(
        `Failed to save LinkedInCampaignConfig: ${error.message}`,
      );
      throw new Error('Failed to save LinkedIn campaign configuration');
    }
  }
}
