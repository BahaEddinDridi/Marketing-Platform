// File: src/campaigns/google/googleCampaigns.service.ts
import {
  Injectable,
  Logger,
  UnauthorizedException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/prisma/prisma.service';
import { GoogleService } from 'src/auth/google/google.service';
import {
  enums,
  GoogleAdsApi,
  MutateOperation,
  ResourceNames,
  resources,
  toMicros,
} from 'google-ads-api';
import * as schedule from 'node-schedule';
import Bottleneck from 'bottleneck';
import {
  Prisma,
  GoogleCampaignStatus,
  GoogleAdGroupStatus,
  GoogleAdStatus,
  GoogleAdvertisingChannelType,
  GoogleCampaignPrimaryStatus,
  GoogleServingStatus,
  PaymentMode,
  GoogleObjectiveType,
  GoogleBudgetDeliveryMethod,
} from '@prisma/client';
import axios from 'axios';

interface CampaignBudget {
  resourceName: string;
  amount_micros?: number;
  delivery_method?: string;
  explicitly_shared?: boolean;
}


export interface GoogleAdsFormData {
  customerAccountId: string;
  currencyCode: string;
  timeZone: string;
  name: string;
  objectiveType: string;
  advertisingChannelType: string;
  status: string;
  budgetOption: 'CREATE_NEW' | 'SELECT_EXISTING';
  existingBudgetId?: string;
  newBudget?: {
    name: string;
    amount: string;
    currencyCode: string;
    deliveryMethod: string;
    explicitly_shared: boolean;
  };
  biddingStrategyType?: string;
  targetCpa?: string;
  targetRoas?: string;
  networkSettings: {
    targetGoogleSearch: boolean;
    targetSearchNetwork: boolean;
    targetContentNetwork: boolean;
    targetPartnerSearchNetwork: boolean;
    targetYoutube: boolean;
    targetGoogleTvNetwork: boolean;
  };
  runSchedule: {
    start?: number;
    end?: number;
  };
  geoTargets: {
    include: { value: string; text: string }[];
    exclude: { value: string; text: string }[];
  };
  languages: {
    include: { value: string; text: string }[];
    exclude: { value: string; text: string }[];
  };
}

export const CampaignStatusMap = {
  2: 'ENABLED',
  3: 'PAUSED',
  4: 'REMOVED',
} as const;

export const BiddingStrategySystemStatusMap = {
  0: 'UNSPECIFIED',
  1: 'UNKNOWN',
  2: 'ENABLED',
  3: 'LEARNING_NEW',
  4: 'LEARNING_SETTING_CHANGE',
  5: 'LEARNING_BUDGET_CHANGE',
  6: 'LEARNING_COMPOSITION_CHANGE',
  7: 'LEARNING_CONVERSION_TYPE_CHANGE',
  8: 'LEARNING_CONVERSION_SETTING_CHANGE',
  9: 'LIMITED_BY_CPC_BID_CEILING',
  10: 'LIMITED_BY_CPC_BID_FLOOR',
  11: 'LIMITED_BY_DATA',
  12: 'LIMITED_BY_BUDGET',
  13: 'LIMITED_BY_LOW_PRIORITY_SPEND',
  14: 'LIMITED_BY_LOW_QUALITY',
  15: 'LIMITED_BY_INVENTORY',
  16: 'MISCONFIGURED_ZERO_ELIGIBILITY',
  17: 'MISCONFIGURED_CONVERSION_TYPES',
  18: 'MISCONFIGURED_CONVERSION_SETTINGS',
  19: 'MISCONFIGURED_SHARED_BUDGET',
  20: 'MISCONFIGURED_STRATEGY_TYPE',
  21: 'PAUSED',
  22: 'MULTIPLE',
  23: 'UNAVAILABLE',
  24: 'MULTIPLE_LEARNING',
  25: 'MULTIPLE_LIMITED',
  26: 'MULTIPLE_MISCONFIGURED',
} as const;

export const BiddingStrategyTypeMap: { [key: number]: string } = {
  0: 'UNSPECIFIED',
  1: 'UNKNOWN',
  2: 'COMMISSION',
  3: 'ENHANCED_CPC',
  4: 'FIXED_CPM',
  5: 'INVALID',
  6: 'MANUAL_CPA',
  7: 'MANUAL_CPC',
  8: 'MANUAL_CPM',
  9: 'MANUAL_CPV',
  10: 'MAXIMIZE_CONVERSIONS',
  11: 'MAXIMIZE_CONVERSION_VALUE',
  12: 'PAGE_ONE_PROMOTED',
  13: 'PERCENT_CPC',
  14: 'TARGET_CPA',
  15: 'TARGET_CPM',
  16: 'TARGET_CPV',
  17: 'TARGET_IMPRESSION_SHARE',
  18: 'TARGET_OUTRANK_SHARE',
  19: 'TARGET_ROAS',
  20: 'TARGET_SPEND',
};

export const GoogleCampaignPrimaryStatusMap = {
  0: 'UNSPECIFIED',
  1: 'UNKNOWN',
  2: 'ELIGIBLE',
  3: 'PAUSED',
  4: 'REMOVED',
  5: 'ENDED',
  6: 'PENDING',
  7: 'MISCONFIGURED',
  8: 'LIMITED',
  9: 'LEARNING',
  10: 'NOT_ELIGIBLE',
} as const;

export const GoogleObjectiveTypeMap = {
  0: 'SALES',
  1: 'LEADS',
  2: 'WEBSITE_TRAFFIC',
  3: 'APP_PROMOTION',
  4: 'AWARENESS',
} as const;

export const GoogleAdvertisingChannelTypeMap = {
  0: 'UNSPECIFIED',
  1: 'UNKNOWN',
  2: 'SEARCH',
  3: 'DISPLAY',
  4: 'SHOPPING',
  5: 'HOTEL',
  6: 'VIDEO',
  7: 'MULTI_CHANNEL',
  8: 'LOCAL',
  9: 'SMART',
  10: 'PERFORMANCE_MAX',
  11: 'LOCAL_SERVICES',
  12: 'TRAVEL',
  13: 'DEMAND_GEN',
} as const;

export const GoogleBudgetDeliveryMethodMap = {
  0: 'STANDARD',
  1: 'ACCELERATED',
} as const;

export const GoogleServingStatusMap = {
  0: 'UNSPECIFIED',
  1: 'UNKNOWN',
  2: 'SERVING',
  3: 'NONE',
  4: 'ENDED',
  5: 'PENDING',
  6: 'SUSPENDED',
} as const;

export const GoogleGeoTargetTypeMap = {
  0: 'UNSPECIFIED',
  1: 'UNKNOWN',
  2: 'PRESENCE_OR_INTEREST',
  3: 'SEARCH_INTEREST',
  4: 'PRESENCE',
} as const;

export const GoogleAdGroupStatusMap = {
  2: 'ENABLED',
  3: 'PAUSED',
  4: 'REMOVED',
} as const;

export const GoogleAdStatusMap = {
  2: 'ENABLED',
  3: 'PAUSED',
  4: 'REMOVED',
} as const;

export const GoogleAdTypeMap = {
  0: 'RESPONSIVE_SEARCH_AD',
  1: 'EXPANDED_TEXT_AD',
  2: 'RESPONSIVE_DISPLAY_AD',
  3: 'VIDEO_AD',
  4: 'SHOPPING_PRODUCT_AD',
} as const;

export const GoogleAdGroupRotationMap = {
  0: 'OPTIMIZE',
  1: 'ROTATE_FOREVER',
  2: 'UNKNOWN',
  3: 'UNSPECIFIED',
} as const;

export const PaymentModeMap = {
  0: 'UNSPECIFIED',
  1: 'UNKNOWN',
  2: 'CLICKS',
  3: 'CONVERSION_VALUE',
  4: 'CONVERSIONS',
  5: 'GUEST_STAY',
} as const;

@Injectable()
export class GoogleCampaignsService {
  private readonly logger = new Logger(GoogleCampaignsService.name);
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
    private readonly googleService: GoogleService,
    private readonly configService: ConfigService,
  ) {
    this.startDynamicSync();
  }

  private async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private mapCampaignStatus(apiStatus: number): GoogleCampaignStatus {
    const statusMap: { [key: number]: GoogleCampaignStatus } = {
      2: GoogleCampaignStatus.ENABLED,
      3: GoogleCampaignStatus.PAUSED,
      4: GoogleCampaignStatus.REMOVED,
    };
    if (!statusMap[apiStatus]) {
      this.logger.warn(
        `Unknown campaign status ${apiStatus}, defaulting to PAUSED`,
      );
      return GoogleCampaignStatus.PAUSED;
    }
    return statusMap[apiStatus];
  }
  /**
   * Extracts customer ID from a resource name (e.g., customers/8917543254/campaigns/22753372249)
   */
  private extractCustomerId(resourceName: string): string {
    const match = resourceName.match(/^customers\/(\d+)/);
    if (!match) {
      throw new Error(`Invalid resource name format: ${resourceName}`);
    }
    return match[1]; // e.g., "8917543254"
  }

  /**
   * Starts dynamic sync for the single organization
   */
  private async startDynamicSync() {
    this.logger.log('Starting dynamic sync for single-org');
    try {
      const config = await this.prisma.googleCampaignConfig.findUnique({
        where: { orgId: 'single-org' },
        select: {
          orgId: true,
          autoSyncEnabled: true,
          syncInterval: true,
        },
      });

      if (!config) {
        this.logger.warn('GoogleCampaignConfig for single-org not found');
        return;
      }

      this.logger.log('Found GoogleCampaignConfig for single-org to sync');
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
  async scheduleOrgSync(orgId: string, syncInterval?: string) {
    const config = await this.prisma.googleCampaignConfig.findUnique({
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
          this.syncCampaignsAdGroupsAndAds(orgId),
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

  /**
   * Syncs campaigns, ad groups, and ads for all client accounts under an organization
   */
  async syncCampaignsAdGroupsAndAds(orgId: string) {
    this.logger.log(`Syncing campaigns, ad groups, and ads for org ${orgId}`);

    const config = await this.prisma.googleCampaignConfig.findUnique({
      where: { orgId },
      include: {
        googleAccounts: true,
      },
    });

    if (!config || !config.autoSyncEnabled) {
      this.logger.log(`No config found or auto-sync disabled for org ${orgId}`);
      return;
    }

    if (!config.googleAccounts || config.googleAccounts.length === 0) {
      this.logger.log(`No Google accounts found for org ${orgId}`);
      return;
    }

    // Iterate through each Google account and its client accounts
    for (const googleAccount of config.googleAccounts) {
      const clientAccounts = googleAccount.clientAccounts as
        | {
            id: string;
            descriptiveName: string | null;
            currencyCode: string | null;
            timeZone: string | null;
          }[]
        | null;

      if (!clientAccounts || clientAccounts.length === 0) {
        this.logger.log(
          `No client accounts found for Google account ${googleAccount.id} (MCC ${googleAccount.mccId})`,
        );
        continue;
      }

      // Fetch campaigns for each client account
      for (const clientAccount of clientAccounts) {
        const customerId = clientAccount.id.replace(/-/g, ''); // Normalize ID (e.g., "1234567890")
        await this.limiter.schedule(() =>
          this.fetchAndSyncGoogleCampaigns(
            googleAccount.mccId,
            customerId,
            clientAccount.descriptiveName || `Account ${customerId}`,
          ),
        );
      }
    }

    // Update lastSyncedAt
    await this.prisma.googleCampaignConfig.update({
      where: { orgId },
      data: { lastSyncedAt: new Date() },
    });
  }

  /**
   * Fetches and syncs campaigns for a specific client account
   */
  async fetchAndSyncGoogleCampaigns(
    googleAccountId: string,
    customerId: string,
    accountName: string,
  ): Promise<void> {
    this.logger.log(
      `Fetching Google campaigns for customer ID: ${customerId} (${accountName})`,
    );

    const creds = await this.googleService.getGoogleCredentials();
    const platform = await this.prisma.marketingPlatform.findFirst({
      where: { orgId: 'single-org', platform_name: 'Google' },
    });
    if (!platform) {
      throw new InternalServerErrorException(
        'Google marketing platform not found',
      );
    }

    const platformCreds = await this.prisma.platformCredentials.findFirst({
      where: { platform_id: platform.platform_id, type: 'AUTH', user_id: null },
    });
    if (!platformCreds || !platformCreds.refresh_token) {
      throw new ForbiddenException(
        'No valid Google platform credentials found',
      );
    }

    const client = new GoogleAdsApi({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      developer_token: creds.developerToken,
    });

    const customer = client.Customer({
      customer_id: customerId,
      refresh_token: platformCreds.refresh_token!,
      login_customer_id: googleAccountId,
    });

    try {
      // Fetch existing campaigns from database to compare
      const existingCampaigns = await this.prisma.googleCampaign.findMany({
        where: { customer_account_id: customerId },
        select: { campaign_id: true, updated_at: true },
      });
      const existingCampaignMap = new Map(
        existingCampaigns.map((c) => [c.campaign_id, c.updated_at]),
      );

      // GAQL query to fetch campaigns
      const campaignResponse = await customer.query(`
      SELECT 
        campaign.id,
        campaign.resource_name,
        campaign.name,
        campaign.status,
        campaign.serving_status,
        campaign.advertising_channel_type,
        campaign.bidding_strategy_type,
        campaign.bidding_strategy_system_status,
        campaign.payment_mode,
        campaign.primary_status,
        campaign.primary_status_reasons,
        campaign.campaign_budget,
        campaign.network_settings.target_google_search,
        campaign.network_settings.target_search_network,
        campaign.network_settings.target_content_network,
        campaign.network_settings.target_partner_search_network,
        campaign.geo_target_type_setting.positive_geo_target_type,
        campaign.geo_target_type_setting.negative_geo_target_type,
        campaign.start_date,
        campaign.end_date
      FROM campaign
      WHERE campaign.status IN (ENABLED, PAUSED)
    `);

      const campaigns: any[] = [];
      for await (const row of campaignResponse) {
        campaigns.push(row.campaign);
      }

      this.logger.log(
        `Fetched ${campaigns.length} campaigns for customer ${customerId}`,
      );

      const campaignsToSync = campaigns.filter((campaign) => {
        const dbUpdatedAt = existingCampaignMap.get(campaign.id.toString());
        const needsUpdate =
          !dbUpdatedAt || new Date(campaign.last_modified_time) > dbUpdatedAt;
        if (needsUpdate) {
          this.logger.debug(
            `Campaign ${campaign.id} needs sync: DB updatedAt=${dbUpdatedAt}, API lastModified=${campaign.last_modified_time}`,
          );
        }
        return needsUpdate;
      });

      if (campaignsToSync.length === 0) {
        this.logger.log(`No campaigns need syncing for customer ${customerId}`);
        return;
      }

      // Fetch budget details for campaigns
      const budgetResourceNames = campaignsToSync
        .map((c) => c.campaign_budget)
        .filter((b, i, arr) => b && arr.indexOf(b) === i); // Unique budget resource names
      const budgetResponse =
        budgetResourceNames.length > 0
          ? await customer.query(`
          SELECT 
            campaign_budget.resource_name,
            campaign_budget.amount_micros,
            campaign_budget.delivery_method
          FROM campaign_budget
          WHERE campaign_budget.resource_name IN (${budgetResourceNames.map((b) => `'${b}'`).join(',')})
        `)
          : [];

      const budgets: any[] = [];
      for await (const row of budgetResponse) {
        budgets.push(row.campaign_budget);
      }
      const budgetMap = new Map(budgets.map((b) => [b.resource_name, b]));

      // Fetch LOCATION criteria
      const locationCriteria = await customer.query(`
      SELECT
        campaign.id,
        campaign_criterion.criterion_id,
        campaign_criterion.location.geo_target_constant,
        campaign_criterion.negative
      FROM campaign_criterion
      WHERE campaign_criterion.type = LOCATION
    `);

      const locationMap = new Map<string, { include: any[]; exclude: any[] }>();
      const geoTargetConstants = new Set<string>();

      // Collect unique geo_target_constant resource names
      for await (const row of locationCriteria) {
        const { campaign, campaign_criterion } = row;
        const campaignId =
          campaign && campaign.id != null ? campaign.id.toString() : '';
        if (!campaign_criterion || !campaign_criterion.location) {
          continue;
        }
        const list = campaign_criterion.negative ? 'exclude' : 'include';

        if (!locationMap.has(campaignId)) {
          locationMap.set(campaignId, { include: [], exclude: [] });
        }

        const geoTargetConstant =
          campaign_criterion.location.geo_target_constant;
        if (geoTargetConstant) {
          geoTargetConstants.add(`'${geoTargetConstant}'`);
          locationMap.get(campaignId)![list].push({
            value: geoTargetConstant,
            negative: campaign_criterion.negative,
          });
        }
      }

      // Fetch geo_target_constant details if any exist
      const geoTargetMap = new Map<string, any>();
      if (geoTargetConstants.size > 0) {
        try {
          const geoTargetQuery = await customer.query(`
          SELECT
            geo_target_constant.resource_name,
            geo_target_constant.name,
            geo_target_constant.country_code,
            geo_target_constant.target_type
          FROM geo_target_constant
          WHERE geo_target_constant.resource_name IN (${Array.from(geoTargetConstants).join(',')})
        `);

          for await (const row of geoTargetQuery) {
            const { geo_target_constant } = row;
            if (geo_target_constant && geo_target_constant.resource_name) {
              geoTargetMap.set(geo_target_constant.resource_name, {
                text: geo_target_constant.name || '',
                countryCode: geo_target_constant.country_code || '',
                type: geo_target_constant.target_type || '',
              });
            }
          }
        } catch (error: any) {
          this.logger.error(
            `Failed to fetch geo_target_constant details: ${JSON.stringify(error, null, 2)}`,
            error.stack || 'No stack trace available',
          );
          throw new InternalServerErrorException(
            `Failed to fetch geo_target_constant details: ${error.message || 'Unknown error'}`,
          );
        }
      }

      // Enrich locationMap with geo_target_constant details
      for (const [campaignId, locations] of locationMap) {
        for (const list of ['include', 'exclude']) {
          locations[list] = locations[list].map((location: any) => ({
            value: location.value,
            text: geoTargetMap.get(location.value)?.text || '',
            countryCode: geoTargetMap.get(location.value)?.countryCode || '',
            type: geoTargetMap.get(location.value)?.type || '',
          }));
        }
      }

      // Fetch LANGUAGE criteria
      const languageCriteria = await customer.query(`
      SELECT
        campaign.id,
        campaign_criterion.criterion_id,
        campaign_criterion.language.language_constant,
        language_constant.name
      FROM campaign_criterion
      WHERE campaign_criterion.type = LANGUAGE
    `);

      const languageMap = new Map<string, any[]>();

      for await (const row of languageCriteria) {
        const { campaign, campaign_criterion, language_constant } = row;
        if (!campaign || campaign.id == null) {
          continue;
        }
        const campaignId = campaign.id.toString();

        if (!languageMap.has(campaignId)) {
          languageMap.set(campaignId, []);
        }

        if (
          campaign_criterion &&
          campaign_criterion.language &&
          language_constant
        ) {
          languageMap.get(campaignId)!.push({
            value: campaign_criterion.language.language_constant,
            text: language_constant.name,
          });
        }
      }

      // Save campaigns
      for (const campaign of campaignsToSync) {
        const budget = budgetMap.get(campaign.campaign_budget) || null;
        const customerIdFromResource = this.extractCustomerId(
          campaign.resource_name,
        );
        const geoTargets = locationMap.get(campaign.id.toString()) ?? {
          include: [],
          exclude: [],
        };
        const languages = languageMap.get(campaign.id.toString()) ?? [];
        const campaignData = {
          campaign_name: campaign.name || `Campaign ${campaign.id}`,
          customer_account_id: customerIdFromResource,

          status: CampaignStatusMap[campaign.status ?? 3] ?? 'PAUSED',
          serving_status:
            GoogleServingStatusMap[campaign.serving_status] ?? 'NONE',
          advertising_channel_type:
            GoogleAdvertisingChannelTypeMap[
              campaign.advertising_channel_type
            ] ?? 'UNSPECIFIED',

          bidding_strategy_type:
            BiddingStrategyTypeMap[campaign.bidding_strategy_type] ?? null,
          bidding_strategy_system_status:
            BiddingStrategySystemStatusMap[
              campaign.bidding_strategy_system_status
            ] ?? 'UNKNOWN',

          payment_mode: PaymentModeMap[campaign.payment_mode] ?? 'UNSPECIFIED',

          primary_status:
            GoogleCampaignPrimaryStatusMap[campaign.primary_status] ??
            'UNSPECIFIED',
          primary_status_reasons: campaign.primary_status_reasons || [],

          campaign_budget: budget
            ? {
                resourceName: budget.resource_name,
                amount_micros: budget.amount_micros
                  ? Number(budget.amount_micros)
                  : null,
                delivery_method:
                  GoogleBudgetDeliveryMethodMap[budget.delivery_method] ??
                  'STANDARD',
              }
            : Prisma.JsonNull,

          network_settings: {
            targetGoogleSearch:
              campaign.network_settings?.target_google_search ?? false,
            targetSearchNetwork:
              campaign.network_settings?.target_search_network ?? false,
            targetContentNetwork:
              campaign.network_settings?.target_content_network ?? false,
            targetPartnerSearchNetwork:
              campaign.network_settings?.target_partner_search_network ?? false,
          },

          geo_target_type_setting: {
            positiveGeoTargetType:
              GoogleGeoTargetTypeMap[
                campaign.geo_target_type_setting?.positive_geo_target_type
              ] ?? 'PRESENCE_OR_INTEREST',
            negativeGeoTargetType:
              GoogleGeoTargetTypeMap[
                campaign.geo_target_type_setting?.negative_geo_target_type
              ] ?? 'PRESENCE_OR_INTEREST',
          },

          geo_targets: geoTargets,
          languages: { include: languages, exclude: [] },

          start_date: campaign.start_date
            ? new Date(campaign.start_date)
            : null,
          end_date: campaign.end_date ? new Date(campaign.end_date) : null,

          data: campaign,
        };

        await this.prisma.googleCampaign.upsert({
          where: { campaign_id: campaign.id.toString() },
          create: {
            ...campaignData,
            campaign_id: campaign.id.toString(),
            platform_id: platform.platform_id,
          },
          update: {
            ...campaignData,
            updated_at: new Date(),
          },
        });

        // Sync ad groups for this campaign
        await this.limiter.schedule(() =>
          this.fetchAndSyncGoogleAdGroups(
            googleAccountId,
            customerId,
            campaign.resource_name,
            campaign.id.toString(),
          ),
        );
      }

      this.logger.log(
        `Synced ${campaignsToSync.length} campaigns for customer ${customerId}`,
      );
    } catch (error: any) {
      this.logger.error(
        `Failed to fetch campaigns for customer ${customerId}: ${JSON.stringify(error, null, 2)}`,
        error.stack || 'No stack trace available',
      );
      if (error.response?.status === 401) {
        throw new UnauthorizedException('Invalid or expired access token');
      }
      if (error.response?.status === 403) {
        throw new ForbiddenException('Missing required scopes (adwords)');
      }
      if (error.response?.status === 429) {
        throw new Error('Rate limit exceeded');
      }
      throw new InternalServerErrorException(
        `Failed to fetch and sync Google campaigns: ${error.message || 'Unknown error'}`,
      );
    }
  }

  /**
   * Fetches and syncs ad groups for a specific campaign
   */
  async fetchAndSyncGoogleAdGroups(
    googleAccountId: string,
    customerId: string,
    campaignResourceName: string,
    campaignId: string,
  ): Promise<void> {
    this.logger.log(`Fetching ad groups for campaign: ${campaignResourceName}`);

    const creds = await this.googleService.getGoogleCredentials();
    const platform = await this.prisma.marketingPlatform.findFirst({
      where: { orgId: 'single-org', platform_name: 'Google' },
    });
    if (!platform) {
      throw new InternalServerErrorException(
        'Google marketing platform not found',
      );
    }

    const platformCreds = await this.prisma.platformCredentials.findFirst({
      where: { platform_id: platform.platform_id, type: 'AUTH', user_id: null },
    });
    if (!platformCreds || !platformCreds.refresh_token) {
      throw new ForbiddenException(
        'No valid Google platform credentials found',
      );
    }

    const client = new GoogleAdsApi({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      developer_token: creds.developerToken,
    });

    const customer = client.Customer({
      customer_id: customerId,
      refresh_token: platformCreds.refresh_token!,
      login_customer_id: googleAccountId,
    });

    try {
      // Fetch existing ad groups from database
      const existingAdGroups = await this.prisma.googleAdGroup.findMany({
        where: { campaign_id: campaignId },
        select: { ad_group_id: true, updated_at: true },
      });
      const existingAdGroupMap = new Map(
        existingAdGroups.map((a) => [a.ad_group_id, a.updated_at]),
      );

      // GAQL query to fetch ad groups
      const adGroupResponse = await customer.query(`
        SELECT 
          ad_group.id,
          ad_group.resource_name,
          ad_group.name,
          ad_group.status,
          ad_group.ad_rotation_mode,
          ad_group.cpc_bid_micros,
          ad_group.cpm_bid_micros,
          ad_group.target_cpa_micros,
          ad_group.target_cpm_micros
        FROM ad_group
        WHERE ad_group.campaign = '${campaignResourceName}'
          AND ad_group.status IN (ENABLED, PAUSED)
      `);

      const adGroups: any[] = [];
      for await (const row of adGroupResponse) {
        adGroups.push(row.ad_group);
      }

      this.logger.log(
        `Fetched ${adGroups.length} ad groups for campaign ${campaignResourceName}`,
      );

      const adGroupsToSync = adGroups.filter((adGroup) => {
        const dbUpdatedAt = existingAdGroupMap.get(adGroup.id.toString());
        const needsUpdate =
          !dbUpdatedAt || new Date(adGroup.last_modified_time) > dbUpdatedAt;
        if (needsUpdate) {
          this.logger.debug(
            `AdGroup ${adGroup.id} needs sync: DB updatedAt=${dbUpdatedAt}, API lastModified=${adGroup.last_modified_time}`,
          );
        }
        return needsUpdate;
      });

      if (adGroupsToSync.length === 0) {
        this.logger.log(
          `No ad groups need syncing for campaign ${campaignResourceName}`,
        );
        return;
      }

      // Save ad groups
      for (const adGroup of adGroupsToSync) {
        await this.prisma.googleAdGroup.upsert({
          where: { ad_group_id: adGroup.id.toString() },
          create: {
            ad_group_id: adGroup.id.toString(),
            campaign_id: campaignId,
            name: adGroup.name || `AdGroup ${adGroup.id}`,
            status: CampaignStatusMap[adGroup.status] ?? 'PAUSED',
            ad_rotation_mode:
              GoogleAdGroupRotationMap[adGroup.ad_rotation_mode],
            cpc_bid_micros: adGroup.cpc_bid_micros
              ? Number(adGroup.cpc_bid_micros)
              : null,
            cpm_bid_micros: adGroup.cpm_bid_micros
              ? Number(adGroup.cpm_bid_micros)
              : null,
            target_cpa_micros: adGroup.target_cpa_micros
              ? Number(adGroup.target_cpa_micros)
              : null,
            target_cpm_micros: adGroup.target_cpm_micros
              ? Number(adGroup.target_cpm_micros)
              : null,
            data: adGroup,
          },
          update: {
            name: adGroup.name || `AdGroup ${adGroup.id}`,
            status: CampaignStatusMap[adGroup.status],
            ad_rotation_mode:
              GoogleAdGroupRotationMap[adGroup.ad_rotation_mode],
            cpc_bid_micros: adGroup.cpc_bid_micros
              ? Number(adGroup.cpc_bid_micros)
              : null,
            cpm_bid_micros: adGroup.cpm_bid_micros
              ? Number(adGroup.cpm_bid_micros)
              : null,
            target_cpa_micros: adGroup.target_cpa_micros
              ? Number(adGroup.target_cpa_micros)
              : null,
            target_cpm_micros: adGroup.target_cpm_micros
              ? Number(adGroup.target_cpm_micros)
              : null,
            data: adGroup,
            updated_at: new Date(),
          },
        });

        // Sync ads for this ad group
        await this.limiter.schedule(() =>
          this.fetchAndSyncGoogleAds(
            googleAccountId,
            customerId,
            adGroup.resource_name,
            adGroup.id.toString(),
          ),
        );
      }

      this.logger.log(
        `Synced ${adGroupsToSync.length} ad groups for campaign ${campaignResourceName}`,
      );
    } catch (error: any) {
      this.logger.error(
        `Failed to fetch ad groups for campaign ${campaignResourceName}: ${error.message}`,
        error.stack,
      );
      throw new InternalServerErrorException(
        'Failed to fetch and sync Google ad groups',
      );
    }
  }

  /**
   * Fetches and syncs ads for a specific ad group
   */
  async fetchAndSyncGoogleAds(
    googleAccountId: string,
    customerId: string,
    adGroupResourceName: string,
    adGroupId: string,
  ): Promise<void> {
    this.logger.log(`Fetching ads for ad group: ${adGroupResourceName}`);

    const creds = await this.googleService.getGoogleCredentials();
    const platform = await this.prisma.marketingPlatform.findFirst({
      where: { orgId: 'single-org', platform_name: 'Google' },
    });
    if (!platform) {
      throw new InternalServerErrorException(
        'Google marketing platform not found',
      );
    }

    const platformCreds = await this.prisma.platformCredentials.findFirst({
      where: { platform_id: platform.platform_id, type: 'AUTH', user_id: null },
    });
    if (!platformCreds || !platformCreds.refresh_token) {
      throw new ForbiddenException(
        'No valid Google platform credentials found',
      );
    }

    const client = new GoogleAdsApi({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      developer_token: creds.developerToken,
    });

    const customer = client.Customer({
      customer_id: customerId,
      refresh_token: platformCreds.refresh_token,
      login_customer_id: googleAccountId,
    });

    try {
      // Fetch existing ads from database
      const existingAds = await this.prisma.googleAd.findMany({
        where: { ad_group_id: adGroupId },
        select: { ad_id: true, updated_at: true },
      });
      const existingAdMap = new Map(
        existingAds.map((a) => [a.ad_id, a.updated_at]),
      );

      // GAQL query to fetch ads
      const adResponse = await customer.query(`
        SELECT 
          ad_group_ad.ad.id,
          ad_group_ad.ad.resource_name,
          ad_group_ad.status,
          ad_group_ad.ad.type,
          ad_group_ad.ad.responsive_search_ad,
          ad_group_ad.ad.expanded_text_ad,
          ad_group_ad.ad.responsive_display_ad,
          ad_group_ad.ad.video_ad,
          ad_group_ad.ad.shopping_product_ad
        FROM ad_group_ad
        WHERE ad_group_ad.ad_group = '${adGroupResourceName}'
          AND ad_group_ad.status IN (ENABLED, PAUSED)
      `);

      const ads: any[] = [];
      for await (const row of adResponse) {
        ads.push(row.ad_group_ad);
      }

      this.logger.log(
        `Fetched ${ads.length} ads for ad group ${adGroupResourceName}`,
      );

      const adsToSync = ads.filter((ad) => {
        const dbUpdatedAt = existingAdMap.get(ad.ad.id.toString());
        const needsUpdate =
          !dbUpdatedAt || new Date(ad.last_modified_time) > dbUpdatedAt;
        if (needsUpdate) {
          this.logger.debug(
            `Ad ${ad.ad.id} needs sync: DB updatedAt=${dbUpdatedAt}, API lastModified=${ad.last_modified_time}`,
          );
        }
        return needsUpdate;
      });

      if (adsToSync.length === 0) {
        this.logger.log(
          `No ads need syncing for ad group ${adGroupResourceName}`,
        );
        return;
      }

      // Save ads
      for (const ad of adsToSync) {
        const adContent =
          ad.ad.responsive_search_ad ||
          ad.ad.expanded_text_ad ||
          ad.ad.responsive_display_ad ||
          ad.ad.video_ad ||
          ad.ad.shopping_product_ad ||
          {};
        await this.prisma.googleAd.upsert({
          where: { ad_id: ad.ad.id.toString() },
          create: {
            ad_id: ad.ad.id.toString(),
            ad_group_id: adGroupId,
            status: ad.status as GoogleAdStatus,
            ad_type: ad.ad.type,
            ad_content: adContent,
            data: ad.ad,
          },
          update: {
            status: ad.status as GoogleAdStatus,
            ad_type: ad.ad.type,
            ad_content: adContent,
            data: ad.ad,
            updated_at: new Date(),
          },
        });
      }

      this.logger.log(
        `Synced ${adsToSync.length} ads for ad group ${adGroupResourceName}`,
      );
    } catch (error: any) {
      this.logger.error(
        `Failed to fetch ads for ad group ${adGroupResourceName}: ${error.message}`,
        error.stack,
      );
      throw new InternalServerErrorException(
        'Failed to fetch and sync Google ads',
      );
    }
  }

  /**
   * Retrieves all campaigns with their ad groups and ads for an organization
   */
  async listCampaignsWithAdGroupsAndAds() {
    // Fetch campaigns with only the specified fields
    const campaigns = await this.prisma.googleCampaign.findMany({
      select: {
        campaign_id: true,
        campaign_name: true,
        status: true,
        start_date: true,
        end_date: true,
        serving_status: true,
      },
    });

    this.logger.log(`Retrieved ${campaigns.length} campaigns`);

    return {
      message: 'Campaigns retrieved successfully',
      campaigns: campaigns.map((campaign) => ({
        campaign_id: campaign.campaign_id,
        campaign_name: campaign.campaign_name,
        status: campaign.status,
        start_date: campaign.start_date,
        end_date: campaign.end_date,
        serving_status: campaign.serving_status,
      })),
    };
  }
  async getCampaignById(campaignId: string) {
    // Fetch the campaign by ID with ad groups and ads

    const campaign = await this.prisma.googleCampaign.findUnique({
      where: { campaign_id: campaignId },
      include: {
        ad_groups: {
          include: {
            ads: true,
          },
        },
      },
    });

    if (!campaign) {
      this.logger.error(`Campaign with ID ${campaignId} not found`);
      throw new Error(`Campaign with ID ${campaignId} not found`);
    }

    this.logger.log(`Retrieved campaign with ID ${campaignId}`);

    // Fetch Google accounts for client account information
    const googleAccounts = await this.prisma.googleAccount.findMany({
      select: { clientAccounts: true },
    });

    // Find the matching client account
    let clientAccount: any = null;
    for (const account of googleAccounts) {
      const clientAccounts = account.clientAccounts as
        | {
            id: string;
            descriptiveName?: string;
            currencyCode?: string;
            timeZone?: string;
          }[]
        | null;
      if (clientAccounts) {
        const match = clientAccounts.find(
          (ca) => ca.id === campaign.customer_account_id,
        );
        if (match) {
          clientAccount = match;
          break;
        }
      }
    }

    return {
      message: 'Campaign retrieved successfully',
      campaign: {
        campaign_id: campaign.campaign_id,
        campaign_name: campaign.campaign_name,
        customer_account_id: campaign.customer_account_id,
        client_account: clientAccount
          ? {
              id: clientAccount.id,
              descriptiveName: clientAccount.descriptiveName ?? null,
              currencyCode: clientAccount.currencyCode ?? null,
              timeZone: clientAccount.timeZone ?? null,
            }
          : null,
        status: campaign.status,
        serving_status: campaign.serving_status,
        objective_type: campaign.objective_type,
        advertising_channel_type: campaign.advertising_channel_type,
        bidding_strategy_type: campaign.bidding_strategy_type,
        bidding_strategy_system_status: campaign.bidding_strategy_system_status,
        payment_mode: campaign.payment_mode,
        primary_status: campaign.primary_status,
        primary_status_reasons: campaign.primary_status_reasons,
        campaign_budget: campaign.campaign_budget,
        network_settings: campaign.network_settings,
        geo_target_type_setting: campaign.geo_target_type_setting,
        target_cpa_micros: campaign.target_cpa_micros,
        target_roas: campaign.target_roas,
        geo_targets: campaign.geo_targets,
        languages: campaign.languages,
        audience_settings: campaign.audience_settings,
        start_date: campaign.start_date,
        end_date: campaign.end_date,
        created_at: campaign.created_at,
        updated_at: campaign.updated_at,
        ad_groups: campaign.ad_groups.map((adGroup) => ({
          ad_group_id: adGroup.ad_group_id,
          name: adGroup.name,
          status: adGroup.status,
          ad_rotation_mode: adGroup.ad_rotation_mode,
          cpc_bid_micros: adGroup.cpc_bid_micros,
          cpm_bid_micros: adGroup.cpm_bid_micros,
          target_cpa_micros: adGroup.target_cpa_micros,
          target_cpm_micros: adGroup.target_cpm_micros,
          targeting_settings: adGroup.targeting_settings,
          created_at: adGroup.created_at,
          updated_at: adGroup.updated_at,
          ads: adGroup.ads.map((ad) => ({
            ad_id: ad.ad_id,
            status: ad.status,
            ad_type: ad.ad_type,
            ad_content: ad.ad_content,
            created_at: ad.created_at,
            updated_at: ad.updated_at,
          })),
        })),
      },
    };
  }

  
  async createCampaignWithBudget(
    formData: GoogleAdsFormData,
    orgId: string,
  ): Promise<string> {
    const { customerAccountId } = formData;

    this.logger.log(`Creating campaign for customer: ${customerAccountId}`);
    this.logger.log('formData', formData);

    // Get credentials
    const creds = await this.googleService.getGoogleCredentials();

    const platform = await this.prisma.marketingPlatform.findFirst({
      where: { orgId, platform_name: 'Google' },
    });
    if (!platform) {
      this.logger.error('Google marketing platform not found');
      throw new InternalServerErrorException(
        'Google marketing platform not found',
      );
    }
    this.logger.log(`Found platform: platform_id=${platform.platform_id}`);

    const platformCreds = await this.prisma.platformCredentials.findFirst({
      where: {
        type: 'AUTH',
        user_id: null,
        platform_id: platform.platform_id,
      },
    });
    if (!platformCreds || !platformCreds.refresh_token) {
      this.logger.error('No valid Google platform credentials found');
      throw new ForbiddenException(
        'No valid Google platform credentials found',
      );
    }

    const googleAccount = await this.prisma.googleAccount.findFirst({
      where: { orgId },
    });
    if (!googleAccount || !googleAccount.mccId) {
      this.logger.error('Google account or MCC ID not found');
      throw new InternalServerErrorException(
        'Google account or MCC ID not found',
      );
    }

    // Get valid access token
    const accessToken = await this.googleService.getValidAccessToken(
      creds.clientId,
      creds.clientSecret,
      platformCreds.refresh_token,
      platform.platform_id,
    );

    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'developer-token': creds.developerToken,
      'login-customer-id': googleAccount.mccId,
      'Content-Type': 'application/json',
    };

    // ----------------------------
    // STEP 1: Handle Budget
    // ----------------------------
    let budgetResourceName: string;

    if (
      formData.budgetOption === 'SELECT_EXISTING' &&
      formData.existingBudgetId
    ) {
      budgetResourceName = ResourceNames.campaignBudget(
        customerAccountId,
        formData.existingBudgetId,
      );
      this.logger.log(`Using existing budget: ${budgetResourceName}`);
    } else {
      const budgetEndpoint = `https://googleads.googleapis.com/v20/customers/${customerAccountId}/campaignBudgets:mutate`;
      const budgetOperation = {
        create: {
          name: formData.newBudget?.name || `Budget-${Date.now()}`,
          delivery_method:
            enums.BudgetDeliveryMethod[
              formData.newBudget?.deliveryMethod || 'STANDARD'
            ],
          amount_micros: toMicros(Number(formData.newBudget?.amount ?? '1')),
          explicitly_shared: formData.newBudget?.explicitly_shared || false
        },
      };

      this.logger.log(
        `Creating budget with operation: ${JSON.stringify(budgetOperation)}`,
      );

      try {
        const response = await axios.post<any>(
          budgetEndpoint,
          { operations: [budgetOperation] },
          { headers },
        );
        this.logger.log(
          `Budget creation response: ${JSON.stringify(response.data)}`,
        );

        if (response.status !== 200) {
          throw new Error(
            `Budget creation failed with status ${response.status}`,
          );
        }

        budgetResourceName = response.data.results[0].resourceName;
        this.logger.log(`Created budget: ${budgetResourceName}`);
      } catch (error: any) {
        this.logger.error(`Budget creation failed: ${error.message}`, {
          stack: error.stack,
          details: JSON.stringify(error.response?.data || {}),
          request_id: error.response?.data?.requestId || 'N/A',
        });
        throw new InternalServerErrorException(
          'Failed to create campaign budget',
        );
      }
    }

    // ----------------------------
    // STEP 2: Build and Create Campaign
    // ----------------------------
    const tempCampaignResourceName = ResourceNames.campaign(
      customerAccountId,
      '-1',
    );

    const campaign: resources.ICampaign = {
      
      name: formData.name,
      advertising_channel_type:
        formData.advertisingChannelType as GoogleAdvertisingChannelType,
      campaign_budget: budgetResourceName,
      status: formData.status as GoogleCampaignStatus,
      network_settings: {
        target_google_search: formData.networkSettings.targetGoogleSearch,
        target_search_network: formData.networkSettings.targetSearchNetwork,
        target_content_network: formData.networkSettings.targetContentNetwork,
        target_partner_search_network:
          formData.networkSettings.targetPartnerSearchNetwork,
        target_youtube: formData.networkSettings.targetYoutube,
        target_google_tv_network:
          formData.networkSettings.targetGoogleTvNetwork,
      },
      geo_target_type_setting: {
      positive_geo_target_type: 'PRESENCE_OR_INTEREST',
      negative_geo_target_type: 'PRESENCE',
    },
      start_date: formData.runSchedule.start
        ? this.formatDate(formData.runSchedule.start)
        : undefined,
      end_date: formData.runSchedule.end
        ? this.formatDate(formData.runSchedule.end)
        : undefined,
    };

    campaign.bidding_strategy_type = formData.biddingStrategyType as any | undefined;
  let biddingStrategyResourceName: string | undefined;
  if (['TARGET_CPA', 'TARGET_ROAS'].includes(formData.biddingStrategyType as any)) {
    const biddingStrategyEndpoint = `https://googleads.googleapis.com/v20/customers/${customerAccountId}/biddingStrategies:mutate`;
    const biddingStrategyOperation = {
      create: {
        name: `${formData.biddingStrategyType} Strategy for ${formData.name}`,
        bidding_strategy_type: formData.biddingStrategyType,
        ...(formData.biddingStrategyType === 'TARGET_CPA'
          ? { target_cpa: { target_cpa_micros: toMicros(Number(formData.targetCpa || '1')) } }
          : { target_roas: { target_roas: Number(formData.targetRoas || '1') } }),
      },
    };

    try {
      const response = await axios.post<any>(biddingStrategyEndpoint, { operations: [biddingStrategyOperation] }, { headers });
      this.logger.log(`Bidding strategy creation response: ${JSON.stringify(response.data)}`);
      if (response.status !== 200) {
        throw new Error(`Bidding strategy creation failed with status ${response.status}`);
      }
      biddingStrategyResourceName = response.data.results[0].resourceName;
      this.logger.log(`Created bidding strategy: ${biddingStrategyResourceName}`);
    } catch (error: any) {
      this.logger.error(`Bidding strategy creation failed: ${error.message}`, {
        stack: error.stack,
        details: JSON.stringify(error.response?.data || {}),
        request_id: error.response?.data?.requestId || 'N/A',
      });
      throw new InternalServerErrorException('Failed to create bidding strategy');
    }
  }

  switch (formData.biddingStrategyType) {
    case 'MANUAL_CPC':
      campaign.manual_cpc = { enhanced_cpc_enabled: true };
      break;
    case 'MANUAL_CPM':
      campaign.manual_cpm = {};
      break;
    case 'MANUAL_CPV':
      campaign.manual_cpv = {};
      break;
    case 'MAXIMIZE_CONVERSIONS':
      campaign.maximize_conversions = {};
      break;
    case 'MAXIMIZE_CONVERSION_VALUE':
      campaign.maximize_conversion_value = {};
      break;
    case 'TARGET_CPA':
      campaign.bidding_strategy = biddingStrategyResourceName;
      break;
    case 'TARGET_ROAS':
      campaign.bidding_strategy = biddingStrategyResourceName;
      break;
    case 'TARGET_CPM':
      campaign.target_cpm = {};
      break;
    case 'TARGET_IMPRESSION_SHARE':
      campaign.target_impression_share = {
        location: 'ANYWHERE_ON_PAGE',
      };
      break;
    default:
      this.logger.error(`Unsupported bidding strategy: ${formData.biddingStrategyType}`);
      throw new InternalServerErrorException(`Unsupported bidding strategy: ${formData.biddingStrategyType}`);
  }
  this.logger.log(`Set bidding strategy: ${formData.biddingStrategyType}`);

    const campaignEndpoint = `https://googleads.googleapis.com/v20/customers/${customerAccountId}/campaigns:mutate`;
    const campaignOperation = { create: campaign };

    this.logger.log(
      `Creating campaign with operation: ${JSON.stringify(campaignOperation)}`,
    );

    let campaignResourceName: string;
    try {
      const response = await axios.post<any>(
        campaignEndpoint,
        { operations: [campaignOperation] },
        { headers },
      );
      this.logger.log(
        `Campaign creation response: ${JSON.stringify(response.data)}`,
      );

      if (response.status !== 200) {
        throw new Error(
          `Campaign creation failed with status ${response.status}`,
        );
      }

      campaignResourceName = response.data.results[0].resourceName;
      this.logger.log(`Created campaign: ${campaignResourceName}`);
    } catch (error: any) {
      this.logger.error(`Campaign creation failed: ${error.message}`, {
        stack: error.stack,
        details: JSON.stringify(error.response?.data || {}),
        request_id: error.response?.data?.requestId || 'N/A',
      });
      throw new InternalServerErrorException('Failed to create campaign');
    }

    // ----------------------------
    // STEP 3: Add Targeting Criteria
    // ----------------------------
    const criteriaEndpoint = `https://googleads.googleapis.com/v20/customers/${customerAccountId}/campaignCriteria:mutate`;
    const criteriaOperations: any[] = [];

    // Add geo target criteria (positive and negative)
    formData.geoTargets.include.forEach((target) => {
      criteriaOperations.push({
        create: {
          campaign: campaignResourceName,
          type: enums.CriterionType.LOCATION,
          location: {
            geo_target_constant: `geoTargetConstants/${target.value}`,
          },
        },
      });
      this.logger.log(
        `Added GEO criterion (positive): ${JSON.stringify(criteriaOperations[criteriaOperations.length - 1])}`,
      );
    });

    formData.geoTargets.exclude.forEach((target) => {
      criteriaOperations.push({
        create: {
          campaign: campaignResourceName,
          type: enums.CriterionType.LOCATION,
          location: {
            geo_target_constant: `geoTargetConstants/${target.value}`,
          },
          negative: true,
        },
      });
      this.logger.log(
        `Added GEO criterion (negative): ${JSON.stringify(criteriaOperations[criteriaOperations.length - 1])}`,
      );
    });

    // Add language criteria (no exclusions, as specified)
    formData.languages.include.forEach((target) => {
      criteriaOperations.push({
        create: {
          campaign: campaignResourceName,
          type: enums.CriterionType.LANGUAGE,
          language: { language_constant: `languageConstants/${target.value}` },
        },
      });
      this.logger.log(
        `Added LANGUAGE criterion: ${JSON.stringify(criteriaOperations[criteriaOperations.length - 1])}`,
      );
    });

    if (criteriaOperations.length > 0) {
      try {
        const response = await axios.post(
          criteriaEndpoint,
          { operations: criteriaOperations },
          { headers },
        );
        this.logger.log(
          `Criteria creation response: ${JSON.stringify(response.data)}`,
        );

        if (response.status !== 200) {
          throw new Error(
            `Criteria creation failed with status ${response.status}`,
          );
        }

        this.logger.log(
          `Created ${criteriaOperations.length} campaign criteria`,
        );
      } catch (error: any) {
        this.logger.error(`Criteria creation failed: ${error.message}`, {
          stack: error.stack,
          details: JSON.stringify(error.response?.data || {}),
          request_id: error.response?.data?.requestId || 'N/A',
        });
        throw new InternalServerErrorException(
          'Failed to create campaign criteria',
        );
      }
    } else {
      this.logger.log('No targeting criteria to create');
    }

    const campaignId = campaignResourceName.split('/').pop() ?? '';
    if (!campaignId) {
      throw new InternalServerErrorException(
        'Failed to extract campaign ID from resource name',
      );
    }
    this.logger.log('objective type', formData.objectiveType);
    const campaignData = {
      campaign_id: campaignId,
      campaign_name: formData.name,
      customer_account_id: customerAccountId,
      platform_id: platform.platform_id,
      status: CampaignStatusMap[campaign.status ?? 'PAUSED'] ?? 'PAUSED',
      serving_status: GoogleServingStatusMap[3] ?? 'SERVING',
      objective_type: (formData.objectiveType as GoogleObjectiveType) ?? null,
      advertising_channel_type:
        GoogleAdvertisingChannelTypeMap[
          enums.AdvertisingChannelType[formData.advertisingChannelType]
        ] ?? 'UNSPECIFIED',
      bidding_strategy_type:
        BiddingStrategyTypeMap[
          enums.BiddingStrategyType[
            formData.biddingStrategyType || 'MANUAL_CPC'
          ]
        ] ?? 'MANUAL_CPC',
      bidding_strategy_system_status: 'ENABLED',
      payment_mode:
        formData.biddingStrategyType === 'TARGET_CPA'
          ? PaymentMode.CONVERSIONS
          : PaymentMode.CLICKS,
      primary_status:
        GoogleCampaignPrimaryStatusMap[enums.CampaignPrimaryStatus.ELIGIBLE] ??
        'ELIGIBLE',
      primary_status_reasons: [],
      campaign_budget: {
        resourceName: budgetResourceName,
        amount_micros:
          formData.budgetOption === 'SELECT_EXISTING'
            ? null
            : toMicros(Number(formData.newBudget?.amount ?? '1')),
        delivery_method: formData.newBudget?.deliveryMethod ?? 'STANDARD',
        explicitly_shared: formData.newBudget?.explicitly_shared ?? false
      },
      network_settings: {
        targetGoogleSearch: formData.networkSettings.targetGoogleSearch,
        targetSearchNetwork: formData.networkSettings.targetSearchNetwork,
        targetContentNetwork: formData.networkSettings.targetContentNetwork,
        targetPartnerSearchNetwork: false,
      },
      geo_target_type_setting: {
        positiveGeoTargetType: 'PRESENCE_OR_INTEREST',
        negativeGeoTargetType: 'PRESENCE_OR_INTEREST',
      },
      geo_targets: {
        include: formData.geoTargets.include,
        exclude: formData.geoTargets.exclude,
      },
      languages: {
        include: formData.languages.include,
        exclude: formData.languages.exclude,
      },
      target_cpa_micros:
        formData.biddingStrategyType === 'TARGET_CPA'
          ? toMicros(Number(formData.targetCpa || 1))
          : null,
      target_roas:
        formData.biddingStrategyType === 'TARGET_ROAS'
          ? Number(formData.targetRoas || 1)
          : null,
      start_date: formData.runSchedule.start
        ? new Date(formData.runSchedule.start)
        : null,
      end_date: formData.runSchedule.end
        ? new Date(formData.runSchedule.end)
        : null,
      data: JSON.stringify({
        ...campaign,
        resource_name: campaignResourceName,
      }),
    };
    this.logger.log('objective type after', campaignData.objective_type);

    try {
      await this.prisma.googleCampaign.upsert({
        where: { campaign_id: campaignId },
        create: {
          ...{ ...campaignData, platform_id: undefined },
          platform: {
            connect: { platform_id: platform.platform_id },
          },
        },
        update: {
          ...{ ...campaignData, platform_id: undefined },
          platform: {
            connect: { platform_id: platform.platform_id },
          },
          updated_at: new Date(),
        },
      });
      this.logger.log(`Saved campaign ${campaignId} to database`);
    } catch (error: any) {
      this.logger.error(`Database save failed: ${error.message}`, {
        stack: error.stack,
        code: error.code, // Log Prisma error code
      });
      throw new InternalServerErrorException(
        `Failed to save campaign to database: ${error.message}`,
      );
    }

    this.logger.log(`Created campaign: ${campaignResourceName}`);
    return campaignResourceName;
  }

  private formatDate(ms: number): string {
    return new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
  }

async updateCampaign(
  campaignId: string,
  customerAccountId: string,
  formData: Partial<GoogleAdsFormData>,
  orgId: string,
): Promise<string> {
  this.logger.log(`Updating campaign ${campaignId} for customer: ${customerAccountId}`);
  this.logger.debug(`Update data: ${JSON.stringify(formData, null, 2)}`);

  // Get credentials and platform details
  const creds = await this.googleService.getGoogleCredentials();
  const platform = await this.prisma.marketingPlatform.findFirst({
    where: { orgId, platform_name: 'Google' },
  });
  if (!platform) {
    this.logger.error('Google marketing platform not found');
    throw new InternalServerErrorException('Google marketing platform not found');
  }

  const platformCreds = await this.prisma.platformCredentials.findFirst({
    where: { type: 'AUTH', user_id: null, platform_id: platform.platform_id },
  });
  if (!platformCreds || !platformCreds.refresh_token) {
    this.logger.error('No valid Google platform credentials found');
    throw new ForbiddenException('No valid Google platform credentials found');
  }

  const googleAccount = await this.prisma.googleAccount.findFirst({
    where: { orgId },
  });
  if (!googleAccount || !googleAccount.mccId) {
    this.logger.error('Google account or MCC ID not found');
    throw new InternalServerErrorException('Google account or MCC ID not found');
  }

  // Get valid access token
  const accessToken = await this.googleService.getValidAccessToken(
    creds.clientId,
    creds.clientSecret,
    platformCreds.refresh_token,
    platform.platform_id,
  );

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'developer-token': creds.developerToken,
    'login-customer-id': googleAccount.mccId,
    'Content-Type': 'application/json',
  };

  const campaignResourceName = ResourceNames.campaign(customerAccountId, campaignId);

  // Fetch existing campaign data from database for merging
  const existingCampaign = await this.prisma.googleCampaign.findUnique({
    where: { campaign_id: campaignId },
  });
  if (!existingCampaign) {
    this.logger.error(`Campaign with ID ${campaignId} not found in database`);
    throw new Error(`Campaign with ID ${campaignId} not found`);
  }

  // Define interface for campaign_budget to fix type errors
  interface CampaignBudget {
    resourceName: string;
    amount_micros?: number;
    delivery_method?: string;
    explicitly_shared?: boolean;
  }

  // Safely access campaign_budget
  const campaignBudget = existingCampaign.campaign_budget as CampaignBudget | null;
  let budgetResourceName = campaignBudget?.resourceName;

  // ----------------------------
  // STEP 1: Handle Budget
  // ----------------------------
  if (formData.budgetOption) {
    if (formData.budgetOption === 'SELECT_EXISTING' && formData.existingBudgetId) {
      budgetResourceName = ResourceNames.campaignBudget(customerAccountId, formData.existingBudgetId);
      this.logger.log(`Using existing budget: ${budgetResourceName}`);
    } else if (formData.budgetOption === 'CREATE_NEW' && formData.newBudget) {
      const budgetEndpoint = `https://googleads.googleapis.com/v20/customers/${customerAccountId}/campaignBudgets:mutate`;
      const budgetOperation = {
        create: {
          name: formData.newBudget.name || `Budget-${Date.now()}`,
          delivery_method: enums.BudgetDeliveryMethod[formData.newBudget.deliveryMethod || 'STANDARD'],
          amount_micros: toMicros(Number(formData.newBudget.amount)),
          explicitly_shared: formData.newBudget.explicitly_shared || false,
        },
      };

      this.logger.log(`Creating new budget with operation: ${JSON.stringify(budgetOperation)}`);

      try {
        const response = await axios.post<any>(
          budgetEndpoint,
          { operations: [budgetOperation] },
          { headers },
        );
        if (response.status !== 200) {
          throw new Error(`Budget creation failed with status ${response.status}`);
        }
        budgetResourceName = response.data.results[0].resourceName;
        this.logger.log(`Created new budget: ${budgetResourceName}`);
      } catch (error: any) {
        this.logger.error(`Budget creation failed: ${error.message}`, {
          stack: error.stack,
          details: JSON.stringify(error.response?.data || {}),
        });
        throw new InternalServerErrorException('Failed to create campaign budget');
      }
    }
  }

  // ----------------------------
  // STEP 2: Handle Bidding Strategy
  // ----------------------------
  // Fix: Use bidding_strategy_type instead of bidding_strategy
  let biddingStrategyResourceName: string | undefined = undefined; // Assume no bidding strategy unless created
  if (formData.biddingStrategyType) {
    if (['TARGET_CPA', 'TARGET_ROAS'].includes(formData.biddingStrategyType)) {
      const biddingStrategyEndpoint = `https://googleads.googleapis.com/v20/customers/${customerAccountId}/biddingStrategies:mutate`;
      const biddingStrategyOperation = {
        create: {
          name: `${formData.biddingStrategyType} Strategy for ${formData.name || existingCampaign.campaign_name}`,
          bidding_strategy_type: formData.biddingStrategyType,
          ...(formData.biddingStrategyType === 'TARGET_CPA' && formData.targetCpa
            ? { target_cpa: { target_cpa_micros: toMicros(Number(formData.targetCpa)) } }
            : formData.biddingStrategyType === 'TARGET_ROAS' && formData.targetRoas
            ? { target_roas: { target_roas: Number(formData.targetRoas) } }
            : {}),
        },
      };

      try {
        const response = await axios.post<any>(
          biddingStrategyEndpoint,
          { operations: [biddingStrategyOperation] },
          { headers },
        );
        if (response.status !== 200) {
          throw new Error(`Bidding strategy creation failed with status ${response.status}`);
        }
        biddingStrategyResourceName = response.data.results[0].resourceName;
        this.logger.log(`Created/Updated bidding strategy: ${biddingStrategyResourceName}`);
      } catch (error: any) {
        this.logger.error(`Bidding strategy creation failed: ${error.message}`, {
          stack: error.stack,
          details: JSON.stringify(error.response?.data || {}),
        });
        throw new InternalServerErrorException('Failed to create bidding strategy');
      }
    }
  }

  // ----------------------------
  // STEP 3: Build Campaign Update Operation
  // ----------------------------
  const campaign: Partial<resources.ICampaign> = {
    resource_name: campaignResourceName,
    ...(formData.name && { name: formData.name }),
    ...(formData.status && { status: formData.status as GoogleCampaignStatus }),
    ...(formData.advertisingChannelType && {
      advertising_channel_type: formData.advertisingChannelType as GoogleAdvertisingChannelType,
    }),
    ...(budgetResourceName && { campaign_budget: budgetResourceName }),
    ...(formData.networkSettings && {
      network_settings: {
        target_google_search: formData.networkSettings.targetGoogleSearch,
        target_search_network: formData.networkSettings.targetSearchNetwork,
        target_content_network: formData.networkSettings.targetContentNetwork,
        target_partner_search_network: formData.networkSettings.targetPartnerSearchNetwork,
        target_youtube: formData.networkSettings.targetYoutube,
        target_google_tv_network: formData.networkSettings.targetGoogleTvNetwork,
      },
    }),
    ...(formData.runSchedule?.start && {
      start_date: this.formatDate(formData.runSchedule.start),
    }),
    ...(formData.runSchedule?.end && {
      end_date: this.formatDate(formData.runSchedule.end),
    }),
  };

  if (formData.biddingStrategyType) {
    campaign.bidding_strategy_type = formData.biddingStrategyType as any;
    switch (formData.biddingStrategyType) {
      case 'MANUAL_CPC':
        campaign.manual_cpc = { enhanced_cpc_enabled: true };
        break;
      case 'MANUAL_CPM':
        campaign.manual_cpm = {};
        break;
      case 'MANUAL_CPV':
        campaign.manual_cpv = {};
        break;
      case 'MAXIMIZE_CONVERSIONS':
        campaign.maximize_conversions = {};
        break;
      case 'MAXIMIZE_CONVERSION_VALUE':
        campaign.maximize_conversion_value = {};
        break;
      case 'TARGET_CPA':
        campaign.bidding_strategy = biddingStrategyResourceName;
        break;
      case 'TARGET_ROAS':
        campaign.bidding_strategy = biddingStrategyResourceName;
        break;
      case 'TARGET_CPM':
        campaign.target_cpm = {};
        break;
      case 'TARGET_IMPRESSION_SHARE':
        campaign.target_impression_share = { location: 'ANYWHERE_ON_PAGE' };
        break;
      default:
        this.logger.error(`Unsupported bidding strategy: ${formData.biddingStrategyType}`);
        throw new InternalServerErrorException(`Unsupported bidding strategy: ${formData.biddingStrategyType}`);
    }
  }

  const campaignEndpoint = `https://googleads.googleapis.com/v20/customers/${customerAccountId}/campaigns:mutate`;
  const campaignOperation = {
    update: campaign,
    update_mask: Object.keys(campaign)
      .filter((key) => key !== 'resource_name')
      .join(','),
  };

  this.logger.log(`Updating campaign with operation: ${JSON.stringify(campaignOperation)}`);

  try {
    const response = await axios.post<any>(
      campaignEndpoint,
      { operations: [campaignOperation] },
      { headers },
    );
    if (response.status !== 200) {
      throw new Error(`Campaign update failed with status ${response.status}`);
    }
    this.logger.log(`Updated campaign: ${campaignResourceName}`);
  } catch (error: any) {
    this.logger.error(`Campaign update failed: ${error.message}`, {
      stack: error.stack,
      details: JSON.stringify(error.response?.data || {}),
    });
    throw new InternalServerErrorException('Failed to update campaign');
  }

  // ----------------------------
  // STEP 4: Update Targeting Criteria (Geo and Language)
  // ----------------------------
  if (formData.geoTargets || formData.languages) {
  const criteriaEndpoint = `https://googleads.googleapis.com/v20/customers/${customerAccountId}/campaignCriteria:mutate`;
  const criteriaOperations: { create: any }[] = [];

  // Initialize client for querying criteria
  const client = new GoogleAdsApi({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    developer_token: creds.developerToken,
  }).Customer({
    customer_id: customerAccountId,
    refresh_token: platformCreds.refresh_token,
    login_customer_id: googleAccount.mccId,
  });

  // Step 4.1: Remove existing criteria only for updated types
  const criteriaTypes: string[] = []; // Explicitly type as string[]
  if (formData.geoTargets) criteriaTypes.push('LOCATION');
  if (formData.languages) criteriaTypes.push('LANGUAGE');

  if (criteriaTypes.length > 0) {
    const existingCriteria = await client.query(`
      SELECT campaign_criterion.resource_name
      FROM campaign_criterion
      WHERE campaign_criterion.campaign = '${campaignResourceName}'
        AND campaign_criterion.type IN (${criteriaTypes.map((t) => `'${t}'`).join(',')})
    `);

    const removeOperations: { remove: string }[] = [];
    for await (const row of existingCriteria) {
      if (row.campaign_criterion?.resource_name) {
        removeOperations.push({
          remove: row.campaign_criterion.resource_name,
        });
      }
    }

    if (removeOperations.length > 0) {
      try {
        const response = await axios.post(
          criteriaEndpoint,
          { operations: removeOperations },
          { headers },
        );
        if (response.status !== 200) {
          throw new Error(`Criteria removal failed with status ${response.status}`);
        }
        this.logger.log(`Removed ${removeOperations.length} existing criteria`);
      } catch (error: any) {
        this.logger.error(`Criteria removal failed: ${error.message}`, {
          stack: error.stack,
          details: JSON.stringify(error.response?.data || {}),
        });
        throw new InternalServerErrorException('Failed to remove existing campaign criteria');
      }
    }
  }

  // Step 4.2: Add new geo target criteria
  if (formData.geoTargets) {
    formData.geoTargets.include?.forEach((target) => {
      criteriaOperations.push({
        create: {
          campaign: campaignResourceName,
          type: enums.CriterionType.LOCATION,
          location: { geo_target_constant: `geoTargetConstants/${target.value}` },
        },
      });
    });

    formData.geoTargets.exclude?.forEach((target) => {
      criteriaOperations.push({
        create: {
          campaign: campaignResourceName,
          type: enums.CriterionType.LOCATION,
          location: { geo_target_constant: `geoTargetConstants/${target.value}` },
          negative: true,
        },
      });
    });
  }

  // Step 4.3: Add new language criteria
  if (formData.languages) {
    formData.languages.include?.forEach((target) => {
      criteriaOperations.push({
        create: {
          campaign: campaignResourceName,
          type: enums.CriterionType.LANGUAGE,
          language: { language_constant: `languageConstants/${target.value}` },
        },
      });
    });
    // Note: Excluded languages are not supported in Google Ads API, so we ignore languages.exclude
  }

  // Step 4.4: Apply new criteria
  if (criteriaOperations.length > 0) {
    try {
      const response = await axios.post(
        criteriaEndpoint,
        { operations: criteriaOperations },
        { headers },
      );
      if (response.status !== 200) {
        throw new Error(`Criteria creation failed with status ${response.status}`);
      }
      this.logger.log(`Created ${criteriaOperations.length} new campaign criteria`);
    } catch (error: any) {
      this.logger.error(`Criteria creation failed: ${error.message}`, {
        stack: error.stack,
        details: JSON.stringify(error.response?.data || {}),
      });
      throw new InternalServerErrorException('Failed to create new campaign criteria');
    }
  }
}

// Define interfaces for geo_targets and languages
interface GeoTargets {
  include: { value: string; text: string }[];
  exclude: { value: string; text: string }[];
}

interface Languages {
  include: { value: string; text: string }[];
  exclude: { value: string; text: string }[];
}

// Safely access geo_targets and languages
const geoTargets = existingCampaign.geo_targets as GeoTargets | null;
const languages = existingCampaign.languages as Languages | null;
  // ----------------------------
  // STEP 5: Save Updated Campaign to Database
  // ----------------------------
 const campaignData: Prisma.GoogleCampaignUpdateInput = {
  ...(formData.name && { campaign_name: formData.name }),
  ...(formData.status && { status: formData.status as GoogleCampaignStatus }),
  ...(formData.objectiveType && { objective_type: formData.objectiveType as GoogleObjectiveType }),
  ...(formData.advertisingChannelType && {
    advertising_channel_type: GoogleAdvertisingChannelTypeMap[
      enums.AdvertisingChannelType[formData.advertisingChannelType]
    ] ?? existingCampaign.advertising_channel_type,
  }),
  ...(formData.biddingStrategyType && {
    bidding_strategy_type: BiddingStrategyTypeMap[
      enums.BiddingStrategyType[formData.biddingStrategyType]
    ] ?? existingCampaign.bidding_strategy_type,
  }),
  ...(biddingStrategyResourceName && { bidding_strategy: biddingStrategyResourceName }),
  ...(formData.biddingStrategyType && {
    bidding_strategy_system_status: 'ENABLED',
    payment_mode:
      formData.biddingStrategyType === 'TARGET_CPA'
        ? PaymentMode.CONVERSIONS
        : PaymentMode.CLICKS,
  }),
  ...(budgetResourceName && {
    campaign_budget: {
      resourceName: budgetResourceName,
      amount_micros:
        formData.budgetOption === 'CREATE_NEW' && formData.newBudget
          ? toMicros(Number(formData.newBudget.amount))
          : campaignBudget?.amount_micros ?? null,
      delivery_method:
        formData.budgetOption === 'CREATE_NEW' && formData.newBudget
          ? formData.newBudget.deliveryMethod ?? 'STANDARD'
          : campaignBudget?.delivery_method ?? 'STANDARD',
      explicitly_shared:
        formData.budgetOption === 'CREATE_NEW' && formData.newBudget
          ? formData.newBudget.explicitly_shared ?? false
          : campaignBudget?.explicitly_shared ?? false,
    },
  }),
  ...(formData.networkSettings && {
    network_settings: {
      targetGoogleSearch: formData.networkSettings.targetGoogleSearch,
      targetSearchNetwork: formData.networkSettings.targetSearchNetwork,
      targetContentNetwork: formData.networkSettings.targetContentNetwork,
      targetPartnerSearchNetwork: formData.networkSettings.targetPartnerSearchNetwork,
      targetYoutube: formData.networkSettings.targetYoutube,
      targetGoogleTvNetwork: formData.networkSettings.targetGoogleTvNetwork,
    },
  }),
  ...(formData.geoTargets && {
    geo_targets: {
      include: formData.geoTargets.include ?? geoTargets?.include ?? [],
      exclude: formData.geoTargets.exclude ?? geoTargets?.exclude ?? [],
    },
  }),
  ...(formData.languages && {
    languages: {
      include: formData.languages.include ?? languages?.include ?? [],
      exclude: formData.languages.exclude ?? languages?.exclude ?? [],
    },
  }),
  ...(formData.targetCpa && {
    target_cpa_micros: toMicros(Number(formData.targetCpa)),
  }),
  ...(formData.targetRoas && {
    target_roas: Number(formData.targetRoas),
  }),
  ...(formData.runSchedule?.start && {
    start_date: new Date(formData.runSchedule.start),
  }),
  ...(formData.runSchedule?.end && {
    end_date: new Date(formData.runSchedule.end),
  }),
  updated_at: new Date(),
  data: {
    ...((typeof existingCampaign.data === 'object' && existingCampaign.data !== null
      ? existingCampaign.data
      : {}) as Record<string, any>),
    ...Object.fromEntries(
      Object.entries(campaign).filter(([key]) => key !== 'url_custom_parameters'),
    ),
    resource_name: campaignResourceName,
  },
};

  try {
    await this.prisma.googleCampaign.update({
      where: { campaign_id: campaignId },
      data: campaignData,
    });
    this.logger.log(`Updated campaign ${campaignId} in database`);
  } catch (error: any) {
    this.logger.error(`Database update failed: ${error.message}`, {
      stack: error.stack,
      code: error.code,
    });
    throw new InternalServerErrorException('Failed to update campaign in database');
  }

  return campaignResourceName;
}


async deleteCampaign(campaignId: string): Promise<void> {
  this.logger.log(`Deleting campaign ${campaignId}`);

  // Fetch platform credentials
  const creds = await this.googleService.getGoogleCredentials();
  const platform = await this.prisma.marketingPlatform.findFirst({
    where: { orgId: 'single-org', platform_name: 'Google' },
  });
  if (!platform) {
    this.logger.error('Google marketing platform not found');
    throw new InternalServerErrorException('Google marketing platform not found');
  }

  const platformCreds = await this.prisma.platformCredentials.findFirst({
    where: { type: 'AUTH', user_id: null, platform_id: platform.platform_id },
  });
  if (!platformCreds || !platformCreds.refresh_token) {
    this.logger.error('No valid Google platform credentials found');
    throw new ForbiddenException('No valid Google platform credentials found');
  }

  const googleAccount = await this.prisma.googleAccount.findFirst({
    where: { orgId: 'single-org' },
  });
  if (!googleAccount || !googleAccount.mccId) {
    this.logger.error('Google account or MCC ID not found');
    throw new InternalServerErrorException('Google account or MCC ID not found');
  }

  // Verify campaign exists and get customerAccountId
  const existingCampaign = await this.prisma.googleCampaign.findUnique({
    where: { campaign_id: campaignId },
  });
  if (!existingCampaign) {
    this.logger.error(`Campaign with ID ${campaignId} not found in database`);
    throw new NotFoundException(`Campaign with ID ${campaignId} not found`);
  }

  const customerAccountId = existingCampaign.customer_account_id;

  // Get valid access token
  const accessToken = await this.googleService.getValidAccessToken(
    creds.clientId,
    creds.clientSecret,
    platformCreds.refresh_token,
    platform.platform_id,
  );

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'developer-token': creds.developerToken,
    'login-customer-id': googleAccount.mccId,
    'Content-Type': 'application/json',
  };

  const campaignResourceName = ResourceNames.campaign(customerAccountId, campaignId);

  // Delete campaign via Google Ads API
  const campaignEndpoint = `https://googleads.googleapis.com/v20/customers/${customerAccountId}/campaigns:mutate`;
  const campaignOperation = {
    remove: campaignResourceName,
  };

  try {
    const response = await axios.post(
      campaignEndpoint,
      { operations: [campaignOperation] },
      { headers },
    );
    if (response.status !== 200) {
      throw new Error(`Campaign deletion failed with status ${response.status}`);
    }
    this.logger.log(`Deleted campaign from Google Ads: ${campaignResourceName}`);
  } catch (error: any) {
    this.logger.error(`Campaign deletion failed: ${error.message}`, {
      stack: error.stack,
      details: JSON.stringify(error.response?.data || {}),
    });
    throw new InternalServerErrorException('Failed to delete campaign from Google Ads');
  }

  // Delete campaign from database
  try {
    await this.prisma.googleCampaign.delete({
      where: { campaign_id: campaignId },
    });
    this.logger.log(`Deleted campaign ${campaignId} from database`);
  } catch (error: any) {
    this.logger.error(`Database deletion failed: ${error.message}`, {
      stack: error.stack,
      code: error.code,
    });
    throw new InternalServerErrorException('Failed to delete campaign from database');
  }
}

}
