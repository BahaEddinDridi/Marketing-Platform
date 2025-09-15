import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
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
import Groq from 'groq-sdk';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

interface PerformanceReport {
  campaignId: string;
  campaignName: string;
  performanceSummary: {
    overview: string;
    keyMetrics: {
      impressions: number | null;
      clicks: number | null;
      costInLocalCurrency: number | null;
      qualifiedLeads?: number | null;
      costPerQualifiedLead?: number | null;
      externalWebsiteConversions?: number | null;
      landingPageClicks?: number | null;
      videoViews?: number | null;
      videoCompletions?: number | null;
      reactions?: number | null;
      shares?: number | null;
      comments?: number | null;
      follows?: number | null;
      averageDwellTime?: number | null;
      cardClicks?: number | null;
    };
    trends: {
      dailyPerformance: Array<{
        date: string;
        impressions: number | null;
        clicks: number | null;
        costInLocalCurrency: number | null;
        qualifiedLeads?: number | null;
        costPerQualifiedLead?: number | null;
        externalWebsiteConversions?: number | null;
        landingPageClicks?: number | null;
        videoViews?: number | null;
        videoCompletions?: number | null;
        reactions?: number | null;
        shares?: number | null;
        comments?: number | null;
        follows?: number | null;
        averageDwellTime?: number | null;
        cardClicks?: number | null;
      }>;
    };
  };
  recommendedActions: Array<{
    action: string;
    priority: 'High' | 'Medium' | 'Low';
    rationale: string;
  }>;
}

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
  private readonly groqClient: Groq;
  constructor(
    private prisma: PrismaService,
    private readonly linkedinService: LinkedInService,
    private readonly configService: ConfigService,
    private readonly linkedInAdsService: LinkedInAdsService,
    private readonly campaignsService: CampaignsService,
    private readonly linkedInAnalyticsService: LinkedInAnalyticsService,
    private readonly notificationService: NotificationsService,
  ) {
    const groqApiKey = this.configService.get<string>('GROQ_API_KEY');
    if (!groqApiKey) {
      this.logger.error('Groq API key not found in environment variables');
      throw new InternalServerErrorException('Groq API key not configured');
    }
    this.groqClient = new Groq({ apiKey: groqApiKey });
    this.logger.log('Groq client initialized successfully');
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
            type: 'success: linkedin sync',
            actionUrl: 'http://localhost:3000/campaigns',
            meta: { orgId, url: 'http://localhost:3000/campaigns' },
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

    this.logger.log('🔄 Checking if campaign relations need restoration...');
  const campaignsNeedingFix = await this.prisma.marketingCampaign.count({
    where: { OR: [{ ad_account_id: null }, { campaign_group_id: null }] },
  });
  
  if (campaignsNeedingFix > 0) {
    this.logger.log(`Found ${campaignsNeedingFix} campaigns with broken relations. Running restoration...`);
    const restorationResult = await this.restoreCampaignRelations();
    this.logger.log(`🔧 Restoration completed:`, restorationResult);
    
    if (!restorationResult.success) {
      this.logger.error('❌ Restoration failed, but continuing with sync...');
    } else {
      this.logger.log(`✅ Successfully restored ${restorationResult.data.campaignsUpdated} campaigns`);
    }
  } else {
    this.logger.log('✅ All campaigns have proper relations, skipping restoration');
  }
  
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

    this.logger.log(`Found ${config.campaignGroups.length} campaign groups`);

    for (const group of config.campaignGroups) {
      const adAccount = config.adAccounts.find(
        (acc) => group.adAccountId === acc.id,
      );

      this.logger.log(`Campaign Group ${group.id}:`, {
        name: group.name,
        adAccountId: group.adAccountId,
        hasAdAccount: !!adAccount,
        totalCampaigns: group.campaigns?.length || 0,
      });

      if (group.campaigns?.length > 0) {
        group.campaigns.forEach((campaign, index) => {
          this.logger.log(`  Campaign ${index + 1}:`, {
            external_id: campaign.external_id,
            status: campaign.status,
            objective: campaign.objective,
            start_date: campaign.start_date,
          });
        });

        const validCampaigns = group.campaigns.filter((campaign) =>
          ['ACTIVE', 'PAUSED', 'DRAFT', 'COMPLETED'].includes(campaign.status),
        );

        this.logger.log(
          `  Campaigns after status filter: ${validCampaigns.length}`,
        );

        const fullyValidCampaigns = validCampaigns.filter(
          (campaign) =>
            campaign.external_id !== null && campaign.objective !== null,
        );

        this.logger.log(
          `  Campaigns after null filter: ${fullyValidCampaigns.length}`,
        );
      }

      if (!adAccount) {
        this.logger.warn(`No ad account found for campaign group ${group.id}`);
        continue; // This line is causing the issue
      }
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
        .filter((campaign) => {
          this.logger.log(
            `Campaign ${campaign.external_id} has status: ${campaign.status}`,
          );
          return campaign.status !== null; // Accept any non-null status temporarily
        })
        .filter((campaign) => {
          const hasExternalId = campaign.external_id !== null;
          const hasObjective = campaign.objective !== null;
          this.logger.log(
            `Campaign ${campaign.external_id}: hasExternalId=${hasExternalId}, hasObjective=${hasObjective}`,
          );
          return hasExternalId && hasObjective;
        });

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

    const campaignsToFix = await this.prisma.marketingCampaign.count({
      where: { OR: [{ ad_account_id: null }, { campaign_group_id: null }] },
    });
    if (campaignsToFix > 0) {
      const result = await this.restoreCampaignRelations();
      this.logger.log(`Restoration result: ${JSON.stringify(result)}`);
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

    if (!adAccountId) {
      this.logger.error('adAccountId is missing or invalid');
      throw new Error('Invalid adAccountId provided');
    }

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
      const idsList = `List(${campaignIds.join(',')})`;
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

      const fetchedCampaigns = Object.values(response.data.results || {})
        .map((campaign) => ({
          ...campaign,
          adAccountId,
        }))
        .filter((campaign) => {
          if (!campaign.id) {
            this.logger.warn(
              `Skipping campaign with missing ID: ${JSON.stringify(campaign)}`,
            );
            return false;
          }
          return true;
        });

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

      // Save filtered campaigns
      await this.campaignsService.saveLinkedInCampaigns(campaignsToSync);
      this.logger.log(
        `Synced ${campaignsToSync.length} campaigns with updated versions`,
      );

      // Trigger ad sync
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

  async generateCampaignPerformanceReport(
    campaignId: string,
  ): Promise<PerformanceReport> {
    this.logger.log(`Generating performance report for campaign ${campaignId}`);

    // Fetch campaign details
    const campaign = await this.prisma.marketingCampaign.findUnique({
      where: { campaign_id: campaignId },
      select: {
        campaign_id: true,
        campaign_name: true,
        objective: true,
        start_date: true,
        status: true,
      },
    });

    if (!campaign) {
      this.logger.error(`Campaign with ID ${campaignId} not found`);
      throw new NotFoundException(`Campaign with ID ${campaignId} not found`);
    }

    // Fetch analytics data
    const { allAnalytics, dailyAnalytics } =
      await this.linkedInAnalyticsService.getCampaignAnalyticsByCampaignId(
        campaignId,
      );
    // Determine metrics based on campaign objective
    const isLeadGen = campaign.objective === 'LEAD_GENERATION';
    const metrics = isLeadGen
      ? [
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
        ]
      : [
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
        ];

    // Extract latest ALL granularity analytics
    const latestAllAnalytics = allAnalytics.sort(
      (a, b) => b.dateFetched.getTime() - a.dateFetched.getTime(),
    )[0];
    // Format daily analytics
    const dailyPerformance = dailyAnalytics.map((analytics) => ({
      date: analytics.datePeriodStart.toISOString().split('T')[0],
      impressions: analytics.impressions ?? null,
      clicks: analytics.clicks ?? null,
      costInLocalCurrency: analytics.costInLocalCurrency ?? null,
      ...(isLeadGen
        ? {
            qualifiedLeads: analytics.qualifiedLeads ?? null,
            costPerQualifiedLead: analytics.costPerQualifiedLead ?? null,
            externalWebsiteConversions:
              analytics.externalWebsiteConversions ?? null,
            landingPageClicks: analytics.landingPageClicks ?? null,
            reactions: analytics.reactions ?? null,
            shares: analytics.shares ?? null,
            follows: analytics.follows ?? null,
          }
        : {
            videoViews: analytics.videoViews ?? null,
            videoCompletions: analytics.videoCompletions ?? null,
            reactions: analytics.reactions ?? null,
            shares: analytics.shares ?? null,
            comments: analytics.comments ?? null,
            follows: analytics.follows ?? null,
            averageDwellTime: analytics.averageDwellTime ?? null,
            cardClicks: analytics.cardClicks ?? null,
          }),
    }));

    // Construct prompt
    const prompt = this.buildPerformanceReportPrompt(
      campaign,
      latestAllAnalytics,
      dailyPerformance,
      metrics,
    );

    try {
      const response = await this.groqClient.chat.completions.create({
        model: 'llama-3.1-8b-instant',
        messages: [
          {
            role: 'system',
            content:
              'You are an expert marketing analyst. Generate a detailed performance report in JSON format based on the provided campaign data and analytics. Follow the instructions exactly, producing only the JSON object with no additional text, introductions, or explanations.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        max_tokens: 2000,
        temperature: 0.7,
        top_p: 0.9,
      });

      this.logger.log(
        'Raw Groq response for performance report:',
        JSON.stringify(response, null, 2),
      );

      const content = response.choices[0]?.message?.content?.trim();
      if (!content) {
        this.logger.error('No content in Groq response');
        throw new InternalServerErrorException(
          'Failed to generate performance report',
        );
      }

      let report;
      try {
        report = JSON.parse(content);
      } catch (error) {
        this.logger.error(`Failed to parse Groq response as JSON: ${content}`);
        throw new InternalServerErrorException(
          'Invalid response format from AI',
        );
      }

      // Validate report structure
      if (!report.performanceSummary || !report.recommendedActions) {
        this.logger.error('Invalid report structure from AI');
        throw new InternalServerErrorException(
          'Generated report is incomplete',
        );
      }

      const defaultKeyMetrics = {
        impressions: null,
        clicks: null,
        costInLocalCurrency: null,
        ...(isLeadGen
          ? {
              qualifiedLeads: null,
              costPerQualifiedLead: null,
              externalWebsiteConversions: null,
              landingPageClicks: null,
              reactions: null,
              shares: null,
              follows: null,
            }
          : {
              videoViews: null,
              videoCompletions: null,
              reactions: null,
              shares: null,
              comments: null,
              follows: null,
              averageDwellTime: null,
              cardClicks: null,
            }),
      };

      return {
        campaignId: campaign.campaign_id,
        campaignName: campaign.campaign_name ?? 'Unnamed Campaign',
        performanceSummary: {
          overview: report.performanceSummary.overview,
          keyMetrics: latestAllAnalytics
            ? {
                impressions: latestAllAnalytics.impressions ?? null,
                clicks: latestAllAnalytics.clicks ?? null,
                costInLocalCurrency:
                  latestAllAnalytics.costInLocalCurrency ?? null,
                ...(isLeadGen
                  ? {
                      qualifiedLeads: latestAllAnalytics.qualifiedLeads ?? null,
                      costPerQualifiedLead:
                        latestAllAnalytics.costPerQualifiedLead ?? null,
                      externalWebsiteConversions:
                        latestAllAnalytics.externalWebsiteConversions ?? null,
                      landingPageClicks:
                        latestAllAnalytics.landingPageClicks ?? null,
                      reactions: latestAllAnalytics.reactions ?? null,
                      shares: latestAllAnalytics.shares ?? null,
                      follows: latestAllAnalytics.follows ?? null,
                    }
                  : {
                      videoViews: latestAllAnalytics.videoViews ?? null,
                      videoCompletions:
                        latestAllAnalytics.videoCompletions ?? null,
                      reactions: latestAllAnalytics.reactions ?? null,
                      shares: latestAllAnalytics.shares ?? null,
                      comments: latestAllAnalytics.comments ?? null,
                      follows: latestAllAnalytics.follows ?? null,
                      averageDwellTime:
                        latestAllAnalytics.averageDwellTime ?? null,
                      cardClicks: latestAllAnalytics.cardClicks ?? null,
                    }),
              }
            : defaultKeyMetrics,
          trends: { dailyPerformance },
        },
        recommendedActions: report.recommendedActions,
      };
    } catch (error: any) {
      this.logger.error(
        `Failed to generate performance report: ${error.message}`,
        {
          stack: error.stack,
        },
      );
      if (error.response?.status === 401) {
        throw new UnauthorizedException('Invalid Groq API key');
      }
      if (error.response?.status === 429) {
        throw new InternalServerErrorException('Groq rate limit exceeded');
      }
      throw new InternalServerErrorException(
        'Failed to generate performance report',
      );
    }
  }

  private buildPerformanceReportPrompt(
    campaign: {
      campaign_id: string;
      campaign_name: string | null;
      objective: string | null;
      start_date: Date | null;
      status: string;
    },
    allAnalytics: any,
    dailyPerformance: Array<{
      date: string;
      [key: string]: number | null | string;
    }>,
    metrics: string[],
  ): string {
    const campaignName = campaign.campaign_name ?? 'Unnamed Campaign';
    const objective = campaign.objective ?? 'Unknown';
    const startDate =
      campaign.start_date?.toISOString().split('T')[0] ?? 'Unknown';
    const status = campaign.status ?? 'Unknown';
    const isLeadGen = objective === 'LEAD_GENERATION';

    const keyMetricsText = allAnalytics
      ? metrics
          .map((metric) => {
            const value = allAnalytics[metric] ?? 'N/A';
            return `${metric}: ${value}`;
          })
          .join('\n')
      : 'No aggregate analytics available.';

    const dailyPerformanceText =
      dailyPerformance.length > 0
        ? dailyPerformance
            .map((day) =>
              Object.entries(day)
                .map(([key, value]) => `${key}: ${value ?? 'N/A'}`)
                .join(', '),
            )
            .join('\n')
        : 'No daily performance data available.';

    return `You are an expert marketing analyst tasked with generating a detailed performance report for a LinkedIn advertising campaign. The report must be returned as a JSON object with the following structure:
{
  "performanceSummary": {
    "overview": "A detailed summary of the campaign's performance, including key achievements and areas for improvement (150-200 words).",
    "keyMetrics": {}, // Will be populated by the service
    "trends": {} // Will be populated by the service
  },
  "recommendedActions": [
    {
      "action": "Specific action to improve campaign performance",
      "priority": "High | Medium | Low",
      "rationale": "Explanation of why this action is recommended (50-100 words)"
    }
    // At least 3 recommended actions
  ]
}

**Campaign Details:**
- Campaign ID: ${campaign.campaign_id}
- Name: ${campaignName}
- Objective: ${objective}
- Start Date: ${startDate}
- Status: ${status}

**Key Metrics (Aggregate):**
${keyMetricsText}

**Daily Performance Trends:**
${dailyPerformanceText}

**Instructions:**
- Analyze the provided campaign details, key metrics, and daily performance trends.
- Generate a JSON object with:
  - A "performanceSummary" object containing:
    - An "overview" string summarizing the campaign's performance, highlighting key achievements and areas for improvement (150-200 words).
    - (The "keyMetrics" and "trends" fields will be populated by the service, so include an empty object for them.)
  - A "recommendedActions" array with at least 3 specific, actionable recommendations to improve campaign performance, each with:
    - An "action" string describing the recommendation.
    - A "priority" string ("High", "Medium", or "Low").
    - A "rationale" string explaining why the action is recommended (50-100 words).
- Ensure recommendations are tailored to the campaign's objective (${isLeadGen ? 'Lead Generation' : 'Brand Awareness'}).
- Return only the JSON object, with no additional text, introductions, or explanations.
- Ensure all text fields are professional, concise, and relevant to LinkedIn advertising.`;
  }

  async createPdfReport(campaignId: string): Promise<Buffer> {
    // Generate the performance report
    const report = await this.generateCampaignPerformanceReport(campaignId);

    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const fontSize = 12;
    const headingSize = 16;
    const subHeadingSize = 14;
    const coverTitleSize = 24;
    const coverSubtitleSize = 18;

    // Define colors
    const primaryColor = rgb(0, 0.2, 0.4); // Dark blue for headers and chart bars
    const textColor = rgb(0, 0, 0); // Black for text
    const borderColor = rgb(0.6, 0.6, 0.6); // Gray for table borders
    const chartAxisColor = rgb(0.3, 0.3, 0.3); // Dark gray for chart axes

    // Initialize page and dimensions
    let page = pdfDoc.addPage([600, 800]);
    let width = page.getSize().width;
    let height = page.getSize().height;
    let y = height - 200;

    // Helper function to split text into lines
    const splitTextIntoLines = (
      text: string,
      font: any,
      size: number,
      maxWidth: number,
    ): string[] => {
      const words = text.split(' ');
      const lines: string[] = [];
      let currentLine = '';
      for (const word of words) {
        const testLine = currentLine ? `${currentLine} ${word}` : word;
        if (font.widthOfTextAtSize(testLine, size) <= maxWidth) {
          currentLine = testLine;
        } else {
          if (currentLine) lines.push(currentLine);
          currentLine = word;
        }
      }
      if (currentLine) lines.push(currentLine);
      return lines;
    };

    // Helper function to add text and update y position
    const addText = (
      text: string,
      options: {
        size: number;
        bold?: boolean;
        maxWidth?: number;
        lineHeight?: number;
        x?: number;
        y: number;
        color?: any;
      },
    ) => {
      const {
        size,
        bold = false,
        maxWidth = width - 100,
        lineHeight = size * 1.2,
        x = 50,
        y: textY,
        color = textColor,
      } = options;
      const textFont = bold ? boldFont : font;
      const lines = text.split('\n');
      let currentY = textY;
      for (const line of lines) {
        const wrappedLines =
          textFont.widthOfTextAtSize(line, size) > maxWidth
            ? splitTextIntoLines(line, textFont, size, maxWidth)
            : [line];
        for (const wrappedLine of wrappedLines) {
          if (currentY < 50) {
            page = pdfDoc.addPage([600, 800]);
            return { currentY: page.getSize().height - 50, newPage: true };
          }
          page.drawText(wrappedLine, {
            x,
            y: currentY,
            font: textFont,
            size,
            color,
          });
          currentY -= lineHeight;
        }
      }
      currentY -= 10; // Extra spacing after paragraph
      return { currentY, newPage: false };
    };

    // Helper function to draw a table
    const drawTable = (
      headers: string[],
      rows: string[][],
      options: {
        x: number;
        y: number;
        columnWidths: number[];
        rowHeight: number;
        fontSize: number;
        boldHeader?: boolean;
      },
    ) => {
      const {
        x,
        y: startY,
        columnWidths,
        rowHeight,
        fontSize,
        boldHeader = true,
      } = options;
      let currentY = startY;

      // Check if there's enough space for the table
      if (currentY - rowHeight * (rows.length + 1) < 50) {
        page = pdfDoc.addPage([600, 800]);
        return { currentY: page.getSize().height - 50, newPage: true };
      }

      // Draw header
      headers.forEach((header, colIndex) => {
        const cellX =
          x + columnWidths.slice(0, colIndex).reduce((sum, w) => sum + w, 0);
        const wrappedLines = splitTextIntoLines(
          header,
          boldHeader ? boldFont : font,
          fontSize,
          columnWidths[colIndex] - 10,
        );
        page.drawRectangle({
          x: cellX,
          y: currentY - rowHeight,
          width: columnWidths[colIndex],
          height: rowHeight,
          borderWidth: 1,
          borderColor,
          color: primaryColor,
        });
        page.drawText(wrappedLines[0] || header, {
          x: cellX + 5,
          y: currentY - fontSize - 5,
          font: boldHeader ? boldFont : font,
          size: fontSize,
          color: rgb(1, 1, 1),
        });
      });
      currentY -= rowHeight;

      // Draw rows
      for (const row of rows) {
        if (currentY - rowHeight < 50) {
          page = pdfDoc.addPage([600, 800]);
          // Redraw headers
          headers.forEach((header, colIndex) => {
            const cellX =
              x +
              columnWidths.slice(0, colIndex).reduce((sum, w) => sum + w, 0);
            const wrappedLines = splitTextIntoLines(
              header,
              boldHeader ? boldFont : font,
              fontSize,
              columnWidths[colIndex] - 10,
            );
            page.drawRectangle({
              x: cellX,
              y: currentY - rowHeight,
              width: columnWidths[colIndex],
              height: rowHeight,
              borderWidth: 1,
              borderColor,
              color: primaryColor,
            });
            page.drawText(wrappedLines[0] || header, {
              x: cellX + 5,
              y: currentY - fontSize - 5,
              font: boldHeader ? boldFont : font,
              size: fontSize,
              color: rgb(1, 1, 1),
            });
          });
          currentY -= rowHeight;
        }

        row.forEach((cell, colIndex) => {
          const cellX =
            x + columnWidths.slice(0, colIndex).reduce((sum, w) => sum + w, 0);
          const wrappedLines = splitTextIntoLines(
            cell,
            font,
            fontSize,
            columnWidths[colIndex] - 10,
          );
          page.drawRectangle({
            x: cellX,
            y: currentY - rowHeight,
            width: columnWidths[colIndex],
            height: rowHeight,
            borderWidth: 1,
            borderColor,
          });
          page.drawText(wrappedLines[0] || cell, {
            x: cellX + 5,
            y: currentY - fontSize - 5,
            font,
            size: fontSize,
            color: textColor,
          });
        });
        currentY -= rowHeight;
      }

      return { currentY, newPage: false };
    };

    // Helper function to draw a bar chart
    const drawBarChart = (
      data: { date: string; value: number | null }[],
      options: {
        x: number;
        y: number;
        width: number;
        height: number;
        fontSize: number;
        title: string;
      },
    ) => {
      const {
        x,
        y: startY,
        width: chartWidth,
        height: chartHeight,
        fontSize,
        title,
      } = options;
      let currentY = startY;

      // Add chart title
      const titleResult = addText(title, {
        size: subHeadingSize,
        bold: true,
        x,
        y: currentY,
        color: primaryColor,
      });
      currentY = titleResult.currentY;
      if (titleResult.newPage) {
        width = page.getSize().width;
        height = page.getSize().height;
      }

      // Filter out null values and limit to 5 entries
      const validData = data.filter((d) => d.value !== null).slice(0, 5) as {
        date: string;
        value: number;
      }[];
      if (validData.length === 0) {
        const noDataResult = addText('No data available for chart', {
          size: fontSize,
          x,
          y: currentY,
          color: textColor,
        });
        currentY = noDataResult.currentY;
        if (noDataResult.newPage) {
          width = page.getSize().width;
          height = page.getSize().height;
        }
        return currentY;
      }

      // Calculate max value for scaling
      const maxValue = Math.max(...validData.map((d) => d.value));
      const barWidth = chartWidth / validData.length / 1.5;
      const barSpacing = chartWidth / validData.length / 5;
      const maxBarHeight = chartHeight - 40; // Leave space for labels

      // Check if there's enough space
      if (currentY - (chartHeight + 20) < 50) {
        page = pdfDoc.addPage([600, 800]);
        currentY = page.getSize().height - 50;
        const titleResult = addText(title, {
          size: subHeadingSize,
          bold: true,
          x,
          y: currentY,
          color: primaryColor,
        });
        currentY = titleResult.currentY;
        if (titleResult.newPage) {
          width = page.getSize().width;
          height = page.getSize().height;
        }
      }

      // Draw axes
      page.drawLine({
        start: { x, y: currentY - 20 },
        end: { x, y: currentY - maxBarHeight - 20 },
        thickness: 1,
        color: chartAxisColor,
      }); // Y-axis
      page.drawLine({
        start: { x, y: currentY - 20 },
        end: { x: x + chartWidth, y: currentY - 20 },
        thickness: 1,
        color: chartAxisColor,
      }); // X-axis

      // Draw bars and labels
      validData.forEach((item, index) => {
        const barX = x + index * (barWidth + barSpacing);
        const barHeight = (item.value / maxValue) * maxBarHeight;
        page.drawRectangle({
          x: barX,
          y: currentY - 20 - barHeight,
          width: barWidth,
          height: barHeight,
          color: primaryColor,
        });
        // X-axis label (date)
        const shortDate = item.date.split('-').slice(1).join('-'); // e.g., "07-01"
        page.drawText(shortDate, {
          x: barX + barWidth / 2 - fontSize,
          y: currentY - 15 - fontSize,
          font,
          size: fontSize - 2,
          color: textColor,
        });
      });

      // Y-axis labels (simplified: max value and half)
      page.drawText(`${Math.round(maxValue)}`, {
        x: x - 40,
        y: currentY - 20 - maxBarHeight - fontSize / 2,
        font,
        size: fontSize - 2,
        color: textColor,
      });
      page.drawText(`${Math.round(maxValue / 2)}`, {
        x: x - 40,
        y: currentY - 20 - maxBarHeight / 2 - fontSize / 2,
        font,
        size: fontSize - 2,
        color: textColor,
      });

      currentY -= chartHeight + 20;
      return currentY;
    };

    // Add Cover Page
    let result = addText('Campaign Performance Report', {
      size: coverTitleSize,
      bold: true,
      maxWidth: width - 100,
      lineHeight: coverTitleSize * 1.2,
      x: 50,
      y,
      color: primaryColor,
    });
    y = result.currentY;
    if (result.newPage) {
      width = page.getSize().width;
      height = page.getSize().height;
    }

    result = addText(`Campaign: ${report.campaignName}`, {
      size: coverSubtitleSize,
      bold: true,
      maxWidth: width - 100,
      lineHeight: coverSubtitleSize * 1.2,
      x: 50,
      y,
      color: textColor,
    });
    y = result.currentY;
    if (result.newPage) {
      width = page.getSize().width;
      height = page.getSize().height;
    }

    result = addText(
      `Generated on: ${new Date().toISOString().split('T')[0]}`,
      {
        size: fontSize,
        maxWidth: width - 100,
        lineHeight: fontSize * 1.2,
        x: 50,
        y,
        color: textColor,
      },
    );
    y = result.currentY;
    if (result.newPage) {
      width = page.getSize().width;
      height = page.getSize().height;
    }

    // Start content on a new page
    page = pdfDoc.addPage([600, 800]);
    width = page.getSize().width;
    height = page.getSize().height;
    y = height - 50;

    // Add Campaign Details
    result = addText('Campaign Details', {
      size: subHeadingSize,
      bold: true,
      y,
      color: primaryColor,
    });
    y = result.currentY;
    if (result.newPage) {
      width = page.getSize().width;
      height = page.getSize().height;
    }

    result = addText(`Campaign ID: ${report.campaignId}`, {
      size: fontSize,
      y,
    });
    y = result.currentY;
    if (result.newPage) {
      width = page.getSize().width;
      height = page.getSize().height;
    }

    result = addText(`Campaign Name: ${report.campaignName}`, {
      size: fontSize,
      y,
    });
    y = result.currentY;
    if (result.newPage) {
      width = page.getSize().width;
      height = page.getSize().height;
    }
    y -= 20;

    // Add Performance Summary
    result = addText('Performance Summary', {
      size: subHeadingSize,
      bold: true,
      y,
      color: primaryColor,
    });
    y = result.currentY;
    if (result.newPage) {
      width = page.getSize().width;
      height = page.getSize().height;
    }

    result = addText(report.performanceSummary.overview, {
      size: fontSize,
      maxWidth: 500,
      lineHeight: 14,
      y,
    });
    y = result.currentY;
    if (result.newPage) {
      width = page.getSize().width;
      height = page.getSize().height;
    }
    y -= 20;

    // Add Key Metrics Table
    result = addText('Key Metrics', {
      size: subHeadingSize,
      bold: true,
      y,
      color: primaryColor,
    });
    y = result.currentY;
    if (result.newPage) {
      width = page.getSize().width;
      height = page.getSize().height;
    }

    const metricsHeaders = ['Metric', 'Value'];
    const metricsRows = Object.entries(
      report.performanceSummary.keyMetrics,
    ).map(([metric, value]) => {
      const formattedMetric = metric
        .replace(/([A-Z])/g, ' $1')
        .replace(/^./, (str) => str.toUpperCase());
      return [formattedMetric, value?.toString() ?? 'N/A'];
    });
    const metricsTableResult = drawTable(metricsHeaders, metricsRows, {
      x: 50,
      y,
      columnWidths: [250, 200],
      rowHeight: 30,
      fontSize,
      boldHeader: true,
    });
    y = metricsTableResult.currentY;
    if (metricsTableResult.newPage) {
      width = page.getSize().width;
      height = page.getSize().height;
    }
    y -= 20;

    // Add Daily Performance Trends (Chart and Table)
    if (report.performanceSummary.trends.dailyPerformance.length > 0) {
      // Bar Chart for Impressions
      y = drawBarChart(
        report.performanceSummary.trends.dailyPerformance
          .slice(0, 5)
          .map((day) => ({
            date: day.date,
            value: day.impressions ?? 0,
          })),
        {
          x: 50,
          y,
          width: 450,
          height: 200,
          fontSize,
          title: 'Daily Impressions Trend',
        },
      );

      // Table
      result = addText('Daily Performance Trends', {
        size: subHeadingSize,
        bold: true,
        y,
        color: primaryColor,
      });
      y = result.currentY;
      if (result.newPage) {
        width = page.getSize().width;
        height = page.getSize().height;
      }

      const trendsHeaders = ['Date', 'Impressions', 'Clicks', 'Cost'];
      const dailyData = report.performanceSummary.trends.dailyPerformance.slice(
        0,
        5,
      );
      const trendsRows = dailyData.map((day) => [
        day.date,
        day.impressions?.toString() ?? 'N/A',
        day.clicks?.toString() ?? 'N/A',
        day.costInLocalCurrency?.toString() ?? 'N/A',
      ]);
      const trendsTableResult = drawTable(trendsHeaders, trendsRows, {
        x: 50,
        y,
        columnWidths: [120, 110, 110, 110],
        rowHeight: 30,
        fontSize,
        boldHeader: true,
      });
      y = trendsTableResult.currentY;
      if (trendsTableResult.newPage) {
        width = page.getSize().width;
        height = page.getSize().height;
      }
      y -= 20;
    }

    // Add Recommended Actions
    result = addText('Recommended Actions', {
      size: subHeadingSize,
      bold: true,
      y,
      color: primaryColor,
    });
    y = result.currentY;
    if (result.newPage) {
      width = page.getSize().width;
      height = page.getSize().height;
    }

    for (const action of report.recommendedActions) {
      result = addText(`Action: ${action.action}`, {
        size: fontSize,
        bold: true,
        y,
      });
      y = result.currentY;
      if (result.newPage) {
        width = page.getSize().width;
        height = page.getSize().height;
      }

      result = addText(`Priority: ${action.priority}`, { size: fontSize, y });
      y = result.currentY;
      if (result.newPage) {
        width = page.getSize().width;
        height = page.getSize().height;
      }

      result = addText(`Rationale: ${action.rationale}`, {
        size: fontSize,
        maxWidth: 500,
        lineHeight: 14,
        y,
      });
      y = result.currentY;
      if (result.newPage) {
        width = page.getSize().width;
        height = page.getSize().height;
      }
    }

    return Buffer.from(await pdfDoc.save());
  }
  async restoreCampaignRelations(): Promise<{
  success: boolean;
  message: string;
  data: {
    totalCampaignsProcessed: number;
    campaignsUpdated: number;
    errors: string[];
    adAccountsProcessed: string[];
    campaignGroupsFound: number;
  };
}> {
  this.logger.log('Starting restoration of campaign ad_account_id and campaign_group_id');

  try {
    // Step 1: Get ALL ad accounts for the organization (ignore config)
    const allAdAccounts = await this.prisma.adAccount.findMany({
      where: { organizationId: 'single-org' },
      select: { id: true, accountUrn: true },
    });

    if (allAdAccounts.length === 0) {
      this.logger.error('No ad accounts found for organization single-org');
      return {
        success: false,
        message: 'No ad accounts found for organization',
        data: { 
          totalCampaignsProcessed: 0, 
          campaignsUpdated: 0, 
          errors: ['No ad accounts found'], 
          adAccountsProcessed: [],
          campaignGroupsFound: 0
        },
      };
    }

    const adAccountIds = allAdAccounts.map(acc => acc.id);
    this.logger.log(`Found ${adAccountIds.length} ad accounts: ${adAccountIds.join(', ')}`);

    // Step 2: Get ALL campaign groups to build URN-to-ID mapping
    const allCampaignGroups = await this.prisma.campaignGroup.findMany({
      where: { adAccount: { organizationId: 'single-org' } },
      select: { id: true, urn: true, name: true, adAccountId: true },
    });

    const campaignGroupMap = new Map(
      allCampaignGroups
        .filter(group => group.urn) // Only groups with URNs
        .map(group => [group.urn!.split(':').pop(), group.id])
    );
    
    // Also create ad account mapping for campaign groups
    const campaignGroupToAdAccountMap = new Map(
      allCampaignGroups.map(group => [group.id, group.adAccountId])
    );

    this.logger.log(`Found ${allCampaignGroups.length} campaign groups, ${campaignGroupMap.size} with valid URNs`);
    this.logger.log('Campaign group URN mapping:', Array.from(campaignGroupMap.entries()));

    // Step 3: Fetch ALL campaigns from LinkedIn API using all ad accounts
    this.logger.log('Fetching ALL campaigns from LinkedIn API...');
    const allLinkedInCampaigns: any[] = [];

    for (const adAccountId of adAccountIds) {
      try {
        this.logger.log(`Fetching campaigns for ad account: ${adAccountId}`);
        const campaigns = await this.campaignsService.fetchLinkedInCampaigns([adAccountId]);
        
        // Add adAccountId to each campaign for reference
        const campaignsWithAdAccount = campaigns.map(campaign => ({
          ...campaign,
          adAccountId // Ensure this is set
        }));
        
        allLinkedInCampaigns.push(...campaignsWithAdAccount);
        this.logger.log(`Fetched ${campaigns.length} campaigns from ad account ${adAccountId}`);
      } catch (error: any) {
        this.logger.error(`Failed to fetch campaigns from ad account ${adAccountId}: ${error.message}`);
        // Continue with other ad accounts
      }
    }

    this.logger.log(`Total campaigns fetched from LinkedIn API: ${allLinkedInCampaigns.length}`);

    if (allLinkedInCampaigns.length === 0) {
      return {
        success: false,
        message: 'No campaigns found in LinkedIn API',
        data: { 
          totalCampaignsProcessed: 0, 
          campaignsUpdated: 0, 
          errors: ['No campaigns found in LinkedIn API'], 
          adAccountsProcessed: adAccountIds,
          campaignGroupsFound: allCampaignGroups.length
        },
      };
    }

    // Step 4: Create mapping of external_id to LinkedIn campaign data
    const linkedInCampaignMap = new Map(
      allLinkedInCampaigns
        .filter(campaign => campaign.id) // Only campaigns with IDs
        .map(campaign => [
          campaign.id.toString(),
          {
            adAccountId: campaign.adAccountId,
            campaignGroupUrn: campaign.campaignGroup,
            campaignGroupId: campaign.campaignGroup 
              ? campaignGroupMap.get(campaign.campaignGroup.split(':').pop()) 
              : null,
            name: campaign.name || 'Unknown'
          }
        ])
    );

    this.logger.log(`Created mapping for ${linkedInCampaignMap.size} LinkedIn campaigns`);

    // Step 5: Get all campaigns from database that need fixing
    const campaignsToFix = await this.prisma.marketingCampaign.findMany({
      where: {
        OR: [
          { ad_account_id: null },
          { campaign_group_id: null }
        ]
      },
      select: {
        campaign_id: true,
        external_id: true,
        campaign_name: true,
        ad_account_id: true,
        campaign_group_id: true,
      },
    });

    this.logger.log(`Found ${campaignsToFix.length} campaigns in database that need fixing`);

    if (campaignsToFix.length === 0) {
      return {
        success: true,
        message: 'No campaigns need fixing',
        data: { 
          totalCampaignsProcessed: 0, 
          campaignsUpdated: 0, 
          errors: [], 
          adAccountsProcessed: adAccountIds,
          campaignGroupsFound: allCampaignGroups.length
        },
      };
    }

    // Step 6: Update campaigns with restored relationships
    let campaignsUpdated = 0;
    const errors: string[] = [];

    for (const dbCampaign of campaignsToFix) {
      if (!dbCampaign.external_id) {
        errors.push(`Campaign ${dbCampaign.campaign_id} has no external_id, cannot restore`);
        continue;
      }

      const linkedInData = linkedInCampaignMap.get(dbCampaign.external_id);
      if (!linkedInData) {
        errors.push(`No LinkedIn data found for campaign ${dbCampaign.campaign_id} (external_id: ${dbCampaign.external_id})`);
        continue;
      }

      const updateData: {
        ad_account_id?: string;
        campaign_group_id?: string;
      } = {};

      // Restore ad_account_id
      if (!dbCampaign.ad_account_id && linkedInData.adAccountId) {
        updateData.ad_account_id = linkedInData.adAccountId;
      }

      // Restore campaign_group_id
      if (!dbCampaign.campaign_group_id && linkedInData.campaignGroupId) {
        updateData.campaign_group_id = linkedInData.campaignGroupId;
      }

      if (Object.keys(updateData).length > 0) {
        try {
          await this.prisma.marketingCampaign.update({
            where: { campaign_id: dbCampaign.campaign_id },
            data: updateData,
          });

          campaignsUpdated++;
          this.logger.log(`✅ Restored campaign ${dbCampaign.campaign_id} (${dbCampaign.campaign_name}):`, {
            external_id: dbCampaign.external_id,
            restored: updateData,
            linkedInData: {
              adAccountId: linkedInData.adAccountId,
              campaignGroupUrn: linkedInData.campaignGroupUrn,
              campaignGroupId: linkedInData.campaignGroupId,
            }
          });
        } catch (updateError: any) {
          errors.push(`Failed to update campaign ${dbCampaign.campaign_id}: ${updateError.message}`);
          this.logger.error(`Failed to update campaign ${dbCampaign.campaign_id}:`, updateError);
        }
      } else {
        errors.push(`No valid update data for campaign ${dbCampaign.campaign_id} - LinkedIn data: ${JSON.stringify(linkedInData)}`);
      }
    }

    const success = errors.length === 0;
    const message = success 
      ? `Successfully restored relations for ${campaignsUpdated} campaigns`
      : `Restored ${campaignsUpdated} campaigns with ${errors.length} errors`;

    this.logger.log(`Restoration completed: ${message}`);

    return {
      success,
      message,
      data: {
        totalCampaignsProcessed: campaignsToFix.length,
        campaignsUpdated,
        errors,
        adAccountsProcessed: adAccountIds,
        campaignGroupsFound: allCampaignGroups.length,
      },
    };
  } catch (error: any) {
    this.logger.error(`Restoration failed: ${error.message}`, error.stack);
    return {
      success: false,
      message: 'Failed to restore campaign relations',
      data: {
        totalCampaignsProcessed: 0,
        campaignsUpdated: 0,
        errors: [error.message],
        adAccountsProcessed: [],
        campaignGroupsFound: 0,
      },
    };
  }
}
}
