import {
  Injectable,
  InternalServerErrorException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as schedule from 'node-schedule';
import Bottleneck from 'bottleneck';
import axios from 'axios';
import {
  MetaCampaign,
  MetaAdSet,
  MetaAd,
  MetaSpecialAdCategory,
} from '@prisma/client'; // Adjust import based on your Prisma schema
import { PrismaService } from 'src/prisma/prisma.service';
import { MetaService } from 'src/auth/meta/meta.service';
import { NotificationsService } from 'src/notifications/notifications.service';

export interface MetaCampaignInput {
  adAccountId: string;
  name: string;
  objective: string;
  buyingType: 'AUCTION' | 'RESERVED';
  bidStrategy:
    | 'LOWEST_COST_WITHOUT_CAP'
    | 'LOWEST_COST_WITH_BID_CAP'
    | 'COST_CAP';
  budget: {
    budgetType: 'DAILY' | 'LIFETIME';
    dailyBudget?: string;
    lifetimeBudget?: string;
    pacingType: 'STANDARD' | 'ACCELERATED';
    spendCap?: string;
  };
  runSchedule: {
    startTime: number;
    endTime?: number;
  };
  specialAdCategories: MetaSpecialAdCategory[];
  status: 'PAUSED' | 'ACTIVE';
  optimizationType?: 'NONE' | string;
}

@Injectable()
export class MetaCampaignService {
  private readonly logger = new Logger(MetaCampaignService.name);
  private readonly cronMap = {
    EVERY_20_SECONDS: '*/20 * * * * *',
    EVERY_30_MINUTES: '*/30 * * * *',
    EVERY_HOUR: '0 * * * *',
    EVERY_2_HOURS: '0 */2 * * *',
    EVERY_3_HOURS: '0 */3 * * *',
  };
  private readonly limiter = new Bottleneck({
    maxConcurrent: 5,
    minTime: 200,
  });
  private jobs = new Map<string, schedule.Job>();
  private runningSyncs = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly metaService: MetaService,
    private readonly notificationService: NotificationsService,
  ) {
    this.startDynamicSync();
  }

  private async startDynamicSync() {
    this.logger.log('Starting dynamic sync for single-org');
    const orgId = 'single-org';

    try {
      const config = await this.prisma.metaCampaignConfig.findUnique({
        where: { orgId },
        select: { orgId: true, autoSyncEnabled: true, syncInterval: true },
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
          this.logger.warn('MetaCampaignConfig for single-org not found');
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

  /**
   * Schedules periodic sync for an organization
   */
  private async scheduleOrgSync(orgId: string, syncInterval?: string) {
    const config = await this.prisma.metaCampaignConfig.findUnique({
      where: { orgId },
      select: { autoSyncEnabled: true, syncInterval: true },
    });

    // Check if there is an existing job for the org
    const existingJob = this.jobs.get(orgId);

    // If auto-sync is disabled, cancel any existing job and return
    if (!config?.autoSyncEnabled) {
      if (existingJob) {
        existingJob.cancel();
        this.jobs.delete(orgId);
        this.logger.log(
          `Cancelled sync job for org ${orgId} as auto-sync is disabled`,
        );
      }
      this.logger.log(
        `Auto-sync disabled for org ${orgId}, skipping scheduling`,
      );
      return;
    }

    // Cancel any existing job before scheduling a new one
    if (existingJob) {
      existingJob.cancel();
      this.jobs.delete(orgId);
      this.logger.log(`Cancelled old sync job for org ${orgId}`);
    }

    // Schedule new job only if auto-sync is enabled
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
          this.syncCampaignsAdSetsAndAds(orgId),
        );
        await this.notificationService.notifyUsersOfOrg(
          orgId,
          'receiveSyncSuccess',
          {
            title: 'Meta Sync Successful',
            message: `Meta campaigns were successfully synced for your organization.`,
            type: 'success: meta sync',
            meta: { orgId, url: "http://localhost:3000/campaigns"},
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

  async createOrUpdateMetaCampaignConfig(
    orgId: string,
    config: {
      syncInterval: string;
      autoSyncEnabled: boolean;
      adAccountIds: string[];
    },
  ) {
    this.logger.log(
      `Creating or updating MetaCampaignConfig for org: ${orgId}`,
    );

    // Validate sync interval
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

    // Validate organization
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
    });
    if (!org) {
      this.logger.error(`Organization not found for id: ${orgId}`);
      throw new Error('Organization not found');
    }

    // Validate Meta platform
    const platform = await this.prisma.marketingPlatform.findFirst({
      where: { orgId, platform_name: 'Meta' },
    });
    if (!platform) {
      this.logger.error('Meta platform not found for organization');
      throw new Error('Meta platform not configured');
    }

    this.logger.log('accounts', config.adAccountIds);
    // Upsert MetaCampaignConfig
    try {
      const configRecord = await this.prisma.metaCampaignConfig.upsert({
        where: { orgId },
        update: {
          syncInterval: config.syncInterval,
          autoSyncEnabled: config.autoSyncEnabled,
          adAccountIds: config.adAccountIds,
          updatedAt: new Date(),
        },
        create: {
          orgId,
          syncInterval: config.syncInterval,
          autoSyncEnabled: config.autoSyncEnabled,
          adAccountIds: config.adAccountIds,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });

      this.logger.log(
        `Successfully saved MetaCampaignConfig for org: ${orgId}`,
      );

      // Reset dynamic sync
      await this.startDynamicSync();

      return {
        id: configRecord.id,
        orgId: configRecord.orgId,
        syncInterval: configRecord.syncInterval,
        autoSyncEnabled: configRecord.autoSyncEnabled,
        adAccountIds: configRecord.adAccountIds,
        lastSyncedAt: configRecord.lastSyncedAt,
        createdAt: configRecord.createdAt,
        updatedAt: configRecord.updatedAt,
      };
    } catch (error: any) {
      this.logger.error(`Failed to save MetaCampaignConfig: ${error.message}`);
      throw new InternalServerErrorException(
        'Failed to save Meta campaign configuration',
      );
    }
  }

  async getMetaCampaignConfigByOrgId(orgId: string) {
    this.logger.log(`Fetching MetaCampaignConfig for org: ${orgId}`);

    // Validate organization
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
    });
    if (!org) {
      this.logger.error(`Organization not found for id: ${orgId}`);
      throw new NotFoundException('Organization not found');
    }

    // Fetch MetaCampaignConfig
    try {
      const configRecord = await this.prisma.metaCampaignConfig.findUnique({
        where: { orgId },
        select: {
          id: true,
          orgId: true,
          syncInterval: true,
          autoSyncEnabled: true,
          adAccountIds: true,
          lastSyncedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      if (!configRecord) {
        this.logger.error(`MetaCampaignConfig not found for org: ${orgId}`);
        throw new NotFoundException('Meta campaign configuration not found');
      }

      this.logger.log(
        `Successfully fetched MetaCampaignConfig for org: ${orgId}`,
      );

      return {
        id: configRecord.id,
        orgId: configRecord.orgId,
        syncInterval: configRecord.syncInterval,
        autoSyncEnabled: configRecord.autoSyncEnabled,
        adAccountIds: configRecord.adAccountIds,
        lastSyncedAt: configRecord.lastSyncedAt,
        createdAt: configRecord.createdAt,
        updatedAt: configRecord.updatedAt,
      };
    } catch (error: any) {
      this.logger.error(`Failed to fetch MetaCampaignConfig: ${error.message}`);
      throw new InternalServerErrorException(
        'Failed to fetch Meta campaign configuration',
      );
    }
  }

  private async syncCampaignsAdSetsAndAds(orgId: string) {
    this.logger.log(`Syncing campaigns, ad sets, and ads for org ${orgId}`);

    const config = await this.prisma.metaCampaignConfig.findUnique({
      where: { orgId },
      select: { adAccountIds: true, autoSyncEnabled: true },
    });

    if (!config || !config.autoSyncEnabled) {
      this.logger.log(`No config found or auto-sync disabled for org ${orgId}`);
      return;
    }

    if (!config.adAccountIds || config.adAccountIds.length === 0) {
      this.logger.log(`No ad accounts found for org ${orgId}`);
      return;
    }

    for (const adAccountId of config.adAccountIds) {
      await this.limiter.schedule(() =>
        this.fetchAndSyncMetaCampaigns(adAccountId),
      );
    }

    // Update lastSyncedAt
    await this.prisma.metaCampaignConfig.update({
      where: { orgId },
      data: { lastSyncedAt: new Date() },
    });
  }

  private async fetchAndSyncMetaCampaigns(adAccountId: string) {
    this.logger.log(`Fetching Meta campaigns for ad account: ${adAccountId}`);

    const platform = await this.prisma.marketingPlatform.findFirst({
      where: { orgId: 'single-org', platform_name: 'Meta' },
    });
    if (!platform) {
      throw new InternalServerErrorException(
        'Meta marketing platform not found',
      );
    }

    const creds = await this.metaService.getMetaCredentials();
    if (!creds.clientId || !creds.clientSecret) {
      throw new ForbiddenException('No valid Meta credentials found');
    }

    const platformCreds = await this.prisma.platformCredentials.findFirst({
      where: { platform_id: platform.platform_id, type: 'AUTH', user_id: null },
    });
    if (!platformCreds || !platformCreds.access_token) {
      throw new ForbiddenException('No valid Meta platform credentials found');
    }

    const accessToken = await this.metaService.getValidAccessToken(
      creds.clientId,
      creds.clientSecret,
      platformCreds?.access_token || '',
      platform.platform_id,
    );
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    };

    try {
      // Fetch existing campaigns from database
      const existingCampaigns = await this.prisma.metaCampaign.findMany({
        where: { ad_account_id: adAccountId },
        select: { campaign_id: true, updated_at: true },
      });
      const existingCampaignMap = new Map(
        existingCampaigns.map((c) => [c.campaign_id, c.updated_at]),
      );

      // Fetch campaigns from Meta API
      const campaignsUrl = `https://graph.facebook.com/v23.0/${adAccountId}/campaigns`;
      const params = {
        fields: [
          'id',
          'name',
          'objective',
          'bid_strategy',
          'buying_type',
          'status',
          'effective_status',
          'daily_budget',
          'lifetime_budget',
          'spend_cap',
          'budget_remaining',
          'special_ad_categories',
          'start_time',
          'stop_time',
          'issues_info',
        ].join(','),
        access_token: accessToken,
      };

      const response = await axios.get<any>(campaignsUrl, { params });
      const campaigns: any[] = response.data.data || [];

      this.logger.log(
        `Fetched ${campaigns.length} campaigns for ad account ${adAccountId}`,
      );

      const campaignsToSync = campaigns.filter((campaign) => {
        const dbUpdatedAt = existingCampaignMap.get(campaign.id);
        const needsUpdate =
          !dbUpdatedAt || new Date(campaign.updated_time) > dbUpdatedAt;
        if (needsUpdate) {
          this.logger.debug(
            `Campaign ${campaign.id} needs sync: DB updatedAt=${dbUpdatedAt}, API updated_time=${campaign.updated_time}`,
          );
        }
        return needsUpdate;
      });

      if (campaignsToSync.length === 0) {
        this.logger.log(
          `No campaigns need syncing for ad account ${adAccountId}`,
        );
        return;
      }

      // Save campaigns
      for (const campaign of campaignsToSync) {
        const campaignData = {
          campaign_id: campaign.id,
          campaign_name: campaign.name || `Campaign ${campaign.id}`,
          ad_account_id: adAccountId,
          platform_id: platform.platform_id,
          objective: campaign.objective as MetaCampaign['objective'],
          bid_strategy: campaign.bid_strategy as MetaCampaign['bid_strategy'],
          buying_type:
            (campaign.buying_type as MetaCampaign['buying_type']) || 'AUCTION',
          status: (campaign.status as MetaCampaign['status']) || 'PAUSED',
          effective_status:
            (campaign.effective_status as MetaCampaign['effective_status']) ||
            'PAUSED',
          special_ad_categories: campaign.special_ad_categories || ['NONE'],
          daily_budget: campaign.daily_budget
            ? parseInt(campaign.daily_budget)
            : null,
          lifetime_budget: campaign.lifetime_budget
            ? parseInt(campaign.lifetime_budget)
            : null,
          spend_cap: campaign.spend_cap ? parseInt(campaign.spend_cap) : null,
          budget_remaining: campaign.budget_remaining || null,
          issues_info: campaign.issues_info || null,
          start_time: campaign.start_time
            ? new Date(campaign.start_time)
            : null,
          end_time: campaign.stop_time ? new Date(campaign.stop_time) : null,
          data: campaign,
        };

        await this.prisma.metaCampaign.upsert({
          where: { campaign_id: campaign.id },
          create: campaignData,
          update: { ...campaignData, updated_at: new Date() },
        });

        // Sync ad sets for this campaign
        await this.limiter.schedule(() =>
          this.fetchAndSyncMetaAdSets(campaign.id, adAccountId, accessToken),
        );
      }

      this.logger.log(
        `Synced ${campaignsToSync.length} campaigns for ad account ${adAccountId}`,
      );
    } catch (error: any) {
      this.logger.error(
        `Failed to fetch campaigns for ad account ${adAccountId}: ${error.message}`,
        error.stack,
      );
      if (error.response?.status === 401) {
        throw new ForbiddenException('Invalid or expired access token');
      }
      if (error.response?.status === 429) {
        throw new Error('Rate limit exceeded');
      }
      throw new InternalServerErrorException(
        'Failed to fetch and sync Meta campaigns',
      );
    }
  }

  /**
   * Fetches and syncs ad sets for a specific campaign
   */
  private async fetchAndSyncMetaAdSets(
    campaignId: string,
    adAccountId: string,
    accessToken: string,
  ) {
    this.logger.log(`Fetching ad sets for campaign: ${campaignId}`);

    try {
      // Fetch existing ad sets from database
      const existingAdSets = await this.prisma.metaAdSet.findMany({
        where: { campaign_id: campaignId },
        select: { ad_set_id: true, updated_at: true },
      });
      const existingAdSetMap = new Map(
        existingAdSets.map((a) => [a.ad_set_id, a.updated_at]),
      );

      // Fetch ad sets from Meta API
      const adSetsUrl = `https://graph.facebook.com/v23.0/${campaignId}/adsets`;
      const params = {
        fields: [
          'id',
          'name',
          'status',
          'billing_event',
          'optimization_goal',
          'bid_amount',
          'daily_budget',
          'lifetime_budget',
          'pacing_type',
          'start_time',
          'end_time',
          'targeting',
          'promoted_object',
        ].join(','),
        access_token: accessToken,
      };

      const response = await axios.get<any>(adSetsUrl, { params });
      const adSets: any[] = response.data.data || [];

      this.logger.log(
        `Fetched ${adSets.length} ad sets for campaign ${campaignId}`,
      );

      const adSetsToSync = adSets.filter((adSet) => {
        const dbUpdatedAt = existingAdSetMap.get(adSet.id);
        const needsUpdate =
          !dbUpdatedAt || new Date(adSet.updated_time) > dbUpdatedAt;
        if (needsUpdate) {
          this.logger.debug(
            `AdSet ${adSet.id} needs sync: DB updatedAt=${dbUpdatedAt}, API updated_time=${adSet.updated_time}`,
          );
        }
        return needsUpdate;
      });

      if (adSetsToSync.length === 0) {
        this.logger.log(`No ad sets need syncing for campaign ${campaignId}`);
        return;
      }

      // Save ad sets
      for (const adSet of adSetsToSync) {
        const pacingType = Array.isArray(adSet.pacing_type)
          ? adSet.pacing_type.map((type: string) => type.toUpperCase())
          : ['STANDARD'];

        const adSetData = {
          ad_set_id: adSet.id,
          campaign_id: campaignId,
          name: adSet.name || `AdSet ${adSet.id}`,
          status: (adSet.status as MetaAdSet['status']) || 'PAUSED',
          billing_event:
            (adSet.billing_event as MetaAdSet['billing_event']) || null,
          optimization_goal:
            (adSet.optimization_goal as MetaAdSet['optimization_goal']) || null,
          bid_amount: adSet.bid_amount ? parseInt(adSet.bid_amount) : null,
          daily_budget: adSet.daily_budget
            ? parseInt(adSet.daily_budget)
            : null,
          lifetime_budget: adSet.lifetime_budget
            ? parseInt(adSet.lifetime_budget)
            : null,
          pacing_type: pacingType as MetaAdSet['pacing_type'],
          start_time: adSet.start_time ? new Date(adSet.start_time) : null,
          end_time: adSet.end_time ? new Date(adSet.end_time) : null,
          targeting: adSet.targeting || null,
          promoted_object: adSet.promoted_object || null,
          data: adSet,
        };

        await this.prisma.metaAdSet.upsert({
          where: { ad_set_id: adSet.id },
          create: adSetData,
          update: { ...adSetData, updated_at: new Date() },
        });

        // Sync ads for this ad set
        await this.limiter.schedule(() =>
          this.fetchAndSyncMetaAds(adSet.id, accessToken),
        );
      }

      this.logger.log(
        `Synced ${adSetsToSync.length} ad sets for campaign ${campaignId}`,
      );
    } catch (error: any) {
      this.logger.error(
        `Failed to fetch ad sets for campaign ${campaignId}: ${error.message}`,
        error.stack,
      );
      throw new InternalServerErrorException(
        'Failed to fetch and sync Meta ad sets',
      );
    }
  }

  /**
   * Fetches and syncs ads for a specific ad set
   */
  private async fetchAndSyncMetaAds(adSetId: string, accessToken: string) {
    this.logger.log(`Fetching ads for ad set: ${adSetId}`);

    try {
      // Fetch existing ads from database
      const existingAds = await this.prisma.metaAd.findMany({
        where: { ad_set_id: adSetId },
        select: { ad_id: true, updated_at: true },
      });
      const existingAdMap = new Map(
        existingAds.map((a) => [a.ad_id, a.updated_at]),
      );

      // Fetch ads from Meta API
      const adsUrl = `https://graph.facebook.com/v23.0/${adSetId}/ads`;
      const params = {
        fields: [
          'id',
          'name',
          'status',
          'creative',
          'tracking_specs',
          'effective_status',
          'issues_info',
        ].join(','),
        access_token: accessToken,
      };

      const response = await axios.get<any>(adsUrl, { params });
      const ads: any[] = response.data.data || [];

      this.logger.log(`Fetched ${ads.length} ads for ad set ${adSetId}`);

      const adsToSync = ads.filter((ad) => {
        const dbUpdatedAt = existingAdMap.get(ad.id);
        const needsUpdate =
          !dbUpdatedAt || new Date(ad.updated_time) > dbUpdatedAt;
        if (needsUpdate) {
          this.logger.debug(
            `Ad ${ad.id} needs sync: DB updatedAt=${dbUpdatedAt}, API updated_time=${ad.updated_time}`,
          );
        }
        return needsUpdate;
      });

      if (adsToSync.length === 0) {
        this.logger.log(`No ads need syncing for ad set ${adSetId}`);
        return;
      }

      // Save ads
      for (const ad of adsToSync) {
        const adData = {
          ad_id: ad.id,
          ad_set_id: adSetId,
          ad_name: ad.name || `Ad ${ad.id}`,
          status: (ad.status as MetaAd['status']) || 'PAUSED',
          effective_status:
            (ad.effective_status as MetaAd['effective_status']) || 'PAUSED',
          creative: ad.creative || null,
          tracking: ad.tracking_specs || null,
          issues_info: ad.issues_info || null,
          data: ad,
        };

        await this.prisma.metaAd.upsert({
          where: { ad_id: ad.id },
          create: adData,
          update: { ...adData, updated_at: new Date() },
        });
      }

      this.logger.log(`Synced ${adsToSync.length} ads for ad set ${adSetId}`);
    } catch (error: any) {
      this.logger.error(
        `Failed to fetch ads for ad set ${adSetId}: ${error.message}`,
        error.stack,
      );
      throw new InternalServerErrorException(
        'Failed to fetch and sync Meta ads',
      );
    }
  }

  async fetchAllCampaigns(filters: {
  search?: string;
  status?: string | string[];
  objective?: string | string[];
  startDateFrom?: Date;
  startDateTo?: Date;
  endDateFrom?: Date;
  endDateTo?: Date;
  minDailyBudget?: number;
  maxDailyBudget?: number;
  minLifetimeBudget?: number;
  maxLifetimeBudget?: number;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
} = {}) {
  this.logger.log('Fetching Meta campaigns from database with filters:', filters);

  try {
    // Validate date ranges
    if (filters.startDateFrom && filters.startDateTo && filters.startDateFrom > filters.startDateTo) {
      throw new Error('startDateFrom must be before or equal to startDateTo');
    }
    if (filters.endDateFrom && filters.endDateTo && filters.endDateFrom > filters.endDateTo) {
      throw new Error('endDateFrom must be before or equal to endDateTo');
    }

    // Initialize where clause
    const where: any = {};

    // Add filters if provided
    if (filters.status) {
      where.status = Array.isArray(filters.status)
        ? { in: filters.status }
        : { in: [filters.status] };
    }

    if (filters.search) {
      where.OR = [
        { campaign_name: { contains: filters.search, mode: 'insensitive' } },
        { campaign_id: { contains: filters.search, mode: 'insensitive' } },
      ];
    }

    if (filters.objective) {
      where.objective = Array.isArray(filters.objective)
        ? { in: filters.objective }
        : { in: [filters.objective] };
    }

    // Date range filters
    if (filters.startDateFrom || filters.startDateTo) {
      where.start_time = {};
      if (filters.startDateFrom) {
        where.start_time.gte = filters.startDateFrom;
      }
      if (filters.startDateTo) {
        where.start_time.lte = filters.startDateTo;
      }
    }

    if (filters.endDateFrom || filters.endDateTo) {
      where.end_time = {};
      if (filters.endDateFrom) {
        where.end_time.gte = filters.endDateFrom;
      }
      if (filters.endDateTo) {
        where.end_time.lte = filters.endDateTo;
      }
    }

    // Budget range filters (convert dollars to cents)
    if (filters.minDailyBudget || filters.maxDailyBudget) {
      where.daily_budget = {};
      if (filters.minDailyBudget) {
        where.daily_budget.gte = Math.round(filters.minDailyBudget * 100);
      }
      if (filters.maxDailyBudget) {
        where.daily_budget.lte = Math.round(filters.maxDailyBudget * 100);
      }
    }

    if (filters.minLifetimeBudget || filters.maxLifetimeBudget) {
      where.lifetime_budget = {};
      if (filters.minLifetimeBudget) {
        where.lifetime_budget.gte = Math.round(filters.minLifetimeBudget * 100);
      }
      if (filters.maxLifetimeBudget) {
        where.lifetime_budget.lte = Math.round(filters.maxLifetimeBudget * 100);
      }
    }

    // Validate and calculate pagination
    const page = Math.max(1, filters.page || 1);
    const limit = Math.max(1, Math.min(100, filters.limit || 10)); // Cap limit to prevent abuse
    const skip = (page - 1) * limit;

    // Validate sortBy
    const validSortFields = [
      'created_at',
      'campaign_name',
      'daily_budget',
      'lifetime_budget',
      'start_time',
      'end_time',
    ];
    const sortBy = validSortFields.includes(filters.sortBy || '') ? filters.sortBy : 'created_at';
    const sortOrder = filters.sortOrder || 'desc';

    // Execute query with pagination and sorting
    const [campaigns, total] = await Promise.all([
      this.prisma.metaCampaign.findMany({
        where,
        select: {
          campaign_id: true,
          campaign_name: true,
          ad_account_id: true,
          platform_id: true,
          objective: true,
          bid_strategy: true,
          buying_type: true,
          status: true,
          effective_status: true,
          special_ad_categories: true,
          daily_budget: true,
          lifetime_budget: true,
          spend_cap: true,
          budget_remaining: true,
          issues_info: true,
          start_time: true,
          end_time: true,
          created_at: true,
          updated_at: true,
        },
        skip,
        take: limit,
        orderBy: {
          [sortBy as string]: sortOrder,
        },
      }),
      this.prisma.metaCampaign.count({ where }),
    ]);

    this.logger.log(
      `Fetched ${campaigns.length} Meta campaigns from database (total: ${total})`,
    );

    return {
      data: campaigns,
      pagination: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  } catch (error: any) {
    this.logger.error(`Failed to fetch Meta campaigns: ${error.message}`, error.stack);
    throw new Error(`Failed to fetch Meta campaigns: ${error.message}`);
  }
}

  async fetchAdSetsWithAds(campaignId: string) {
    this.logger.log(`Fetching ad sets with ads for campaign: ${campaignId}`);

    try {
      // Validate campaign existence
      const campaign = await this.prisma.metaCampaign.findUnique({
        where: { campaign_id: campaignId },
      });
      if (!campaign) {
        this.logger.error(`Campaign not found for id: ${campaignId}`);
        throw new Error('Campaign not found');
      }

      const adSets = await this.prisma.metaAdSet.findMany({
        where: { campaign_id: campaignId },
        select: {
          ad_set_id: true,
          name: true,
          status: true,
          billing_event: true,
          optimization_goal: true,
          bid_amount: true,
          daily_budget: true,
          lifetime_budget: true,
          pacing_type: true,
          start_time: true,
          end_time: true,
          targeting: true,
          promoted_object: true,
          created_at: true,
          updated_at: true,
          MetaAd: {
            select: {
              ad_id: true,
              ad_name: true,
              status: true,
              effective_status: true,
              creative: true,
              tracking: true,
              issues_info: true,
              created_at: true,
              updated_at: true,
            },
          },
        },
      });

      this.logger.log(
        `Fetched ${adSets.length} ad sets for campaign ${campaignId}`,
      );
      return adSets;
    } catch (error: any) {
      this.logger.error(
        `Failed to fetch ad sets for campaign ${campaignId}: ${error.message}`,
        error.stack,
      );
      throw new InternalServerErrorException(
        'Failed to fetch ad sets and ads from database',
      );
    }
  }

  async fetchCampaignById(campaignId: string) {
    this.logger.log(
      `Fetching full campaign details for campaign: ${campaignId}`,
    );

    try {
      const campaign = await this.prisma.metaCampaign.findUnique({
        where: { campaign_id: campaignId },
        include: {
          MetaAdSet: {
            select: {
              ad_set_id: true,
              name: true,
              status: true,
              billing_event: true,
              optimization_goal: true,
              bid_amount: true,
              daily_budget: true,
              lifetime_budget: true,
              pacing_type: true,
              start_time: true,
              end_time: true,
              targeting: true,
              promoted_object: true,
              created_at: true,
              updated_at: true,
              MetaAd: {
                select: {
                  ad_id: true,
                  ad_name: true,
                  status: true,
                  effective_status: true,
                  creative: true,
                  tracking: true,
                  issues_info: true,
                  created_at: true,
                  updated_at: true,
                },
              },
            },
          },
        },
      });

      if (!campaign) {
        this.logger.error(`Campaign not found for id: ${campaignId}`);
        throw new Error('Campaign not found');
      }

      this.logger.log(`Fetched full details for campaign ${campaignId}`);
      return campaign;
    } catch (error: any) {
      this.logger.error(
        `Failed to fetch campaign ${campaignId}: ${error.message}`,
        error.stack,
      );
      throw new InternalServerErrorException(
        'Failed to fetch campaign details from database',
      );
    }
  }

  async createCampaign(orgId: string, data: MetaCampaignInput) {
    this.logger.log(
      `Creating Meta campaign for org ${orgId}, ad account data: ${JSON.stringify(data, null, 2)}`,
    );

    // Validate organization and ad account
    const config = await this.prisma.metaCampaignConfig.findUnique({
      where: { orgId },
      select: { adAccountIds: true },
    });
    if (!config || !config.adAccountIds.includes(data.adAccountId)) {
      this.logger.error(
        `Ad account ${data.adAccountId} not found or not authorized for org ${orgId}`,
      );
      throw new ForbiddenException(
        'Ad account not authorized for this organization',
      );
    }

    // Get Meta credentials and access token
    const platform = await this.prisma.marketingPlatform.findFirst({
      where: { orgId, platform_name: 'Meta' },
    });
    if (!platform) {
      this.logger.error('Meta platform not found for organization');
      throw new InternalServerErrorException('Meta platform not configured');
    }

    const creds = await this.metaService.getMetaCredentials();
    if (!creds.clientId || !creds.clientSecret) {
      throw new ForbiddenException('No valid Meta credentials found');
    }

    const platformCreds = await this.prisma.platformCredentials.findFirst({
      where: { platform_id: platform.platform_id, type: 'AUTH', user_id: null },
    });
    if (!platformCreds || !platformCreds.access_token) {
      throw new ForbiddenException('No valid Meta platform credentials found');
    }

    const accessToken = await this.metaService.getValidAccessToken(
      creds.clientId,
      creds.clientSecret,
      platformCreds.access_token,
      platform.platform_id,
    );

    // Prepare Meta API request
    const url = `https://graph.facebook.com/v23.0/${data.adAccountId}/campaigns`;
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    };

    const payload: any = {
      name: data.name,
      objective: data.objective,
      buying_type: data.buyingType,
      bid_strategy: data.bidStrategy,
      status: data.status,
      special_ad_categories: data.specialAdCategories,
      start_time: new Date(data.runSchedule.startTime).toISOString(),
    };

    if (data.budget.budgetType === 'DAILY' && data.budget.dailyBudget) {
      payload.daily_budget = parseInt(data.budget.dailyBudget);
    } else if (
      data.budget.budgetType === 'LIFETIME' &&
      data.budget.lifetimeBudget
    ) {
      payload.lifetime_budget = parseInt(data.budget.lifetimeBudget);
    }

    // Only add optimization_goal if it's not NONE
    if (data.optimizationType && data.optimizationType !== 'NONE') {
      payload.optimization_goal = data.optimizationType;
    }

    // Only add stop_time if present
    if (data.runSchedule.endTime) {
      payload.stop_time = new Date(data.runSchedule.endTime).toISOString();
    }

    try {
      // Create campaign via Meta API
      const response = await this.limiter.schedule(() =>
        axios.post<any>(url, payload, { headers }),
      );
      const campaign = response.data;

      if (!campaign.id) {
        this.logger.error('Meta API did not return a campaign ID');
        throw new InternalServerErrorException(
          'Failed to create campaign: No ID returned',
        );
      }

      // Save to database
      // Save to database
      const campaignData = {
        campaign_id: campaign.id,
        campaign_name: data.name,
        ad_account_id: data.adAccountId,
        platform_id: platform.platform_id,
        objective: data.objective as MetaCampaign['objective'],
        bid_strategy: data.bidStrategy as MetaCampaign['bid_strategy'],
        buying_type: data.buyingType as MetaCampaign['buying_type'],
        status: data.status as MetaCampaign['status'],
        effective_status: data.status as MetaCampaign['effective_status'],
        special_ad_categories:
          data.specialAdCategories as MetaSpecialAdCategory[],
        daily_budget:
          data.budget.budgetType === 'DAILY' && data.budget.dailyBudget
            ? parseInt(data.budget.dailyBudget)
            : null,
        lifetime_budget:
          data.budget.budgetType === 'LIFETIME' && data.budget.lifetimeBudget
            ? parseInt(data.budget.lifetimeBudget)
            : null,
        spend_cap: data.budget.spendCap ? parseInt(data.budget.spendCap) : null,
        budget_remaining: null,
        issues_info: undefined, // Changed from null to undefined to match Prisma's NullableJsonNullValueInput
        start_time: new Date(data.runSchedule.startTime),
        end_time: data.runSchedule.endTime
          ? new Date(data.runSchedule.endTime)
          : null,
        data: { ...payload, id: campaign.id },
        created_at: new Date(),
        updated_at: new Date(),
      };

      const savedCampaign = await this.prisma.metaCampaign.create({
        data: campaignData,
      });

      this.logger.log(
        `Created campaign ${campaign.id} for ad account ${data.adAccountId}`,
      );
      return savedCampaign;
    } catch (error: any) {
      this.logger.error(
        `Failed to create campaign: ${error.message}`,
        error.stack,
      );
      if (error.response?.status === 401) {
        throw new ForbiddenException('Invalid or expired access token');
      }
      if (error.response?.status === 429) {
        throw new InternalServerErrorException('Rate limit exceeded');
      }
      throw new InternalServerErrorException('Failed to create Meta campaign');
    }
  }

  async updateCampaign(orgId: string, campaignId: string, data: any) {
    this.logger.log(
      `Updating Meta campaign for org ${orgId} for ${campaignId}, ad account data: ${JSON.stringify(data, null, 2)}`,
    );
    // Validate campaign and ad account
    const campaign = await this.prisma.metaCampaign.findUnique({
      where: { campaign_id: campaignId },
      select: { ad_account_id: true, platform_id: true },
    });
    if (!campaign) {
      this.logger.error(`Campaign not found for id: ${campaignId}`);
      throw new NotFoundException('Campaign not found');
    }

    const config = await this.prisma.metaCampaignConfig.findUnique({
      where: { orgId },
      select: { adAccountIds: true },
    });
    if (!config || !config.adAccountIds.includes(campaign.ad_account_id)) {
      this.logger.error(
        `Ad account ${campaign.ad_account_id} not authorized for org ${orgId}`,
      );
      throw new ForbiddenException(
        'Ad account not authorized for this organization',
      );
    }

    // Get Meta credentials and access token
    const platform = await this.prisma.marketingPlatform.findFirst({
      where: { orgId, platform_name: 'Meta' },
    });
    if (!platform) {
      this.logger.error('Meta platform not found for organization');
      throw new InternalServerErrorException('Meta platform not configured');
    }

    const creds = await this.metaService.getMetaCredentials();
    if (!creds.clientId || !creds.clientSecret) {
      throw new ForbiddenException('No valid Meta credentials found');
    }

    const platformCreds = await this.prisma.platformCredentials.findFirst({
      where: { platform_id: platform.platform_id, type: 'AUTH', user_id: null },
    });
    if (!platformCreds || !platformCreds.access_token) {
      throw new ForbiddenException('No valid Meta platform credentials found');
    }

    const accessToken = await this.metaService.getValidAccessToken(
      creds.clientId,
      creds.clientSecret,
      platformCreds.access_token,
      platform.platform_id,
    );

    // Prepare Meta API request
    const url = `https://graph.facebook.com/v23.0/${campaignId}`;
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    };

    const payload: any = {};
    if (data.name) payload.name = data.name;
    if (data.status) payload.status = data.status;
    if (data.budget) {
      if (data.budget.budgetType === 'DAILY' && data.budget.dailyBudget) {
        payload.daily_budget = parseInt(data.budget.dailyBudget);
        payload.lifetime_budget = null;
      } else if (
        data.budget.budgetType === 'LIFETIME' &&
        data.budget.lifetimeBudget
      ) {
        payload.lifetime_budget = parseInt(data.budget.lifetimeBudget);
        payload.daily_budget = null;
      }
      if (data.budget.spendCap) {
        payload.spend_cap = parseInt(data.budget.spendCap);
      } else if (data.budget.spendCap === null) {
        payload.spend_cap = null;
      }
      if (data.budget.pacingType) {
        payload.pacing_type = data.budget.pacingType.toLowerCase();
      }
    }
    if (data.runSchedule) {
      if (data.runSchedule.startTime) {
        payload.start_time = new Date(data.runSchedule.startTime).toISOString();
      }
      if (data.runSchedule.endTime) {
        payload.stop_time = new Date(data.runSchedule.endTime).toISOString();
      } else if (data.runSchedule.endTime === null) {
        payload.stop_time = null;
      }
    }

    try {
      // Update campaign via Meta API
      const response = await this.limiter.schedule(() =>
        axios.post<any>(url, payload, { headers }),
      );
      if (!response.data.success) {
        this.logger.error('Meta API did not confirm successful update');
        throw new InternalServerErrorException('Failed to update campaign');
      }

      // Update database
      const updateData: any = {
        updated_at: new Date(),
      };
      if (data.name) updateData.campaign_name = data.name;
      if (data.status) {
        updateData.status = data.status;
        updateData.effective_status = data.status; // Assume effective_status mirrors status
      }
      if (data.budget) {
        updateData.daily_budget =
          data.budget.budgetType === 'DAILY' && data.budget.dailyBudget
            ? parseInt(data.budget.dailyBudget)
            : null;
        updateData.lifetime_budget =
          data.budget.budgetType === 'LIFETIME' && data.budget.lifetimeBudget
            ? parseInt(data.budget.lifetimeBudget)
            : null;
        updateData.spend_cap = data.budget.spendCap
          ? parseInt(data.budget.spendCap)
          : null;
        updateData.pacing_type = data.budget.pacingType
          ? [data.budget.pacingType]
          : undefined;
      }
      if (data.runSchedule) {
        updateData.start_time = data.runSchedule.startTime
          ? new Date(data.runSchedule.startTime)
          : undefined;
        updateData.end_time = data.runSchedule.endTime
          ? new Date(data.runSchedule.endTime)
          : null;
      }
      updateData.data = { ...updateData, id: campaignId }; // Update stored API payload

      const updatedCampaign = await this.prisma.metaCampaign.update({
        where: { campaign_id: campaignId },
        data: updateData,
      });

      this.logger.log(`Updated campaign ${campaignId}`);
      return updatedCampaign;
    } catch (error: any) {
      this.logger.error(
        `Failed to update campaign ${campaignId}: ${error.message}`,
        error.stack,
      );
      if (error.response?.status === 401) {
        throw new ForbiddenException('Invalid or expired access token');
      }
      if (error.response?.status === 429) {
        throw new InternalServerErrorException('Rate limit exceeded');
      }
      if (error.response?.status === 400) {
        throw new InternalServerErrorException('Invalid campaign data');
      }
      throw new InternalServerErrorException('Failed to update Meta campaign');
    }
  }

  async deleteCampaign(orgId: string, campaignId: string) {
    this.logger.log(`Deleting Meta campaign ${campaignId} for org ${orgId}`);

    // Validate campaign and ad account
    const campaign = await this.prisma.metaCampaign.findUnique({
      where: { campaign_id: campaignId },
      select: { ad_account_id: true, platform_id: true },
    });
    if (!campaign) {
      this.logger.error(`Campaign not found for id: ${campaignId}`);
      throw new NotFoundException('Campaign not found');
    }

    const config = await this.prisma.metaCampaignConfig.findUnique({
      where: { orgId },
      select: { adAccountIds: true },
    });
    if (!config || !config.adAccountIds.includes(campaign.ad_account_id)) {
      this.logger.error(
        `Ad account ${campaign.ad_account_id} not authorized for org ${orgId}`,
      );
      throw new ForbiddenException(
        'Ad account not authorized for this organization',
      );
    }

    // Get Meta credentials and access token
    const platform = await this.prisma.marketingPlatform.findFirst({
      where: { orgId, platform_name: 'Meta' },
    });
    if (!platform) {
      this.logger.error('Meta platform not found for organization');
      throw new InternalServerErrorException('Meta platform not configured');
    }

    const creds = await this.metaService.getMetaCredentials();
    if (!creds.clientId || !creds.clientSecret) {
      throw new ForbiddenException('No valid Meta credentials found');
    }

    const platformCreds = await this.prisma.platformCredentials.findFirst({
      where: { platform_id: platform.platform_id, type: 'AUTH', user_id: null },
    });
    if (!platformCreds || !platformCreds.access_token) {
      throw new ForbiddenException('No valid Meta platform credentials found');
    }

    const accessToken = await this.metaService.getValidAccessToken(
      creds.clientId,
      creds.clientSecret,
      platformCreds.access_token,
      platform.platform_id,
    );

    // Start a transaction to ensure database consistency
    return await this.prisma.$transaction(async (prisma) => {
      // Delete related MetaAdSet and MetaAd records
      await prisma.metaAd.deleteMany({
        where: {
          ad_set: {
            campaign_id: campaignId,
          },
        },
      });

      await prisma.metaAdSet.deleteMany({
        where: { campaign_id: campaignId },
      });

      // Delete campaign via Meta API
      const url = `https://graph.facebook.com/v23.0/${campaignId}`;
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      };

      try {
        const response = await this.limiter.schedule(() =>
          axios.delete<any>(url, { headers }),
        );
        if (!response.data.success) {
          this.logger.error('Meta API did not confirm successful deletion');
          throw new InternalServerErrorException('Failed to delete campaign');
        }

        // Delete campaign from database
        await prisma.metaCampaign.delete({
          where: { campaign_id: campaignId },
        });

        this.logger.log(`Deleted campaign ${campaignId}`);
        return { success: true };
      } catch (error: any) {
        this.logger.error(
          `Failed to delete campaign ${campaignId}: ${error.message}`,
          error.stack,
        );
        if (error.response?.status === 401) {
          throw new ForbiddenException('Invalid or expired access token');
        }
        if (error.response?.status === 429) {
          throw new InternalServerErrorException('Rate limit exceeded');
        }
        if (error.response?.status === 400) {
          throw new InternalServerErrorException(
            'Invalid campaign ID or already deleted',
          );
        }
        throw new InternalServerErrorException(
          'Failed to delete Meta campaign',
        );
      }
    });
  }
}
