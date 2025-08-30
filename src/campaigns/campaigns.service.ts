import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { CreateCampaignDto } from './dto/create-campaign.dto';
import { UpdateCampaignDto } from './dto/update-campaign.dto';
import { PrismaService } from 'src/prisma/prisma.service';
import { AuthService } from 'src/auth/auth.service';
import { ConfigService } from '@nestjs/config';
import { LinkedInService } from 'src/auth/linkedIn/linkedIn.service';
import axios from 'axios';
import { v4 as uuid } from 'uuid';
import { JsonValue } from '@prisma/client/runtime/library';
import {
  Prisma,
  CampaignType,
  CampaignStatus,
  OptimizationTargetType,
  ObjectiveType,
  CostType,
  Format,
  SyncStatus,
} from '@prisma/client';
import pLimit from 'p-limit';
import { LinkedInAdsService } from './linkedin/linkedinAds.service';
import { format } from 'path';
import { NotificationsService } from 'src/notifications/notifications.service';

const mapToPrismaEnum = <T extends Record<string, string>>(
  value: string,
  enumObject: T,
  defaultValue: T[keyof T] | null,
): T[keyof T] | null => {
  return Object.values(enumObject).includes(value as T[keyof T])
    ? (value as T[keyof T])
    : defaultValue;
};

export interface CampaignResponse {
  campaign_id: string;
  campaign_name: string;
  platform_id: string | null;
  external_id: string | null;
  ad_account_id: string | null;
  campaign_group_id: string | null;
  associated_entity: string | null;
  objective: ObjectiveType | null;
  type: CampaignType | null;
  optimization_target_type: OptimizationTargetType | null;
  format: Format | null;
  status: CampaignStatus;
  creative_selection: string | null;
  serving_statuses: string[];
  budget: number | null;
  total_budget: number | null;
  unit_cost: number | null;
  cost_type: CostType | null;
  currency_code: string | null;
  start_date: Date;
  end_date: Date | null;
  audience_expansion: boolean;
  offsite_delivery_enabled: boolean | null;
  pacing_strategy: string | null;
  locale: string | null;
  version_tag: string | null;
  created_at: Date;
  updated_at: Date;
  data: Prisma.JsonValue | null;
  platform: {
    platform_id: string;
    platform_name: string;
    sync_status: SyncStatus;
  } | null;
  Ads: Array<{
    id: string;
    name: string | null;
    intendedStatus: string | null;
    isServing: boolean | null;
    reviewStatus: string | null;
    createdAt: Date | null;
    lastModifiedAt: Date | null;
  }>;
  CampaignGroup: {
    id: string;
    name: string;
    status: CampaignStatus;
  } | null;
  AdAccount: {
    id: string;
    name: string | null;
    accountUrn: string;
    status: string | null;
  } | null;
}

interface LinkedInMetadataResponse {
  id: string;
  org_id: string;
  platform_id: string;
  targeting_industries: { name: string; value: string }[];
  targeting_locations: { name: string; value: string }[];
  targeting_seniorities: { name: string; value: string }[];
  targeting_titles: { name: string; value: string }[];
  targeting_staff_count_ranges: { name: string; value: string }[];
  targeting_locales: { name: string; value: string }[];
  last_updated: Date;
}
export interface LinkedInCampaignConfig {
  id: string;
  orgId: string;
  syncInterval: string;
  adAccounts: { id: string; role: string }[];
  campaignGroups: { id: string; name: string }[];
  autoSyncEnabled: boolean;
  lastSyncedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface LinkedInCampaignInput {
  account: string;
  campaignGroup: string;
  name: string;
  campaignType: CampaignType;
  costType: CostType;
  format?: Format;
  locale: { language: string; country: string };
  associatedEntity: string;
  status: CampaignStatus;
  objectiveType?: ObjectiveType;
  dailyBudget: { amount: string; currencyCode: string };
  totalBudget: { amount: string; currencyCode: string };
  unitCost: { amount: string; currencyCode: string };
  runSchedule: { start: number; end?: number };
  pacingStrategy?: string;
  targetingCriteria: {
    interfaceLocales: {
      include: { value: string; text: string }[];
      exclude: { value: string; text: string }[];
    };
    locations: {
      include: { value: string; text: string }[];
      exclude: { value: string; text: string }[];
    };
    industries: {
      include: { value: string; text: string }[];
      exclude: { value: string; text: string }[];
    };
    seniorities: {
      include: { value: string; text: string }[];
      exclude: { value: string; text: string }[];
    };
    titles: {
      include: { value: string; text: string }[];
      exclude: { value: string; text: string }[];
    };
    staffCountRanges: {
      include: { value: string; text: string }[];
      exclude: { value: string; text: string }[];
    };
  };
  audienceExpansion?: boolean;
  offsiteDeliveryEnabled?: boolean;
}

interface LinkedInApiTargetingCriteria {
  include: {
    and: Array<{
      or: { [key: string]: string[] };
    }>;
  };
  exclude?: {
    or: { [key: string]: string[] };
  };
}

@Injectable()
export class CampaignsService {
  private readonly logger = new Logger(CampaignsService.name);
  constructor(
    private prisma: PrismaService,
    private readonly authService: AuthService,
    private readonly linkedinService: LinkedInService,
    private readonly linkedInAdsService: LinkedInAdsService,
    private readonly notificationService: NotificationsService,

    private readonly configService: ConfigService,
  ) {}

  async create(createCampaignDto: CreateCampaignDto) {
    return this.prisma.marketingCampaign.create({ data: createCampaignDto });
  }

  async findAll(
    filters: {
      search?: string;
      status?: string | string[];
      objective?: string | string[];
      campaignGroupId?: string | string[];
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
    } = {},
  ) {
    this.logger.log(
      'Fetching LinkedIn campaigns from database with filters:',
      filters,
    );

    try {
      // Validate date ranges
      if (
        filters.startDateFrom &&
        filters.startDateTo &&
        filters.startDateFrom > filters.startDateTo
      ) {
        throw new Error('startDateFrom must be before or equal to startDateTo');
      }
      if (
        filters.endDateFrom &&
        filters.endDateTo &&
        filters.endDateFrom > filters.endDateTo
      ) {
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

      if (filters.campaignGroupId) {
        where.campaign_group_id = Array.isArray(filters.campaignGroupId)
          ? { in: filters.campaignGroupId }
          : { in: [filters.campaignGroupId] };
      }

      // Date range filters
      if (filters.startDateFrom || filters.startDateTo) {
        where.start_date = {};
        if (filters.startDateFrom) {
          where.start_date.gte = filters.startDateFrom;
        }
        if (filters.startDateTo) {
          where.start_date.lte = filters.startDateTo;
        }
      }

      if (filters.endDateFrom || filters.endDateTo) {
        where.end_date = {};
        if (filters.endDateFrom) {
          where.end_date.gte = filters.endDateFrom;
        }
        if (filters.endDateTo) {
          where.end_date.lte = filters.endDateTo;
        }
      }

      // Budget range filters
      if (filters.minDailyBudget || filters.maxDailyBudget) {
        where.budget = {};
        if (filters.minDailyBudget) {
          where.budget.gte = filters.minDailyBudget;
        }
        if (filters.maxDailyBudget) {
          where.budget.lte = filters.maxDailyBudget;
        }
      }

      if (filters.minLifetimeBudget || filters.maxLifetimeBudget) {
        where.total_budget = {};
        if (filters.minLifetimeBudget) {
          where.total_budget.gte = filters.minLifetimeBudget;
        }
        if (filters.maxLifetimeBudget) {
          where.total_budget.lte = filters.maxLifetimeBudget;
        }
      }

      // Validate and calculate pagination
      const page = Math.max(1, filters.page || 1);
      const limit = Math.max(1, Math.min(100, filters.limit || 5)); // Cap limit to prevent abuse, default to 5 as original
      const skip = (page - 1) * limit;

      // Validate sortBy
      const validSortFields = [
        'created_at',
        'updated_at',
        'campaign_name',
        'budget',
        'total_budget',
        'start_date',
        'end_date',
      ];
      const sortBy = validSortFields.includes(filters.sortBy || '')
        ? filters.sortBy
        : 'updated_at';
      const sortOrder = filters.sortOrder || 'desc';

      // Execute query with pagination and sorting
      const [campaigns, total] = await Promise.all([
        this.prisma.marketingCampaign.findMany({
          where,
          skip,
          take: limit,
          orderBy: {
            [sortBy as string]: sortOrder,
          },
          include: {
            platform: {
              select: {
                platform_id: true,
                platform_name: true,
                sync_status: true,
              },
            },
            Ads: {
              select: {
                id: true,
                name: true,
                intendedStatus: true,
                isServing: true,
                reviewStatus: true,
                createdAt: true,
                lastModifiedAt: true,
              },
            },
            CampaignGroup: {
              select: {
                id: true,
                name: true,
                status: true,
              },
            },
            AdAccount: {
              select: {
                id: true,
                name: true,
                accountUrn: true,
                status: true,
              },
            },
          },
        }),
        this.prisma.marketingCampaign.count({ where }),
      ]);

      this.logger.log(
        `Fetched ${campaigns.length} LinkedIn campaigns from database (total: ${total})`,
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
      this.logger.error(
        `Failed to fetch LinkedIn campaigns: ${error.message}`,
        error.stack,
      );
      throw new Error(`Failed to fetch LinkedIn campaigns: ${error.message}`);
    }
  }

  async findOne(campaign_id: string): Promise<CampaignResponse | null> {
    return this.prisma.marketingCampaign.findUnique({
      where: { campaign_id },
      include: {
        platform: {
          select: {
            platform_id: true,
            platform_name: true,
            sync_status: true,
          },
        },
        Ads: {
          select: {
            id: true,
            name: true,
            intendedStatus: true,
            isServing: true,
            reviewStatus: true,
            createdAt: true,
            lastModifiedAt: true,
          },
        },
        CampaignGroup: {
          select: {
            id: true,
            name: true,
            status: true,
          },
        },
        AdAccount: {
          select: {
            id: true,
            name: true,
            accountUrn: true,
            status: true,
          },
        },
      },
    });
  }

  async update(id: string, updateCampaignDto: UpdateCampaignDto) {
    return this.prisma.marketingCampaign.update({
      where: { campaign_id: id },
      data: updateCampaignDto,
    });
  }

  async remove(id: string) {
    return this.prisma.marketingCampaign.delete({ where: { campaign_id: id } });
  }

  async fetchLinkedInCampaigns(adAccountIds: string[]): Promise<any[]> {
    this.logger.log(
      `Fetching LinkedIn campaigns for ad accounts: ${adAccountIds.join(', ')}`,
    );

    const accessToken = await this.linkedinService.getValidAccessToken();
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'LinkedIn-Version': '202505',
      'X-RestLi-Protocol-Version': '2.0.0',
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    const campaigns: any[] = [];

    try {
      for (const adAccountId of adAccountIds) {
        const adAccountUrn = `urn:li:sponsoredAccount:${adAccountId}`;
        this.logger.log(`Fetching campaigns for ad account: ${adAccountUrn}`);

        const params = new URLSearchParams({
          q: 'search',
        });

        const response = await axios.get<{ elements: any[] }>(
          `https://api.linkedin.com/rest/adAccounts/${adAccountId}/adCampaigns`,
          {
            headers,
            params,
          },
        );

        const accountCampaigns = response.data.elements || [];
        this.logger.log(
          `Fetched ${accountCampaigns.length} campaigns for ad account ${adAccountId}`,
        );
        campaigns.push(
          ...accountCampaigns.map((campaign) => ({
            ...campaign,
            adAccountId,
          })),
        );
      }
      await this.saveLinkedInCampaigns(campaigns);
      this.logger.log('Initiating ad sync for all campaigns');
      const adSyncResult = await this.linkedInAdsService.syncCampaignAds();

      return campaigns;
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
      this.logger.error(`Failed to fetch campaigns: ${error.message}`);
      throw new Error('Failed to fetch LinkedIn campaigns');
    }
  }

  async saveLinkedInCampaigns(campaigns: any[]): Promise<void> {
    const org = await this.prisma.organization.findUnique({
      where: { id: 'single-org' },
    });
    if (!org) {
      this.logger.error(`Organization not found for id: single-org`);
      throw new Error('Organization not found');
    }

    const platform = await this.prisma.marketingPlatform.findFirst({
      where: { orgId: org.id, platform_name: 'LinkedIn' },
    });
    if (!platform) {
      this.logger.error('LinkedIn platform not found for organization');
      throw new Error('LinkedIn platform not configured');
    }

    // Fetch LinkedIn metadata
    const metadata = await this.prisma.linkedInMetadata.findUnique({
      where: {
        org_id_platform_id: {
          org_id: org.id,
          platform_id: platform.platform_id,
        },
      },
    });
    if (!metadata) {
      this.logger.error(`LinkedIn metadata not found for org: ${org.id}`);
      throw new Error('LinkedIn metadata not configured');
    }

    // Fetch existing campaigns to preserve ad_account_id and campaign_group_id
    const existingCampaigns = await this.prisma.marketingCampaign.findMany({
      where: {
        external_id: {
          in: campaigns
            .map((c) => c.id?.toString())
            .filter((id): id is string => !!id),
        },
      },
      select: {
        external_id: true,
        ad_account_id: true,
        campaign_group_id: true,
      },
    });

    const campaignMap = new Map(
      existingCampaigns.map((c) => [
        c.external_id,
        {
          ad_account_id: c.ad_account_id,
          campaign_group_id: c.campaign_group_id,
        },
      ]),
    );

    // Fetch campaign groups for URN-to-ID mapping
    const config = await this.prisma.linkedInCampaignConfig.findUnique({
      where: { orgId: 'single-org' },
      include: { campaignGroups: true },
    });
    const campaignGroupMap = new Map(
      config?.campaignGroups.map((group) => [
        group.urn?.split(':').pop(),
        group.id,
      ]) || [],
    );

    const mappedCampaigns = campaigns.map((campaign) => {
      const existing = campaignMap.get(campaign.id?.toString());
      this.logger.log(`Processing campaign ${campaign.id}:`, {
        campaignAdAccountId: campaign.adAccountId,
        existingAdAccountId: existing?.ad_account_id,
        campaignGroup: campaign.campaignGroup,
        existingCampaignGroupId: existing?.campaign_group_id,
    });
      if (!campaign.campaignGroup) {
        this.logger.warn(
          `Campaign ${campaign.id} has no campaignGroup in API response`,
          { campaign },
        );
      } else if (
        !campaign.campaignGroup.includes('urn:li:sponsoredCampaignGroup:')
      ) {
        this.logger.warn(
          `Campaign ${campaign.id} has invalid campaignGroup URN: ${campaign.campaignGroup}`,
          { campaign },
        );
      }

      // Map targetingCriteria (unchanged from original)
      let transformedData = {};
      if (campaign.targetingCriteria) {
        const transformFacet = (facetData: any, facetUrn: string): any => {
          const facetKey = facetUrn.split(':').pop() || facetUrn;
          const map = metadata[facetKey];
          if (!map) {
            this.logger.warn(`No metadata map for facet: ${facetKey}`);
            return facetData;
          }
          return facetData.map((urn: string) => ({
            urn,
            name:
              map.find((item: any) => item.value === urn)?.name || 'Unknown',
          }));
        };

        transformedData = {
          targetingCriteria: {
            include: campaign.targetingCriteria.include
              ? {
                  and: campaign.targetingCriteria.include.and.map(
                    (andClause: any) => ({
                      or: Object.fromEntries(
                        Object.entries(andClause.or).map(([facetUrn, urns]) => [
                          facetUrn,
                          transformFacet(urns, facetUrn),
                        ]),
                      ),
                    }),
                  ),
                }
              : undefined,
          },
        };
      }

      const campaignGroupIdRaw = campaign.campaignGroup?.split(':').pop();
      let campaignGroupId: string | null = null;

      if (campaignGroupIdRaw && campaignGroupMap.has(campaignGroupIdRaw)) {
        const mappedId = campaignGroupMap.get(campaignGroupIdRaw);
        campaignGroupId = mappedId !== undefined ? mappedId : null;
      } else if (existing?.campaign_group_id) {
        campaignGroupId = existing.campaign_group_id;
      }

      const adAccountId = campaign.adAccountId || existing?.ad_account_id;
      return {
        campaign_name: campaign.name || 'Unnamed Campaign',
        platform_id: platform.platform_id,
        external_id: campaign.id?.toString(),
        ad_account_id: adAccountId,
        campaign_group_id: campaignGroupId,
        associated_entity: campaign.associatedEntity?.split(':').pop() || null,
        objective: campaign.objectiveType
          ? mapToPrismaEnum(campaign.objectiveType, ObjectiveType, null)
          : null,
        type: campaign.type
          ? mapToPrismaEnum(campaign.type, CampaignType, null)
          : null,
        optimization_target_type: campaign.optimizationTargetType
          ? mapToPrismaEnum(
              campaign.optimizationTargetType,
              OptimizationTargetType,
              null,
            )
          : null,
        format: campaign.format
          ? mapToPrismaEnum(campaign.format, Format, null)
          : null,
        status: campaign.status
          ? (mapToPrismaEnum(
              campaign.status,
              CampaignStatus,
              CampaignStatus.DRAFT,
            ) as CampaignStatus)
          : CampaignStatus.DRAFT,
        creative_selection: campaign.creativeSelection || null,
        serving_statuses: Array.isArray(campaign.servingStatuses)
          ? campaign.servingStatuses
          : [],
        budget: campaign.dailyBudget?.amount
          ? parseFloat(campaign.dailyBudget.amount)
          : null,
        total_budget: null,
        unit_cost: campaign.unitCost?.amount
          ? parseFloat(campaign.unitCost.amount)
          : null,
        cost_type: campaign.costType
          ? mapToPrismaEnum(campaign.costType, CostType, null)
          : null,
        currency_code:
          campaign.dailyBudget?.currencyCode ||
          campaign.unitCost?.currencyCode ||
          null,
        start_date: campaign.runSchedule?.start
          ? new Date(campaign.runSchedule.start)
          : new Date(),
        end_date: campaign.runSchedule?.end
          ? new Date(campaign.runSchedule.end)
          : null,
        audience_expansion: campaign.audienceExpansionEnabled ?? false,
        offsite_delivery_enabled: campaign.offsiteDeliveryEnabled ?? false,
        pacing_strategy: campaign.pacingStrategy || null,
        locale: campaign.locale
          ? `${campaign.locale.language}_${campaign.locale.country}`
          : null,
        version_tag: campaign.version?.versionTag || null,
        created_at: campaign.changeAuditStamps?.created?.time
          ? new Date(campaign.changeAuditStamps.created.time)
          : new Date(),
        updated_at: campaign.changeAuditStamps?.lastModified?.time
          ? new Date(campaign.changeAuditStamps.lastModified.time)
          : new Date(),
        data: transformedData,
      };
    });

    for (const campaign of mappedCampaigns) {
      await this.prisma.marketingCampaign.upsert({
        where: { external_id: campaign.external_id ?? uuid() },
        update: {
          campaign_name: campaign.campaign_name,
          platform_id: campaign.platform_id,
          ...(campaign.ad_account_id
            ? { ad_account_id: campaign.ad_account_id }
            : {}),
          ...(campaign.campaign_group_id
            ? { campaign_group_id: campaign.campaign_group_id }
            : {}),
          associated_entity: campaign.associated_entity,
          objective: campaign.objective
            ? { set: campaign.objective }
            : { set: null },
          type: campaign.type ? { set: campaign.type } : { set: null },
          optimization_target_type: campaign.optimization_target_type
            ? { set: campaign.optimization_target_type }
            : { set: null },
          format: campaign.format,
          status: { set: campaign.status },
          creative_selection: campaign.creative_selection,
          serving_statuses: { set: campaign.serving_statuses },
          budget: campaign.budget,
          total_budget: campaign.total_budget,
          unit_cost: campaign.unit_cost,
          cost_type: campaign.cost_type
            ? { set: campaign.cost_type }
            : { set: null },
          currency_code: campaign.currency_code,
          start_date: campaign.start_date,
          end_date: campaign.end_date,
          audience_expansion: campaign.audience_expansion,
          offsite_delivery_enabled: campaign.offsite_delivery_enabled,
          pacing_strategy: campaign.pacing_strategy,
          locale: campaign.locale,
          version_tag: campaign.version_tag,
          created_at: campaign.created_at,
          updated_at: campaign.updated_at,
          data: campaign.data,
        },
        create: campaign,
      });
    }
  }

  async fetchAndSaveLinkedInMetadata(orgId: string): Promise<void> {
    this.logger.log(`Fetching LinkedIn metadata for organization: ${orgId}`);

    const platform = await this.prisma.marketingPlatform.findFirst({
      where: { orgId, platform_name: 'LinkedIn' },
    });
    if (!platform) {
      this.logger.error('LinkedIn platform not found for organization');
      throw new Error('LinkedIn platform not configured');
    }

    const accessToken = await this.linkedinService.getValidAccessToken();
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'LinkedIn-Version': '202505',
      'X-RestLi-Protocol-Version': '2.0.0',
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    const countrySearchTerms = [
      'Afghanistan',
      'Albania',
      'Algeria',
      'Andorra',
      'Angola',
      'Antigua and Barbuda',
      'Argentina',
      'Armenia',
      'Australia',
      'Austria',
      'Azerbaijan',
      'Bahamas',
      'Bahrain',
      'Bangladesh',
      'Barbados',
      'Belarus',
      'Belgium',
      'Belize',
      'Benin',
      'Bhutan',
      'Bolivia',
      'Bosnia and Herzegovina',
      'Botswana',
      'Brazil',
      'Brunei',
      'Bulgaria',
      'Burkina Faso',
      'Burundi',
      'Cambodia',
      'Cameroon',
      'Canada',
      'Cape Verde',
      'Central African Republic',
      'Chad',
      'Chile',
      'China',
      'Colombia',
      'Comoros',
      'Costa Rica',
      'Croatia',
      'Cuba',
      'Cyprus',
      'Czech Republic',
      'Democratic Republic of the Congo',
      'Denmark',
      'Djibouti',
      'Dominica',
      'Dominican Republic',
      'Ecuador',
      'Egypt',
      'El Salvador',
      'Equatorial Guinea',
      'Eritrea',
      'Estonia',
      'Eswatini',
      'Ethiopia',
      'Fiji',
      'Finland',
      'France',
      'Gabon',
      'Gambia',
      'Georgia',
      'Germany',
      'Ghana',
      'Greece',
      'Grenada',
      'Guatemala',
      'Guinea',
      'Guinea-Bissau',
      'Guyana',
      'Haiti',
      'Honduras',
      'Hungary',
      'Iceland',
      'India',
      'Indonesia',
      'Iran',
      'Iraq',
      'Ireland',
      'Israel',
      'Italy',
      'Jamaica',
      'Japan',
      'Jordan',
      'Kazakhstan',
      'Kenya',
      'Kiribati',
      'Kuwait',
      'Kyrgyzstan',
      'Laos',
      'Latvia',
      'Lebanon',
      'Lesotho',
      'Liberia',
      'Libya',
      'Liechtenstein',
      'Lithuania',
      'Luxembourg',
      'Madagascar',
      'Malawi',
      'Malaysia',
      'Maldives',
      'Mali',
      'Malta',
      'Marshall Islands',
      'Mauritania',
      'Mauritius',
      'Mexico',
      'Micronesia',
      'Moldova',
      'Monaco',
      'Mongolia',
      'Montenegro',
      'Morocco',
      'Mozambique',
      'Myanmar',
      'Namibia',
      'Nauru',
      'Nepal',
      'Netherlands',
      'New Zealand',
      'Nicaragua',
      'Niger',
      'Nigeria',
      'North Korea',
      'North Macedonia',
      'Norway',
      'Oman',
      'Pakistan',
      'Palau',
      'Panama',
      'Papua New Guinea',
      'Paraguay',
      'Peru',
      'Philippines',
      'Poland',
      'Portugal',
      'Qatar',
      'Republic of the Congo',
      'Romania',
      'Russia',
      'Rwanda',
      'Saint Kitts and Nevis',
      'Saint Lucia',
      'Saint Vincent and the Grenadines',
      'Samoa',
      'San Marino',
      'Sao Tome and Principe',
      'Saudi Arabia',
      'Senegal',
      'Serbia',
      'Seychelles',
      'Sierra Leone',
      'Singapore',
      'Slovakia',
      'Slovenia',
      'Solomon Islands',
      'Somalia',
      'South Africa',
      'South Korea',
      'South Sudan',
      'Spain',
      'Sri Lanka',
      'Sudan',
      'Suriname',
      'Sweden',
      'Switzerland',
      'Syria',
      'Tajikistan',
      'Tanzania',
      'Thailand',
      'Timor-Leste',
      'Togo',
      'Tonga',
      'Trinidad and Tobago',
      'Tunisia',
      'Turkey',
      'Turkmenistan',
      'Tuvalu',
      'Uganda',
      'Ukraine',
      'United Arab Emirates',
      'United Kingdom',
      'United States',
      'Uruguay',
      'Uzbekistan',
      'Vanuatu',
      'Venezuela',
      'Vietnam',
      'Yemen',
      'Zambia',
      'Zimbabwe',
    ];

    try {
      // Fetch available targeting facets from /rest/adTargetingFacets
      let availableFacets: {
        facetName: string;
        adTargetingFacetUrn: string;
      }[] = [];
      try {
        const url = 'https://api.linkedin.com/rest/adTargetingFacets';
        this.logger.log(`Sending request to LinkedIn API: ${url}`);
        const facetsResponse = await axios.get<{ elements: any[] }>(url, {
          headers,
        });
        availableFacets = facetsResponse.data.elements || [];
        this.logger.log(
          `Fetched ${availableFacets.length} targeting facets from adTargetingFacets`,
        );
      } catch (facetError: any) {
        this.logger.warn(
          `Failed to fetch adTargetingFacets: ${facetError.message}`,
        );
        if (facetError.response?.status === 403) {
          this.logger.error(
            'Missing permissions for adTargetingFacets; check r_ads scope',
          );
        } else if (facetError.response?.status === 404) {
          this.logger.error(
            'adTargetingFacets endpoint not found or misconfigured',
          );
        }
      }

      // Define facets to fetch values for
      const facetsToFetch = [
        'urn:li:adTargetingFacet:industries',
        'urn:li:adTargetingFacet:locations',
        'urn:li:adTargetingFacet:seniorities',
        'urn:li:adTargetingFacet:titles',
        'urn:li:adTargetingFacet:staffCountRanges',
        'urn:li:adTargetingFacet:interfaceLocales',
      ].filter((urn) =>
        availableFacets.some((facet) => facet.adTargetingFacetUrn === urn),
      );
      const limit = pLimit(5);
      // Fetch specific values for each facet
      const facetData: { [key: string]: any[] } = {
        industries: [],
        locations: [],
        seniorities: [],
        titles: [],
        staffCountRanges: [],
        interfaceLocales: [],
      };

      for (const facetUrn of facetsToFetch) {
        const facetKey = facetUrn.split(':').pop() as keyof typeof facetData;

        if (facetKey === 'locations') {
          // Special handling for locations using typeahead with country names
          try {
            const baseUrl = 'https://api.linkedin.com/rest/adTargetingEntities';
            const encodedFacet = encodeURIComponent(facetUrn);

            // Create throttled API requests for each country
            const locationPromises = countrySearchTerms.map((query) =>
              limit(async () => {
                try {
                  const fullUrl = `${baseUrl}?q=typeahead&queryVersion=QUERY_USES_URNS&facet=${encodedFacet}&query=${encodeURIComponent(query)}&locale=(language:en,country:US)`;
                  this.logger.log(
                    `Fetching locations for country: ${query} at ${fullUrl}`,
                  );
                  const response = await axios.get<{
                    elements: any[];
                    paging: { total: number; links: any[] };
                  }>(fullUrl, { headers });

                  const elements = response.data.elements || [];
                  // Filter for country-level results (exclude subregions/cities)
                  const countryElements = elements.filter(
                    (elem) =>
                      // Heuristic: Country names typically don't include commas (e.g., "United States", not "California, United States")
                      !elem.name.includes(',') ||
                      // Handle exceptions like "United States" or "United Kingdom" which may include commas in API response
                      countrySearchTerms.some(
                        (country) =>
                          elem.name
                            .toLowerCase()
                            .includes(country.toLowerCase()) &&
                          !elem.name.toLowerCase().includes('county') &&
                          !elem.name.toLowerCase().includes('city'),
                      ),
                  );
                  this.logger.log(
                    `Fetched ${countryElements.length} country-level locations for query "${query}"`,
                  );
                  return countryElements;
                } catch (queryError: any) {
                  this.logger.warn(
                    `Failed to fetch locations for country "${query}": ${queryError.message}`,
                  );
                  return [];
                }
              }),
            );

            // Execute all throttled requests
            const locationResults = await Promise.all(locationPromises);
            facetData.locations = locationResults.flat();

            // Deduplicate locations by URN
            facetData.locations = Array.from(
              new Map(
                facetData.locations.map((item) => [item.urn, item]),
              ).values(),
            );
            this.logger.log(
              `Deduplicated to ${facetData.locations.length} unique country locations`,
            );
          } catch (error: any) {
            this.logger.error(
              `Failed to fetch locations for ${facetUrn}: ${error.message}`,
            );
          }
        } else {
          // Handle other facets using adTargetingFacet finder
          try {
            const baseUrl = 'https://api.linkedin.com/rest/adTargetingEntities';
            const encodedFacet = encodeURIComponent(facetUrn);
            const fullUrl = `${baseUrl}?q=adTargetingFacet&queryVersion=QUERY_USES_URNS&facet=${encodedFacet}&locale=(language:en,country:US)`;
            this.logger.log(`Fetching ${facetKey} at ${fullUrl}`);
            const response = await axios.get<{
              elements: any[];
              paging: { total: number; links: any[] };
            }>(fullUrl, { headers });

            const elements = response.data.elements || [];
            facetData[facetKey].push(...elements);
            this.logger.log(
              `Fetched ${elements.length} ${facetKey} from adTargetingEntities`,
            );

            const hasMore =
              response.data.paging?.links?.some(
                (link: any) => link.rel === 'next',
              ) || false;
            if (hasMore) {
              this.logger.warn(
                `Pagination not supported without start/count for ${facetUrn}; only first page retrieved`,
              );
            }
          } catch (facetError: any) {
            this.logger.warn(
              `Failed to fetch ${facetUrn}: ${facetError.message}`,
            );
            if (facetError.response?.status === 400) {
              this.logger.error(
                `Bad request for ${facetUrn}; verify URL format and parameters`,
              );
            }
            if (facetError.response?.status === 403) {
              this.logger.error(
                `Missing permissions for ${facetUrn}; check r_ads scope`,
              );
            } else if (facetError.response?.status === 404) {
              this.logger.error(
                `${facetUrn} endpoint not found or misconfigured`,
              );
            }
          }
        }
      }

      const metadata = {
        targeting_industries: facetData.industries.map((facet) => ({
          name: facet.name || 'Unknown Industry',
          value: facet.urn || 'Unknown',
        })),
        targeting_locations: facetData.locations.map((facet) => ({
          name: facet.name || 'Unknown Location',
          value: facet.urn || 'Unknown',
        })),
        targeting_seniorities: facetData.seniorities.map((facet) => ({
          name: facet.name || 'Unknown Seniority',
          value: facet.urn || 'Unknown',
        })),
        targeting_titles: facetData.titles.map((facet) => ({
          name: facet.name || 'Unknown Title',
          value: facet.urn || 'Unknown',
        })),
        targeting_staff_count_ranges: facetData.staffCountRanges.map(
          (facet) => ({
            name: facet.name || 'Unknown Staff Count Range',
            value: facet.urn || 'Unknown',
          }),
        ),
        targeting_locales: facetData.interfaceLocales.map((facet) => ({
          name: facet.name || 'Unknown Locale',
          value: facet.urn || 'Unknown',
        })),
      };

      await this.prisma.linkedInMetadata.upsert({
        where: {
          org_id_platform_id: {
            org_id: orgId,
            platform_id: platform.platform_id,
          },
        },
        update: {
          ...metadata,
          last_updated: new Date(),
        },
        create: {
          org_id: orgId,
          platform_id: platform.platform_id,
          ...metadata,
          last_updated: new Date(),
        },
      });

      this.logger.log(`Saved LinkedIn metadata for organization: ${orgId}`);
    } catch (error: any) {
      if (error.response) {
        this.logger.error(
          `LinkedIn API Error: ${error.response.status} - ${JSON.stringify(error.response.data)}`,
          {
            request: {
              url: error.config?.url,
              method: error.config?.method,
              headers: error.config?.headers,
              params: error.config?.params,
            },
          },
        );
        if (error.response.status === 401) {
          throw new UnauthorizedException('Invalid or expired access token');
        }
        if (error.response.status === 403) {
          throw new ForbiddenException(
            'Missing required scopes (r_ads, r_ads_status) or insufficient permissions',
          );
        }
        if (error.response.status === 429) {
          throw new Error('Rate limit exceeded');
        }
        if (error.response.status === 404) {
          throw new Error(
            'LinkedIn API endpoint not found; verify endpoint availability',
          );
        }
      }
      this.logger.error(`Failed to fetch LinkedIn metadata: ${error.message}`);
      throw new Error('Failed to fetch LinkedIn metadata');
    }
  }

  async fetchLinkedInMetadata(orgId: string): Promise<any> {
    this.logger.log(
      `Fetching LinkedIn metadata from database for organization: ${orgId}`,
    );

    // Step 1: Find the LinkedIn platform for the organization
    const platform = await this.prisma.marketingPlatform.findFirst({
      where: {
        orgId,
        platform_name: 'LinkedIn',
      },
    });

    if (!platform) {
      this.logger.error('LinkedIn platform not found for organization');
      throw new Error('LinkedIn platform not configured for organization');
    }

    // Step 2: Fetch metadata from LinkedInMetadata table
    const metadata = await this.prisma.linkedInMetadata.findUnique({
      where: {
        org_id_platform_id: {
          org_id: orgId,
          platform_id: platform.platform_id,
        },
      },
    });

    if (!metadata) {
      this.logger.error(
        `No LinkedIn metadata found for organization: ${orgId}, platform: ${platform.platform_id}`,
      );
      throw new Error('LinkedIn metadata not found in database');
    }

    // Step 3: Structure the response
    const response = {
      id: metadata.id,
      org_id: metadata.org_id,
      platform_id: metadata.platform_id,
      targeting_industries: metadata.targeting_industries || [],
      targeting_locations: metadata.targeting_locations || [],
      targeting_seniorities: metadata.targeting_seniorities || [],
      targeting_titles: metadata.targeting_titles || [],
      targeting_staff_count_ranges: metadata.targeting_staff_count_ranges || [],
      targeting_locales: metadata.targeting_locales || [],
      last_updated: metadata.last_updated,
    };

    this.logger.log(
      `Successfully fetched LinkedIn metadata for organization: ${orgId}`,
    );
    return response as any;
  }

  async searchLinkedInMetadata(
    orgId: string,
    facet: string,
    searchTerm: string,
  ): Promise<any> {
    this.logger.log(
      `Searching LinkedIn metadata for org: ${orgId}, facet: ${facet}, searchTerm: ${searchTerm}`,
    );

    // Validate facet
    const validFacets = [
      'targeting_industries',
      'targeting_locations',
      'targeting_seniorities',
      'targeting_titles',
      'targeting_staff_count_ranges',
      'targeting_locales',
    ];
    if (!validFacets.includes(facet)) {
      this.logger.warn(`Invalid facet requested: ${facet}`);
      return []; // <-- Return empty array for invalid facets instead of throwing
    }

    // Find the LinkedIn platform for the organization
    const platform = await this.prisma.marketingPlatform.findFirst({
      where: {
        orgId,
        platform_name: 'LinkedIn',
      },
    });

    if (!platform) {
      this.logger.warn(`LinkedIn platform not found for orgId: ${orgId}`);
      return []; // <-- Also return empty array here
    }
    // Use raw SQL for JSONB filtering

    const searchTermLower = searchTerm?.toLowerCase().trim() || '';
    const query = `
    SELECT "${facet}" 
    FROM "LinkedInMetadata" 
    WHERE org_id = $1 
      AND platform_id = $2 
      AND "${facet}" @> '[]'::jsonb 
      AND (
        $3 = '' OR 
        EXISTS (
          SELECT 1 
          FROM jsonb_array_elements("${facet}") AS elem 
          WHERE lower(elem->>'name') LIKE $4
        )
      )
    LIMIT 50
  `;
    const result = await this.prisma.$queryRawUnsafe<
      Array<{ [key: string]: { name: string; value: string }[] }>
    >(
      query,
      orgId,
      platform.platform_id,
      searchTermLower,
      `%${searchTermLower}%`,
    );

    if (!result || result.length === 0 || !result[0][facet]) {
      this.logger.warn(`No ${facet} metadata found for organization: ${orgId}`);
      return [];
    }

    const data = result?.[0]?.[facet] ?? [];

    const filteredData = (
      searchTermLower === ''
        ? data
        : data.filter((item) =>
            item.name.toLowerCase().includes(searchTermLower),
          )
    ).slice(0, 20);

    this.logger.log(
      `Returning ${filteredData.length} results for facet: ${facet}`,
    );
    return filteredData;
  }

  async getLinkedInCampaignConfig(): Promise<LinkedInCampaignConfig | null> {
    this.logger.log('Fetching LinkedInCampaignConfig for org: single-org');

    try {
      const config = await this.prisma.linkedInCampaignConfig.findUnique({
        where: { orgId: 'single-org' },
        include: {
          adAccounts: {
            select: {
              id: true,
              role: true,
            },
          },
          campaignGroups: {
            select: {
              id: true,
              name: true,
            },
          },
        },
      });

      if (!config) {
        this.logger.log('No LinkedInCampaignConfig found for org: single-org');
        return null;
      }

      return {
        id: config.id,
        orgId: config.orgId,
        syncInterval: config.syncInterval,
        autoSyncEnabled: config.autoSyncEnabled,
        lastSyncedAt: config.lastSyncedAt,
        createdAt: config.createdAt,
        updatedAt: config.updatedAt,
        adAccounts: config.adAccounts,
        campaignGroups: config.campaignGroups,
      };
    } catch (error: any) {
      this.logger.error(
        `Failed to fetch LinkedInCampaignConfig: ${error.message}`,
      );
      return null;
    }
  }

  /////////////////////// CAMPAIGN GROUPS ///////////////////////

  async createCampaignGroup(data: {
    adAccountId: string;
    name: string;
    runSchedule: { start: number; end?: number };
    status: 'ACTIVE' | 'DRAFT';
    totalBudget?: { amount: string; currencyCode: string };
    objectiveType?: string;
  }) {
    this.logger.log(
      `Received request to create campaign group: ${JSON.stringify(data, null, 2)}`,
    );
    // Validate adAccountId exists in database
    const adAccount = await this.prisma.adAccount.findUnique({
      where: { id: data.adAccountId },
      select: { id: true, accountUrn: true, organizationId: true },
    });
    if (!adAccount) {
      this.logger.error(`Ad account not found for id: ${data.adAccountId}`);
      throw new Error('Ad account not found');
    }

    const validatedObjectiveType = data.objectiveType
      ? mapToPrismaEnum(data.objectiveType, ObjectiveType, null)
      : null;

    // Prepare LinkedIn API payload
    const linkedinPayload = {
      account: `urn:li:sponsoredAccount:${data.adAccountId}`,
      name: data.name,
      runSchedule: {
        start: data.runSchedule.start,
        ...(data.runSchedule.end && { end: data.runSchedule.end }),
      },
      status: data.status,
      ...(data.totalBudget && {
        totalBudget: {
          amount: data.totalBudget.amount,
          currencyCode: data.totalBudget.currencyCode,
        },
      }),
      ...(validatedObjectiveType && {
        objectiveType: validatedObjectiveType,
      }),
    };

    this.logger.log(
      `Prepared LinkedIn payload: ${JSON.stringify(linkedinPayload, null, 2)}`,
    );

    try {
      // Get LinkedIn access token
      const accessToken = await this.linkedinService.getValidAccessToken();
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        'LinkedIn-Version': '202505',
        'X-RestLi-Protocol-Version': '2.0.0',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };

      // Step 1: Create campaign group on LinkedIn
      this.logger.log(
        `Sending request to LinkedIn API to create campaign group for adAccountId: ${data.adAccountId}`,
      );
      const linkedinResponse = await axios.post<{}>(
        `https://api.linkedin.com/rest/adAccounts/${data.adAccountId}/adCampaignGroups`,
        linkedinPayload,
        { headers },
      );

      this.logger.log(`Response status: ${linkedinResponse.status}`);
      this.logger.log(
        `Response headers: ${JSON.stringify(linkedinResponse.headers, null, 2)}`,
      );
      this.logger.log(
        `Response body: ${JSON.stringify(linkedinResponse.data, null, 2)}`,
      );

      if (linkedinResponse.status !== 201) {
        this.logger.error(
          `Unexpected response status: ${linkedinResponse.status}`,
        );
        throw new Error(
          `Failed to create campaign group: Received status ${linkedinResponse.status}`,
        );
      }

      let campaignGroupId =
        linkedinResponse.headers['x-restli-id'] ||
        linkedinResponse.headers['x-linkedin-id'];
      if (!campaignGroupId) {
        // Fallback to parsing Location header
        const locationHeader = linkedinResponse.headers['location'];
        if (locationHeader) {
          const match = locationHeader.match(/\/adCampaignGroups\/(\d+)$/);
          campaignGroupId = match ? match[1] : null;
        }
        if (!campaignGroupId) {
          this.logger.error(
            'No campaign group ID found in x-restli-id, x-linkedin-id, or Location headers',
          );
          throw new Error('Failed to retrieve campaign group ID');
        }
      }

      this.logger.log(
        `Successfully created campaign group on LinkedIn with ID: ${campaignGroupId}`,
      );

      // Construct URN
      const campaignGroupUrn = `urn:li:sponsoredCampaignGroup:${campaignGroupId}`;

      // Prepare changeAuditStamps (use LinkedIn response or default)
      const currentTime = Date.now();
      const changeAuditStamps = {
        created: { time: currentTime, actor: 'system' },
        lastModified: { time: currentTime, actor: 'system' },
      };

      // Step 2: Persist in database
      const campaignGroup = await this.prisma.campaignGroup.create({
        data: {
          id: campaignGroupId, // Use LinkedIn ID as primary key
          adAccountId: data.adAccountId, // Scalar field for relation
          name: data.name,
          urn: campaignGroupUrn,
          status: data.status,
          runSchedule: {
            start: data.runSchedule.start,
            ...(data.runSchedule.end && { end: data.runSchedule.end }),
          },
          test: false, // Default; adjust if needed
          changeAuditStamps,
          totalBudget: data.totalBudget
            ? {
                amount: data.totalBudget.amount,
                currencyCode: data.totalBudget.currencyCode,
              }
            : undefined, // SQL NULL for nullable Json
          servingStatuses: [], // Default to empty array
          backfilled: false, // Default; adjust if needed
          accountUrn: `urn:li:sponsoredAccount:${data.adAccountId}`, // From adAccountId
          objectiveType: validatedObjectiveType,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });

      this.logger.log(
        `Successfully saved campaign group to database: ${JSON.stringify(
          campaignGroup,
          null,
          2,
        )}`,
      );

      return {
        success: true,
        message: 'Campaign group created successfully',
        data: campaignGroup,
      };
    } catch (error: any) {
      if (error.response) {
        this.logger.error(
          `LinkedIn API Error: ${error.response.status} - ${JSON.stringify(
            error.response.data,
          )}`,
          {
            request: {
              url: error.config?.url,
              method: error.config?.method,
              headers: error.config?.headers,
              data: error.config?.data,
            },
          },
        );
        if (error.response.status === 401) {
          throw new UnauthorizedException('Invalid or expired access token');
        }
        if (error.response.status === 403) {
          throw new ForbiddenException(
            'Missing required scopes (r_ads, rw_ads) or insufficient permissions',
          );
        }
        if (error.response.status === 429) {
          throw new Error('Rate limit exceeded');
        }
        if (error.response.status === 400) {
          throw new Error(
            `Invalid request: ${JSON.stringify(error.response.data)}`,
          );
        }
      }
      this.logger.error(`Failed to create campaign group: ${error.message}`);
      throw new Error('Failed to create campaign group');
    }
  }

  async findAllCampaignGroups() {
    this.logger.log('Fetching all campaign groups');
    try {
      const campaignGroups = await this.prisma.campaignGroup.findMany({
        include: {
          adAccount: {
            select: {
              id: true,
              accountUrn: true,
              organizationId: true,
            },
          },
        },
      });
      this.logger.log(`Fetched ${campaignGroups.length} campaign groups`);
      return campaignGroups;
    } catch (error: any) {
      this.logger.error(`Failed to fetch campaign groups: ${error.message}`);
      throw new Error('Failed to fetch campaign groups');
    }
  }

  async findOneCampaignGroup(id: string) {
    this.logger.log(`Fetching campaign group with id: ${id}`);
    try {
      const campaignGroup = await this.prisma.campaignGroup.findUnique({
        where: { id },
        include: {
          adAccount: {
            select: {
              id: true,
              accountUrn: true,
              organizationId: true,
            },
          },
        },
      });
      if (!campaignGroup) {
        this.logger.warn(`Campaign group with id: ${id} not found`);
        throw new Error('Campaign group not found');
      }
      this.logger.log(`Fetched campaign group with id: ${id}`);
      return campaignGroup;
    } catch (error: any) {
      this.logger.error(`Failed to fetch campaign group: ${error.message}`);
      throw new Error('Failed to fetch campaign group');
    }
  }

  async updateCampaignGroup(
    id: string,
    data: {
      name?: string;
      status?: 'ACTIVE' | 'DRAFT' | 'PAUSED' | 'ARCHIVED' | 'PENDING_DELETION';
      runSchedule?: { start?: number; end?: number };
      totalBudget?: { amount: string; currencyCode: string };
    },
  ) {
    this.logger.log(
      `Received request to update campaign group with id: ${id}, data: ${JSON.stringify(data, null, 2)}`,
    );

    // Validate campaign group exists in database and fetch adAccountId
    const campaignGroup = await this.prisma.campaignGroup.findUnique({
      where: { id },
      select: { id: true, adAccountId: true, changeAuditStamps: true },
    });
    if (!campaignGroup) {
      this.logger.error(`Campaign group not found for id: ${id}`);
      throw new Error('Campaign group not found');
    }

    // Validate adAccountId exists in database
    const adAccount = await this.prisma.adAccount.findUnique({
      where: { id: campaignGroup.adAccountId },
      select: { id: true, accountUrn: true },
    });
    if (!adAccount) {
      this.logger.error(
        `Ad account not found for id: ${campaignGroup.adAccountId}`,
      );
      throw new Error('Ad account not found');
    }

    // Prepare LinkedIn API patch payload
    const patchPayload: { patch: { $set: Record<string, any> } } = {
      patch: {
        $set: {},
      },
    };
    if (data.name) {
      patchPayload.patch.$set.name = data.name;
    }
    if (data.status) {
      patchPayload.patch.$set.status = data.status;
    }
    if (data.runSchedule) {
      patchPayload.patch.$set.runSchedule = {
        ...(data.runSchedule.start && { start: data.runSchedule.start }),
        ...(data.runSchedule.end && { end: data.runSchedule.end }),
      };
    }
    if (data.totalBudget) {
      patchPayload.patch.$set.totalBudget = {
        amount: data.totalBudget.amount,
        currencyCode: data.totalBudget.currencyCode,
      };
    }

    // Skip API call if no fields to update
    if (Object.keys(patchPayload.patch.$set).length === 0) {
      this.logger.warn('No fields provided to update for campaign group');
      throw new Error('No valid fields provided for update');
    }

    this.logger.log(
      `Prepared LinkedIn patch payload: ${JSON.stringify(patchPayload, null, 2)}`,
    );

    try {
      // Get LinkedIn access token
      const accessToken = await this.linkedinService.getValidAccessToken();
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        'LinkedIn-Version': '202505',
        'X-RestLi-Protocol-Version': '2.0.0',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };

      // Step 1: Update campaign group on LinkedIn
      this.logger.log(
        `Sending request to LinkedIn API to update campaign group with id: ${id} for adAccountId: ${campaignGroup.adAccountId}`,
      );
      const linkedinResponse = await axios.post<{}>(
        `https://api.linkedin.com/rest/adAccounts/${campaignGroup.adAccountId}/adCampaignGroups/${id}`,
        patchPayload,
        { headers },
      );
      // Validate status code
      if (linkedinResponse.status !== 204) {
        this.logger.error(
          `Unexpected response status: ${linkedinResponse.status}`,
        );
        throw new Error(
          `Failed to update campaign group: Received status ${linkedinResponse.status}`,
        );
      }

      // Step 2: Update campaign group in database
      const currentTime = Date.now();
      const updatedCampaignGroup = await this.prisma.campaignGroup.update({
        where: { id },
        data: {
          ...(data.name && { name: data.name }),
          ...(data.status && { status: data.status }),
          ...(data.runSchedule && {
            runSchedule: {
              start: data.runSchedule.start ?? undefined,
              end: data.runSchedule.end ?? undefined,
            },
          }),
          ...(data.totalBudget && {
            totalBudget: {
              amount: data.totalBudget.amount,
              currencyCode: data.totalBudget.currencyCode,
            },
          }),
          updatedAt: new Date(),
        },
      });

      this.logger.log(
        `Successfully updated campaign group in database: ${JSON.stringify(
          updatedCampaignGroup,
          null,
          2,
        )}`,
      );

      return {
        success: true,
        message: 'Campaign group updated successfully',
        data: updatedCampaignGroup,
      };
    } catch (error: any) {
      if (error.response) {
        this.logger.error(
          `LinkedIn API Error: ${error.response.status} - ${JSON.stringify(
            error.response.data,
            null,
            2,
          )}`,
          {
            request: {
              url: error.config?.url,
              method: error.config?.method,
              headers: error.config?.headers,
              data: error.config?.data,
            },
          },
        );
        if (error.response.status === 401) {
          throw new UnauthorizedException('Invalid or expired access token');
        }
        if (error.response.status === 403) {
          throw new ForbiddenException(
            'Missing required scopes (r_ads, rw_ads) or insufficient permissions',
          );
        }
        if (error.response.status === 429) {
          throw new Error('Rate limit exceeded');
        }
        if (error.response.status === 400) {
          throw new Error(
            `Invalid request: ${JSON.stringify(error.response.data)}`,
          );
        }
        if (error.response.status === 404) {
          throw new Error('Campaign group or ad account not found');
        }
      }
      this.logger.error(`Failed to update campaign group: ${error.message}`);
      throw new Error('Failed to update campaign group');
    }
  }

  async removeCampaignGroup(id: string) {
    this.logger.log(`Received request to delete campaign group with id: ${id}`);

    // Validate campaign group exists and fetch status and adAccountId
    const campaignGroup = await this.prisma.campaignGroup.findUnique({
      where: { id },
      select: { id: true, status: true, adAccountId: true },
    });
    if (!campaignGroup) {
      this.logger.error(`Campaign group not found for id: ${id}`);
      throw new Error('Campaign group not found');
    }

    // Validate adAccountId exists
    const adAccount = await this.prisma.adAccount.findUnique({
      where: { id: campaignGroup.adAccountId },
      select: { id: true },
    });
    if (!adAccount) {
      this.logger.error(
        `Ad account not found for id: ${campaignGroup.adAccountId}`,
      );
      throw new Error('Ad account not found');
    }

    try {
      // Get LinkedIn access token
      const accessToken = await this.linkedinService.getValidAccessToken();
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        'LinkedIn-Version': '202505',
        'X-RestLi-Protocol-Version': '2.0.0',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };

      // Check campaign group status
      const isDraft = campaignGroup.status === CampaignStatus.DRAFT;

      if (isDraft) {
        // Step 1: Delete DRAFT campaign group on LinkedIn
        this.logger.log(`Deleting DRAFT campaign group with id: ${id}`);
        const linkedinResponse = await axios.delete(
          `https://api.linkedin.com/rest/adAccounts/${campaignGroup.adAccountId}/adCampaignGroups/${id}`,
          { headers },
        );

        // Validate response status
        if (linkedinResponse.status !== 204) {
          this.logger.error(
            `Unexpected response status: ${linkedinResponse.status}`,
          );
          throw new Error(
            `Failed to delete campaign group: Received status ${linkedinResponse.status}`,
          );
        }

        // Step 2: Delete campaign group from database
        await this.prisma.campaignGroup.delete({
          where: { id },
        });

        this.logger.log(
          `Successfully deleted campaign group with id: ${id} from database`,
        );

        return {
          success: true,
          message: 'Campaign group deleted successfully',
          data: { id },
        };
      } else {
        // Step 1: Update non-DRAFT campaign group to PENDING_DELETION on LinkedIn
        this.logger.log(
          `Setting campaign group with id: ${id} to PENDING_DELETION`,
        );
        const patchPayload = {
          patch: {
            $set: {
              status: 'PENDING_DELETION',
            },
          },
        };

        const linkedinResponse = await axios.post(
          `https://api.linkedin.com/rest/adAccounts/${campaignGroup.adAccountId}/adCampaignGroups/${id}`,
          patchPayload,
          { headers },
        );

        // Validate response status
        if (linkedinResponse.status !== 204) {
          this.logger.error(
            `Unexpected response status: ${linkedinResponse.status}`,
          );
          throw new Error(
            `Failed to update campaign group status: Received status ${linkedinResponse.status}`,
          );
        }

        // Step 2: Update campaign group status in database
        await this.prisma.campaignGroup.delete({
          where: { id },
        });

        this.logger.log(
          `Successfully updated campaign group with id: ${id} to PENDING_DELETION in database`,
        );

        return {
          success: true,
          message: 'Campaign group status updated to PENDING_DELETION',
          data: { id },
        };
      }
    } catch (error: any) {
      if (error.response) {
        this.logger.error(
          `LinkedIn API Error: ${error.response.status} - ${JSON.stringify(
            error.response.data,
            null,
            2,
          )}`,
          {
            request: {
              url: error.config?.url,
              method: error.config?.method,
              headers: error.config?.headers,
              data: error.config?.data,
            },
          },
        );
        if (error.response.status === 401) {
          throw new UnauthorizedException('Invalid or expired access token');
        }
        if (error.response.status === 403) {
          throw new ForbiddenException(
            'Missing required scopes (r_ads, rw_ads) or insufficient permissions',
          );
        }
        if (error.response.status === 429) {
          throw new Error('Rate limit exceeded');
        }
        if (error.response.status === 400) {
          throw new Error(
            `Invalid request: ${JSON.stringify(error.response.data)}`,
          );
        }
        if (error.response.status === 404) {
          throw new Error('Campaign group or ad account not found');
        }
      }
      this.logger.error(`Failed to remove campaign group: ${error.message}`);
      throw new Error('Failed to remove campaign group');
    }
  }

  ///////////////////////////// CAMPAIGNS ///////////////////////////////////////

  async createLinkedInCampaign(
    data: LinkedInCampaignInput,
  ): Promise<{ success: boolean; message: string; data?: any }> {
    this.logger.log(
      `Received LinkedIn campaign data: ${JSON.stringify(data, null, 2)}`,
    );

    // Fetch organization
    const org = await this.prisma.organization.findUnique({
      where: { id: 'single-org' },
    });
    if (!org) {
      this.logger.error(`Organization not found for id: single-org`);
      throw new Error('Organization not found');
    }

    // Fetch platform
    const platform = await this.prisma.marketingPlatform.findFirst({
      where: { orgId: org.id, platform_name: 'LinkedIn' },
    });
    if (!platform) {
      this.logger.error('LinkedIn platform not found for organization');
      throw new Error('LinkedIn platform not configured');
    }

    // URN validation
    const validateURN = (
      urn: string,
      facetType: string = 'unknown',
    ): boolean => {
      let isValid: boolean;
      if (facetType === 'titles') {
        isValid = /^urn:li:title:\d+$/.test(urn); // Stricter for titles
      } else {
        isValid =
          /^urn:li:(locale|geo|industry|seniority|staffCountRange):[a-zA-Z0-9:_,\(\)]+$/.test(
            urn,
          );
      }
      if (!isValid) {
        this.logger.warn(`Invalid URN detected for ${facetType}: ${urn}`);
      }
      return isValid;
    };

    // Facet configuration
    const facetConfig = [
      { key: 'interfaceLocales', path: 'interfaceLocales' },
      { key: 'locations', path: 'locations' },
      { key: 'industries', path: 'industries' },
      { key: 'seniorities', path: 'seniorities' },
      { key: 'titles', path: 'titles' }, // Use titles
      { key: 'staffCountRanges', path: 'staffCountRanges' },
    ];

    // Build include facets
    const includeFacets = facetConfig
      .map(({ key, path }) => ({
        key,
        values: data.targetingCriteria[path].include
          .map((item) => item.value)
          .filter((urn) => validateURN(urn, key)),
      }))
      .filter((facet) => facet.values.length > 0)
      .map((facet) => ({
        or: { [`urn:li:adTargetingFacet:${facet.key}`]: facet.values },
      }));

    // Build exclude facets
    const excludeFacets = facetConfig
      .map(({ key, path }) => ({
        key,
        values: data.targetingCriteria[path].exclude
          .map((item) => item.value)
          .filter((urn) => validateURN(urn, key)),
      }))
      .filter((facet) => facet.values.length > 0);

    // Check campaign compatibility for titles
    const hasTitles = includeFacets.some((facet) =>
      Object.keys(facet.or).includes('urn:li:adTargetingFacet:titles'),
    );
    if (hasTitles) {
      const unsupportedFormats = ['TEXT_AD', 'SPONSORED_INMAIL'];
      if (data.format && unsupportedFormats.includes(data.format)) {
        this.logger.error(
          `Campaign format ${data.format} does not support titles targeting`,
        );
        throw new Error(
          `Campaign format ${data.format} does not support titles targeting`,
        );
      }
    }

    // Validate at least one include facet
    if (includeFacets.length === 0) {
      this.logger.error('No valid include facets provided');
      throw new Error('At least one valid include facet must be provided');
    }

    // Transform input data for LinkedIn API
    const cleanedData = {
      account: `urn:li:sponsoredAccount:${data.account}`,
      campaignGroup: `urn:li:sponsoredCampaignGroup:${data.campaignGroup}`,
      audienceExpansionEnabled: data.audienceExpansion ?? false,
      costType: data.costType,
      connectedTelevisionOnly: false,
      creativeSelection: 'OPTIMIZED',
      dailyBudget: {
        amount: data.dailyBudget?.amount ?? '0',
        currencyCode: data.dailyBudget?.currencyCode ?? 'USD',
      },
      locale: {
        country: data.locale?.country ?? 'US',
        language: data.locale?.language ?? 'en',
      },
      name: data.name,
      objectiveType: data.objectiveType ?? 'BRAND_AWARENESS',
      offsiteDeliveryEnabled: data.offsiteDeliveryEnabled ?? false,
      runSchedule: {
        start: data.runSchedule?.start ?? Date.now(),
        ...(data.runSchedule?.end && { end: data.runSchedule.end }),
      },
      status: data.status ?? 'DRAFT',
      targetingCriteria: {
        include: { and: includeFacets },
        ...(excludeFacets.length > 0 && {
          exclude: {
            or: Object.fromEntries(
              excludeFacets.map((facet) => [
                `urn:li:adTargetingFacet:${facet.key}`,
                facet.values,
              ]),
            ),
          },
        }),
      } as LinkedInApiTargetingCriteria,
      type: data.campaignType,
      format: data.format,
      unitCost: {
        amount: data.unitCost?.amount ?? '0',
        currencyCode: data.unitCost?.currencyCode ?? 'USD',
      },
      ...(data.associatedEntity && { associatedEntity: data.associatedEntity }),
      ...(data.totalBudget?.amount &&
        data.totalBudget.amount !== '0' && {
          totalBudget: {
            amount: data.totalBudget.amount,
            currencyCode: data.totalBudget.currencyCode ?? 'USD',
          },
        }),
      ...(data.pacingStrategy && { pacingStrategy: data.pacingStrategy }),
    };

    // Build dbTargetingCriteria
    const dbTargetingCriteria = {
      include: {
        and: facetConfig
          .map(({ key, path }) => ({
            key,
            values: data.targetingCriteria[path].include
              .filter((item) => validateURN(item.value, key))
              .map((item) => ({
                urn: item.value,
                name: item.text || 'Unnamed',
              })),
          }))
          .filter((facet) => facet.values.length > 0)
          .map((facet) => ({
            or: { [`urn:li:adTargetingFacet:${facet.key}`]: facet.values },
          })),
      },
      ...(excludeFacets.length > 0 && {
        exclude: {
          or: Object.fromEntries(
            facetConfig
              .map(({ key, path }) => ({
                key,
                values: data.targetingCriteria[path].exclude
                  .filter((item) => validateURN(item.value, key))
                  .map((item) => ({
                    urn: item.value,
                    name: item.text || 'Unnamed',
                  })),
              }))
              .filter((facet) => facet.values.length > 0)
              .map((facet) => [
                `urn:li:adTargetingFacet:${facet.key}`,
                facet.values,
              ]),
          ),
        },
      }),
    };

    this.logger.log(
      `Cleaned LinkedIn campaign data: ${JSON.stringify(cleanedData, null, 2)}`,
    );

    try {
      // Get LinkedIn access token
      const accessToken = await this.linkedinService.getValidAccessToken();
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        'LinkedIn-Version': '202505',
        'X-RestLi-Protocol-Version': '2.0.0',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };

      // Create campaign on LinkedIn
      const adAccountId = data.account;
      this.logger.log(
        `Sending request to LinkedIn API to create campaign for adAccountId: ${adAccountId}`,
      );
      const linkedinResponse = await axios.post<{}>(
        `https://api.linkedin.com/rest/adAccounts/${adAccountId}/adCampaigns`,
        cleanedData,
        { headers },
      );

      this.logger.log(`Response status: ${linkedinResponse.status}`);
      this.logger.debug(
        `Response headers: ${JSON.stringify(linkedinResponse.headers, null, 2)}`,
      );

      if (linkedinResponse.status !== 201) {
        this.logger.error(
          `Unexpected response status: ${linkedinResponse.status}`,
        );
        throw new Error(
          `Failed to create campaign: Received status ${linkedinResponse.status}`,
        );
      }

      // Extract campaign ID
      let campaignId =
        linkedinResponse.headers['x-restli-id'] ||
        linkedinResponse.headers['x-linkedin-id'];
      if (!campaignId) {
        const locationHeader = linkedinResponse.headers['location'];
        if (locationHeader) {
          const match = locationHeader.match(/\/adCampaigns\/(\d+)$/);
          campaignId = match ? match[1] : null;
        }
        if (!campaignId) {
          this.logger.error('No campaign ID found in headers');
          throw new Error('Failed to retrieve campaign ID');
        }
      }

      this.logger.log(
        `Successfully created campaign on LinkedIn with ID: ${campaignId}`,
      );

      // Persist in database
      const campaign = await this.prisma.marketingCampaign.create({
        data: {
          campaign_name: data.name,
          platform_id: platform.platform_id,
          external_id: campaignId,
          ad_account_id: adAccountId,
          campaign_group_id: data.campaignGroup,
          associated_entity: data.associatedEntity?.split(':').pop() ?? null,
          objective: data.objectiveType
            ? mapToPrismaEnum(data.objectiveType, ObjectiveType, null)
            : null,
          type: mapToPrismaEnum(data.campaignType, CampaignType, null),
          format: data.format
            ? mapToPrismaEnum(data.format, Format, null)
            : null,
          status: data.status
            ? (mapToPrismaEnum(
                data.status,
                CampaignStatus,
                CampaignStatus.DRAFT,
              ) as CampaignStatus)
            : CampaignStatus.DRAFT,
          creative_selection: 'OPTIMIZED',
          serving_statuses: [],
          budget: parseFloat(data.dailyBudget?.amount ?? '0') || null,
          total_budget:
            data.totalBudget?.amount && data.totalBudget.amount !== '0'
              ? parseFloat(data.totalBudget.amount)
              : null,
          unit_cost: parseFloat(data.unitCost?.amount ?? '0') || null,
          cost_type: mapToPrismaEnum(data.costType, CostType, null),
          currency_code: data.dailyBudget?.currencyCode ?? 'USD',
          start_date: new Date(data.runSchedule?.start ?? Date.now()),
          end_date: data.runSchedule?.end
            ? new Date(data.runSchedule.end)
            : null,
          audience_expansion: data.audienceExpansion ?? false,
          offsite_delivery_enabled: data.offsiteDeliveryEnabled ?? false,
          pacing_strategy: data.pacingStrategy ?? null,
          locale: `${data.locale?.language ?? 'en'}_${data.locale?.country ?? 'US'}`,
          created_at: new Date(),
          updated_at: new Date(),
          data: { targetingCriteria: dbTargetingCriteria },
        },
      });

      this.logger.log(
        `Successfully saved campaign to database: ${JSON.stringify(campaign, null, 2)}`,
      );

      return {
        success: true,
        message: 'LinkedIn campaign created successfully',
        data: campaign,
      };
    } catch (error: any) {
      if (error.response) {
        this.logger.error(
          `LinkedIn API Error: ${error.response.status} - ${JSON.stringify(error.response.data)}`,
          {
            request: {
              url: error.config?.url,
              method: error.config?.method,
              headers: error.config?.headers,
              data: error.config?.data,
            },
          },
        );
        if (error.response.status === 401) {
          throw new UnauthorizedException('Invalid or expired access token');
        }
        if (error.response.status === 403) {
          throw new ForbiddenException(
            'Missing required scopes (r_ads, rw_ads) or insufficient permissions',
          );
        }
        if (error.response.status === 429) {
          throw new Error('Rate limit exceeded');
        }
        if (error.response.status === 400) {
          throw new Error(
            `Invalid request: ${JSON.stringify(error.response.data)}`,
          );
        }
        if (error.response.status === 404) {
          throw new Error('Ad account not found');
        }
      }
      this.logger.error(
        `Failed to create LinkedIn campaign: ${error.message}`,
        error.stack,
      );
      throw new Error('Failed to create LinkedIn campaign');
    }
  }
  async updateLinkedInCampaign(
    campaignId: string,
    data: LinkedInCampaignInput,
  ): Promise<{ success: boolean; message: string; data?: any }> {
    this.logger.log(
      `Received LinkedIn campaign data for campaignId: ${campaignId}, data: ${JSON.stringify(data, null, 2)}`,
    );

    // Fetch organization
    const org = await this.prisma.organization.findUnique({
      where: { id: 'single-org' },
    });
    if (!org) {
      this.logger.error(`No organization found for id: single-org`);
      throw new Error('Organization not found');
    }

    // Fetch platform
    const platform = await this.prisma.marketingPlatform.findFirst({
      where: { orgId: org.id, platform_name: 'LinkedIn' },
    });
    if (!platform) {
      this.logger.error('LinkedIn platform not found for organization');
      throw new Error('LinkedIn platform not configured');
    }

    // Fetch existing campaign
    const existingCampaign = await this.prisma.marketingCampaign.findUnique({
      where: { external_id: campaignId },
    });
    if (!existingCampaign) {
      this.logger.error(`Campaign not found for external_id: ${campaignId}`);
      throw new Error('Campaign not found');
    }

    // Log campaign details for debugging
    this.logger.log(
      `Existing campaign type: ${existingCampaign.type}, format: ${existingCampaign.format}, status: ${existingCampaign.status}`,
    );

    const validateURN = (
      urn: string,
      facetType: string = 'unknown',
    ): boolean => {
      let isValid: boolean;
      if (facetType === 'titles') {
        isValid = /^urn:li:title:\d+$/.test(urn); // Stricter for job titles
      } else {
        isValid =
          /^urn:li:(locale|geo|industry|seniority|staffCountRange):[a-zA-Z0-9:_,\(\)]+$/.test(
            urn,
          );
      }
      if (!isValid) {
        this.logger.warn(`Invalid URN detected for ${facetType}: ${urn}`);
      }
      return isValid;
    };

    // Define immutable fields
    const immutableFields = [
      'format',
      'campaignType',
      ...(existingCampaign.status !== 'DRAFT'
        ? ['costType', 'runSchedule.start', 'pacingStrategy']
        : []),
    ];

    // Normalize existing targetingCriteria
    const normalizeTargetingCriteria = (
      targeting: any,
    ): LinkedInApiTargetingCriteria => {
      if (
        !targeting ||
        typeof targeting !== 'object' ||
        !targeting.include?.and ||
        !Array.isArray(targeting.include.and)
      ) {
        return { include: { and: [] } };
      }

      const normalized: LinkedInApiTargetingCriteria = {
        include: {
          and: targeting.include.and
            .map((facet: any) => {
              if (!facet?.or || typeof facet.or !== 'object') return null;
              const facetType = Object.keys(facet.or)[0];
              const values = facet.or[facetType];
              if (!Array.isArray(values)) return null;
              const normalizedValues = values
                .map((item: any) => {
                  if (
                    item &&
                    typeof item === 'object' &&
                    'urn' in item &&
                    item.urn
                  ) {
                    // Use fallback 'unknown' for facetType
                    return validateURN(
                      item.urn,
                      facetType.split(':').pop() || 'unknown',
                    )
                      ? String(item.urn)
                      : null;
                  }
                  // Handle string items
                  return typeof item === 'string' &&
                    validateURN(item, facetType.split(':').pop() || 'unknown')
                    ? String(item)
                    : null;
                })
                .filter((item): item is string => item !== null);
              if (normalizedValues.length === 0) return null;
              return { or: { [facetType]: normalizedValues } };
            })
            .filter(
              (item): item is { or: { [key: string]: string[] } } =>
                item !== null,
            ),
        },
      };

      if (targeting.exclude?.or && typeof targeting.exclude.or === 'object') {
        normalized.exclude = {
          or: Object.fromEntries(
            Object.entries(targeting.exclude.or)
              .map(([key, values]: [string, any]) => {
                if (!Array.isArray(values)) return null;
                const normalizedValues = values
                  .map((item: any) => {
                    if (
                      item &&
                      typeof item === 'object' &&
                      'urn' in item &&
                      item.urn
                    ) {
                      return validateURN(
                        item.urn,
                        key.split(':').pop() || 'unknown',
                      )
                        ? String(item.urn)
                        : null;
                    }
                    return typeof item === 'string' &&
                      validateURN(item, key.split(':').pop() || 'unknown')
                      ? String(item)
                      : null;
                  })
                  .filter((item): item is string => item !== null);
                if (normalizedValues.length === 0) return null;
                return [key, normalizedValues];
              })
              .filter((entry): entry is [string, string[]] => entry !== null),
          ),
        };
      }

      return normalized;
    };

    const facetConfig = [
      { key: 'interfaceLocales', path: 'interfaceLocales' },
      { key: 'locations', path: 'locations' },
      { key: 'industries', path: 'industries' },
      { key: 'seniorities', path: 'seniorities' },
      { key: 'titles', path: 'titles' }, // Use titles, not jobTitles
      { key: 'staffCountRanges', path: 'staffCountRanges' },
    ];

    const includeFacets = facetConfig
      .map(({ key, path }) => ({
        key,
        values: data.targetingCriteria[path].include
          .map((item) => item.value)
          .filter((urn) => validateURN(urn, key)),
      }))
      .filter((facet) => facet.values.length > 0)
      .map((facet) => ({
        or: { [`urn:li:adTargetingFacet:${facet.key}`]: facet.values },
      }));

    const excludeFacets = facetConfig
      .map(({ key, path }) => ({
        key,
        values: data.targetingCriteria[path].exclude
          .map((item) => item.value)
          .filter((urn) => validateURN(urn, key)),
      }))
      .filter((facet) => facet.values.length > 0);

    // Check campaign compatibility
    const hasTitles = includeFacets.some((facet) =>
      Object.keys(facet.or).includes('urn:li:adTargetingFacet:titles'),
    );
    if (hasTitles) {
      const unsupportedFormats = ['TEXT_AD', 'SPONSORED_INMAIL'];
      if (data.format && unsupportedFormats.includes(data.format)) {
        this.logger.error(
          `Campaign format ${data.format} does not support titles targeting`,
        );
        throw new Error(
          `Campaign format ${data.format} does not support titles targeting`,
        );
      }
    }

    const cleanedData = {
      account: `urn:li:sponsoredAccount:${data.account}`,
      campaignGroup: `urn:li:sponsoredCampaignGroup:${data.campaignGroup}`,
      audienceExpansionEnabled: data.audienceExpansion ?? false,
      costType: data.costType,
      connectedTelevisionOnly: false,
      creativeSelection: 'OPTIMIZED',
      dailyBudget: {
        amount: data.dailyBudget.amount,
        currencyCode: data.dailyBudget.currencyCode,
      },
      locale: {
        country: data.locale.country,
        language: data.locale.language,
      },
      name: data.name,
      objectiveType: data.objectiveType ?? 'BRAND_AWARENESS',
      offsiteDeliveryEnabled: data.offsiteDeliveryEnabled ?? false,
      runSchedule: {
        start: data.runSchedule.start,
        ...(data.runSchedule.end && { end: data.runSchedule.end }),
      },
      status: data.status,
      targetingCriteria: {
        include: { and: includeFacets },
        ...(excludeFacets.length > 0 && {
          exclude: {
            or: Object.fromEntries(
              excludeFacets.map((facet) => [
                `urn:li:adTargetingFacet:${facet.key}`,
                facet.values,
              ]),
            ),
          },
        }),
      } as LinkedInApiTargetingCriteria,
      type: data.campaignType,
      format: data.format,
      unitCost: {
        amount: data.unitCost.amount,
        currencyCode: data.unitCost.currencyCode,
      },
      ...(data.associatedEntity && { associatedEntity: data.associatedEntity }),
      ...(data.totalBudget.amount !== '0' && {
        totalBudget: {
          amount: data.totalBudget.amount,
          currencyCode: data.totalBudget.currencyCode,
        },
      }),
      ...(data.pacingStrategy && { pacingStrategy: data.pacingStrategy }),
    };

    const dbTargetingCriteria = {
      include: {
        and: facetConfig
          .map(({ key, path }) => ({
            key,
            values: data.targetingCriteria[path].include
              .filter((item) => validateURN(item.value, key))
              .map((item) => ({
                urn: item.value,
                name: item.text || 'Unnamed',
              })),
          }))
          .filter((facet) => facet.values.length > 0)
          .map((facet) => ({
            or: { [`urn:li:adTargetingFacet:${facet.key}`]: facet.values },
          })),
      },
      ...(excludeFacets.length > 0 && {
        exclude: {
          or: Object.fromEntries(
            facetConfig
              .map(({ key, path }) => ({
                key,
                values: data.targetingCriteria[path].exclude
                  .filter((item) => validateURN(item.value, key))
                  .map((item) => ({
                    urn: item.value,
                    name: item.text || 'Unnamed',
                  })),
              }))
              .filter((facet) => facet.values.length > 0)
              .map((facet) => [
                `urn:li:adTargetingFacet:${facet.key}`,
                facet.values,
              ]),
          ),
        },
      }),
    };

    const existingCleanedData = {
      account: `urn:li:sponsoredAccount:${existingCampaign.ad_account_id}`,
      campaignGroup: `urn:li:sponsoredCampaignGroup:${existingCampaign.campaign_group_id}`,
      audienceExpansionEnabled: existingCampaign.audience_expansion ?? false,
      costType: existingCampaign.cost_type,
      connectedTelevisionOnly: false,
      creativeSelection: 'OPTIMIZED',
      dailyBudget: {
        amount: existingCampaign.budget?.toString() || undefined,
        currencyCode: existingCampaign.currency_code,
      },
      locale: {
        country: existingCampaign.locale?.split('_')[1] || 'US',
        language: existingCampaign.locale?.split('_')[0] || 'en',
      },
      name: existingCampaign.campaign_name,
      objectiveType: existingCampaign.objective ?? 'BRAND_AWARENESS',
      offsiteDeliveryEnabled:
        existingCampaign.offsite_delivery_enabled ?? false,
      runSchedule: {
        start: existingCampaign.start_date?.getTime(),
        ...(existingCampaign.end_date && {
          end: existingCampaign.end_date.getTime(),
        }),
      },
      status: existingCampaign.status,
      targetingCriteria: normalizeTargetingCriteria(
        typeof existingCampaign.data === 'object' &&
          existingCampaign.data !== null &&
          'targetingCriteria' in existingCampaign.data
          ? existingCampaign.data.targetingCriteria
          : { include: { and: [] } },
      ),
      type: existingCampaign.type,
      format: existingCampaign.format || undefined,
      unitCost: {
        amount: existingCampaign.unit_cost?.toString() || '0',
        currencyCode: existingCampaign.currency_code,
      },
      associatedEntity: existingCampaign.associated_entity
        ? `urn:li:organization:${existingCampaign.associated_entity}`
        : undefined,
      ...(existingCampaign.total_budget && {
        totalBudget: {
          amount: existingCampaign.total_budget.toString(),
          currencyCode: existingCampaign.currency_code,
        },
      }),
      pacingStrategy: existingCampaign.pacing_strategy || undefined,
    };

    const changedFields: any = {};
    const deepCompare = (newVal: any, oldVal: any, path: string = '') => {
      if (newVal === oldVal || (newVal == null && oldVal == null)) return;
      if (Array.isArray(newVal) && Array.isArray(oldVal)) {
        if (
          JSON.stringify(newVal) !== JSON.stringify(oldVal) &&
          !immutableFields.includes(path)
        ) {
          changedFields[path] = { new: newVal, old: oldVal };
        }
        return;
      }
      if (
        typeof newVal === 'object' &&
        newVal !== null &&
        typeof oldVal === 'object' &&
        oldVal !== null
      ) {
        const keys = new Set([...Object.keys(newVal), ...Object.keys(oldVal)]);
        for (const key of keys) {
          deepCompare(
            newVal[key] ?? null,
            oldVal[key] ?? null,
            `${path ? `${path}.` : ''}${key}`,
          );
        }
        return;
      }
      if (
        newVal !== oldVal &&
        !immutableFields.includes(path) &&
        !(
          typeof newVal === 'string' &&
          typeof oldVal === 'number' &&
          newVal === oldVal.toString()
        )
      ) {
        changedFields[path] = { new: newVal, old: oldVal };
      }
    };

    this.logger.debug(
      `Before deepCompare - cleanedData: ${JSON.stringify(cleanedData, null, 2)}`,
    );
    this.logger.debug(
      `Before deepCompare - existingCleanedData: ${JSON.stringify(existingCleanedData, null, 2)}`,
    );
    deepCompare(cleanedData, existingCleanedData);

    if (Object.keys(changedFields).length === 0) {
      this.logger.log(`No changes detected for campaignId: ${campaignId}`);
      return { success: true, message: 'No changes to update' };
    }

    this.logger.log(
      `Changed fields: ${JSON.stringify(changedFields, null, 2)}`,
    );

    const patchPayload: { patch: { $set: any } } = { patch: { $set: {} } };
    for (const key in changedFields) {
      const value = changedFields[key].new;
      this.logger.debug(
        `Processing changed field: ${key}, value: ${JSON.stringify(value)}`,
      );
      if (key.includes('.')) {
        const pathParts = key.split('.');
        let current = patchPayload.patch.$set;
        for (let i = 0; i < pathParts.length - 1; i++) {
          const part = pathParts[i];
          if (!current[part]) current[part] = {};
          current = current[part];
        }
        current[pathParts[pathParts.length - 1]] = value;
      } else {
        patchPayload.patch.$set[key] = value;
      }
    }

    if (patchPayload.patch.$set.runSchedule?.end === undefined) {
      delete patchPayload.patch.$set.runSchedule?.end;
    }
    if (
      patchPayload.patch.$set.targetingCriteria?.exclude === null ||
      Object.keys(patchPayload.patch.$set.targetingCriteria?.exclude?.or || {})
        .length === 0
    ) {
      delete patchPayload.patch.$set.targetingCriteria?.exclude;
    }

    this.logger.log(
      `LinkedIn patch payload: ${JSON.stringify(patchPayload, null, 2)}`,
    );

    try {
      const accessToken = await this.linkedinService.getValidAccessToken();
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        'LinkedIn-Version': '202505',
        'X-RestLi-Protocol-Version': '2.0.0',
        'X-RestLi-Method': 'PARTIAL_UPDATE',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };

      const adAccountId = data.account;
      this.logger.log(
        `Sending update request to LinkedIn API for adAccountId: ${adAccountId}, campaignId: ${campaignId}`,
      );
      const linkedinResponse = await axios.post<{}>(
        `https://api.linkedin.com/rest/adAccounts/${adAccountId}/adCampaigns/${campaignId}`,
        patchPayload,
        { headers },
      );

      this.logger.log(
        `LinkedIn API response status: ${linkedinResponse.status}`,
      );
      this.logger.debug(
        `LinkedIn API response headers: ${JSON.stringify(linkedinResponse.headers, null, 2)}`,
      );
      this.logger.debug(
        `LinkedIn API response body: ${JSON.stringify(linkedinResponse.data, null, 2)}`,
      );

      if (linkedinResponse.status !== 204) {
        this.logger.error(
          `Unexpected LinkedIn API response status: ${linkedinResponse.status}`,
        );
        throw new Error(
          `Failed to update campaign: Received status ${linkedinResponse.status}`,
        );
      }

      this.logger.log(
        `Successfully updated campaign on LinkedIn with ID: ${campaignId}`,
      );

      const updatedCampaign = await this.prisma.marketingCampaign.update({
        where: { external_id: campaignId },
        data: {
          campaign_name: data.name,
          ad_account_id: data.account,
          campaign_group_id: data.campaignGroup,
          associated_entity: data.associatedEntity?.split(':').pop() || null,
          objective: data.objectiveType
            ? mapToPrismaEnum(data.objectiveType, ObjectiveType, null)
            : null,
          type: immutableFields.includes('campaignType')
            ? existingCampaign.type
            : mapToPrismaEnum(data.campaignType, CampaignType, null),
          format: data.format
            ? mapToPrismaEnum(data.format, Format, null)
            : null,
          status: data.status
            ? (mapToPrismaEnum(
                data.status,
                CampaignStatus,
                CampaignStatus.DRAFT,
              ) as CampaignStatus)
            : CampaignStatus.DRAFT,
          budget: parseFloat(data.dailyBudget.amount) || null,
          total_budget:
            data.totalBudget.amount !== '0'
              ? parseFloat(data.totalBudget.amount)
              : null,
          unit_cost: parseFloat(data.unitCost.amount) || null,
          cost_type: immutableFields.includes('costType')
            ? existingCampaign.cost_type
            : mapToPrismaEnum(data.costType, CostType, null),
          currency_code: data.dailyBudget.currencyCode,
          start_date: immutableFields.includes('runSchedule.start')
            ? existingCampaign.start_date
            : new Date(data.runSchedule.start),
          end_date: data.runSchedule.end
            ? new Date(data.runSchedule.end)
            : null,
          audience_expansion: data.audienceExpansion ?? false,
          offsite_delivery_enabled: data.offsiteDeliveryEnabled ?? false,
          pacing_strategy: immutableFields.includes('pacingStrategy')
            ? existingCampaign.pacing_strategy
            : data.pacingStrategy || null,
          locale: `${data.locale.language}_${data.locale.country}`,
          updated_at: new Date(),
          data: {
            targetingCriteria: dbTargetingCriteria as Record<string, any>,
          },
        },
      });

      this.logger.log(
        `Successfully updated campaign in database: ${JSON.stringify(updatedCampaign, null, 2)}`,
      );

      return {
        success: true,
        message: 'LinkedIn campaign updated successfully',
        data: updatedCampaign,
      };
    } catch (error: any) {
      if (error.response) {
        this.logger.error(
          `LinkedIn API Error: ${error.response.status} - ${JSON.stringify(error.response.data)}`,
          {
            request: {
              url: error.config?.url,
              method: error.config?.method,
              headers: error.config?.headers,
              data: error.config?.data,
            },
          },
        );
        if (error.response.status === 401) {
          throw new UnauthorizedException('Invalid or expired access token');
        }
        if (error.response.status === 403) {
          throw new ForbiddenException(
            'Missing required scopes (r_ads, rw_ads) or insufficient permissions',
          );
        }
        if (error.response.status === 429) {
          throw new Error('Rate limit exceeded');
        }
        if (error.response.status === 400) {
          throw new Error(
            `Invalid request: ${JSON.stringify(error.response.data)}`,
          );
        }
        if (error.response.status === 404) {
          throw new Error('Campaign or ad account not found');
        }
      }
      this.logger.error(
        `Failed to update LinkedIn campaign: ${error.message}, stack: ${error.stack}`,
      );
      throw new Error('Failed to update LinkedIn campaign');
    }
  }

  async deleteLinkedInCampaign(
    campaignId: string,
  ): Promise<{ success: boolean; message: string; data: { id: string } }> {
    this.logger.log(
      `Received request to delete LinkedIn campaign with ID: ${campaignId}`,
    );

    // Validate campaign exists and fetch status and adAccountId
    const campaign = await this.prisma.marketingCampaign.findUnique({
      where: { campaign_id: campaignId },
      select: { external_id: true, status: true, ad_account_id: true },
    });
    if (!campaign) {
      this.logger.error(`Campaign with id: ${campaignId} not found`);
      throw new Error('LinkedInCampaign not found');
    }

    try {
      // Get LinkedIn access token
      const accessToken = await this.linkedinService.getValidAccessToken();
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        'LinkedIn-Version': '202505',
        'X-RestLi-Protocol-Version': '2.0.0',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };

      // Check campaign status
      const isDraft = campaign.status === CampaignStatus.DRAFT;

      if (isDraft) {
        // Step 1: Delete DRAFT campaign on LinkedIn
        this.logger.log(
          `Deleting DRAFT LinkedIn campaign with ID: ${campaignId}`,
        );
        const linkedinResponse = await axios.delete(
          `https://api.linkedin.com/rest/adAccounts/${campaign.ad_account_id}/adCampaigns/${campaign.external_id}`,
          { headers },
        );

        // Validate response
        if (linkedinResponse.status !== 204) {
          this.logger.error(
            `Unexpected response status: ${linkedinResponse.status}`,
          );
          throw new Error(
            `Failed to delete campaign: Received status ${linkedinResponse.status}`,
          );
        }

        // Step 2: Delete campaign from database
        await this.prisma.marketingCampaign.delete({
          where: { campaign_id: campaignId },
        });

        this.logger.log(
          `Successfully deleted LinkedIn campaign with ID: ${campaign.external_id} from database`,
        );

        return {
          success: true,
          message: 'LinkedIn campaign deleted successfully',
          data: { id: campaignId },
        };
      } else {
        // Step 1: Update non-DRAFT campaign to PENDING_DELETION on LinkedIn
        this.logger.log(
          `Setting LinkedIn campaign with ID: ${campaign.external_id} to PENDING_DELETION`,
        );
        const patchPayload = {
          patch: {
            $set: {
              status: 'PENDING_DELETION',
            },
          },
        };

        const headers = {
          Authorization: `Bearer ${accessToken}`,
          'LinkedIn-Version': '202505',
          'X-RestLi-Protocol-Version': '2.0.0',
          'X-RestLi-Method': 'PARTIAL_UPDATE',
          'Content-Type': 'application/json',
          Accept: 'application/json',
        };

        const linkedinResponse = await axios.post(
          `https://api.linkedin.com/rest/adAccounts/${campaign.ad_account_id}/adCampaigns/${campaign.external_id}`,
          patchPayload,
          { headers },
        );

        // Validate response
        if (linkedinResponse.status !== 204) {
          this.logger.error(
            `Unexpected response status: ${linkedinResponse.status}`,
          );
          throw new Error(
            `Failed to update campaign status: Received status ${linkedinResponse.status}`,
          );
        }

        // Step 2: Update campaign status in database
        await this.prisma.marketingCampaign.update({
          where: { campaign_id: campaignId },
          data: {
            status: CampaignStatus.PENDING_DELETION,
            updated_at: new Date(),
          },
        });

        this.logger.log(
          `Successfully updated LinkedIn campaign with ID: ${campaignId} to PENDING_DELETION in database`,
        );

        return {
          success: true,
          message: 'LinkedIn campaign status updated to PENDING_DELETION',
          data: { id: campaignId },
        };
      }
    } catch (error: any) {
      if (error.response) {
        this.logger.error(
          `LinkedIn API Error: ${error.response.status} - ${JSON.stringify(
            error.response.data,
            null,
            2,
          )}`,
          {
            request: {
              url: error.config?.url,
              method: error.config?.method,
              headers: error.config?.headers,
              data: error.config?.data,
            },
          },
        );
        if (error.response.status === 401) {
          throw new UnauthorizedException('Invalid or expired access token');
        }
        if (error.response.status === 403) {
          throw new ForbiddenException(
            'Missing required scopes (r_ads, rw_ads) or insufficient permissions',
          );
        }
        if (error.response.status === 429) {
          throw new Error('Rate limit exceeded');
        }
        if (error.response.status === 400) {
          throw new Error(
            `Invalid request: ${JSON.stringify(error.response.data)}`,
          );
        }
        if (error.response.status === 404) {
          throw new Error('Campaign or ad account not found');
        }
      }
      this.logger.error(`Failed to delete LinkedIn campaign: ${error.message}`);
      throw new Error('Failed to delete LinkedIn campaign');
    }
  }

  async getBudgetRecommendations(input: {
    adAccountId: string;
    objectiveType?: ObjectiveType;
    targetingCriteria: LinkedInCampaignInput['targetingCriteria'];
    campaignType?: string;
    bidType?: string;
    matchType?: string;
  }): Promise<{
    success: boolean;
    message: string;
    data?: {
      bidLimits: {
        min: { amount: string; currencyCode: string };
        max: { amount: string; currencyCode: string };
      };
      suggestedBid: {
        min: { amount: string; currencyCode: string };
        default: { amount: string; currencyCode: string };
        max: { amount: string; currencyCode: string };
      };
      dailyBudgetLimits: {
        min: { amount: string; currencyCode: string };
        default: { amount: string; currencyCode: string };
        max: { amount: string; currencyCode: string };
      };
      estimatedCostPerResult?: { amount: string; currencyCode: string };
    };
  }> {
    this.logger.log(
      `Fetching budget recommendations for adAccountId: ${input.adAccountId}`,
    );
    this.logger.log(`Raw input: ${JSON.stringify(input, null, 2)}`);

    try {
      const accessToken = await this.linkedinService.getValidAccessToken();
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        'LinkedIn-Version': '202505',
        'X-RestLi-Protocol-Version': '2.0.0',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };

      const includeFacets: string[] = [];
      const excludeFacets: string[] = [];

      const validateURN = (urn: string): boolean => {
        return /^urn:li:[a-zA-Z]+:[a-zA-Z0-9:_,\(\)]+$/.test(urn);
      };

      const encodeURN = (urn: string): string => {
        return encodeURIComponent(urn)
          .replace(/\(/g, '%28')
          .replace(/\)/g, '%29');
      };

      if (input.targetingCriteria.interfaceLocales.include.length > 0) {
        const urns = input.targetingCriteria.interfaceLocales.include
          .map((item) => item.value)
          .filter((urn) => validateURN(urn))
          .map(encodeURN);
        if (urns.length > 0) {
          includeFacets.push(
            `(or:(urn%3Ali%3AadTargetingFacet%3AinterfaceLocales:List(${urns.join(',')})))`,
          );
        }
      }
      if (input.targetingCriteria.locations.include.length > 0) {
        const urns = input.targetingCriteria.locations.include
          .map((item) => item.value)
          .filter((urn) => validateURN(urn))
          .map(encodeURN);
        if (urns.length > 0) {
          includeFacets.push(
            `(or:(urn%3Ali%3AadTargetingFacet%3Alocations:List(${urns.join(',')})))`,
          );
        }
      }
      if (input.targetingCriteria.industries.include.length > 0) {
        const urns = input.targetingCriteria.industries.include
          .map((item) => item.value)
          .filter((urn) => validateURN(urn))
          .map(encodeURN);
        if (urns.length > 0) {
          includeFacets.push(
            `(or:(urn%3Ali%3AadTargetingFacet%3Aindustries:List(${urns.join(',')})))`,
          );
        }
      }
      if (input.targetingCriteria.seniorities.include.length > 0) {
        const urns = input.targetingCriteria.seniorities.include
          .map((item) => item.value)
          .filter((urn) => validateURN(urn))
          .map(encodeURN);
        if (urns.length > 0) {
          includeFacets.push(
            `(or:(urn%3Ali%3AadTargetingFacet%3Aseniorities:List(${urns.join(',')})))`,
          );
        }
      }
      if (input.targetingCriteria.titles.include.length > 0) {
        const urns = input.targetingCriteria.titles.include
          .map((item) => item.value)
          .filter((urn) => validateURN(urn))
          .map(encodeURN);
        if (urns.length > 0) {
          includeFacets.push(
            `(or:(urn%3Ali%3AadTargetingFacet%3Atitles:List(${urns.join(',')})))`,
          );
        }
      }
      if (input.targetingCriteria.staffCountRanges.include.length > 0) {
        const urns = input.targetingCriteria.staffCountRanges.include
          .map((item) => item.value)
          .filter((urn) => validateURN(urn))
          .map(encodeURN);
        if (urns.length > 0) {
          includeFacets.push(
            `(or:(urn%3Ali%3AadTargetingFacet%3AstaffCountRanges:List(${urns.join(',')})))`,
          );
        }
      }

      if (input.targetingCriteria.interfaceLocales.exclude.length > 0) {
        const urns = input.targetingCriteria.interfaceLocales.exclude
          .map((item) => item.value)
          .filter((urn) => validateURN(urn))
          .map(encodeURN);
        if (urns.length > 0) {
          excludeFacets.push(
            `urn%3Ali%3AadTargetingFacet%3AinterfaceLocales:List(${urns.join(',')})`,
          );
        }
      }
      if (input.targetingCriteria.locations.exclude.length > 0) {
        const urns = input.targetingCriteria.locations.exclude
          .map((item) => item.value)
          .filter((urn) => validateURN(urn))
          .map(encodeURN);
        if (urns.length > 0) {
          excludeFacets.push(
            `urn%3Ali%3AadTargetingFacet%3Alocations:List(${urns.join(',')})`,
          );
        }
      }
      if (input.targetingCriteria.industries.exclude.length > 0) {
        const urns = input.targetingCriteria.industries.exclude
          .map((item) => item.value)
          .filter((urn) => validateURN(urn))
          .map(encodeURN);
        if (urns.length > 0) {
          excludeFacets.push(
            `urn%3Ali%3AadTargetingFacet%3Aindustries:List(${urns.join(',')})`,
          );
        }
      }
      if (input.targetingCriteria.seniorities.exclude.length > 0) {
        const urns = input.targetingCriteria.seniorities.exclude
          .map((item) => item.value)
          .filter((urn) => validateURN(urn))
          .map(encodeURN);
        if (urns.length > 0) {
          excludeFacets.push(
            `urn%3Ali%3AadTargetingFacet%3Aseniorities:List(${urns.join(',')})`,
          );
        }
      }
      if (input.targetingCriteria.titles.exclude.length > 0) {
        const urns = input.targetingCriteria.titles.exclude
          .map((item) => item.value)
          .filter((urn) => validateURN(urn))
          .map(encodeURN);
        if (urns.length > 0) {
          excludeFacets.push(
            `urn%3Ali%3AadTargetingFacet%3Atitles:List(${urns.join(',')})`,
          );
        }
      }
      if (input.targetingCriteria.staffCountRanges.exclude.length > 0) {
        const urns = input.targetingCriteria.staffCountRanges.exclude
          .map((item) => item.value)
          .filter((urn) => validateURN(urn))
          .map(encodeURN);
        if (urns.length > 0) {
          excludeFacets.push(
            `urn%3Ali%3AadTargetingFacet%3AstaffCountRanges:List(${urns.join(',')})`,
          );
        }
      }

      this.logger.log(
        `Include facets: ${JSON.stringify(includeFacets, null, 2)}`,
      );
      this.logger.log(
        `Exclude facets: ${JSON.stringify(excludeFacets, null, 2)}`,
      );

      if (includeFacets.length === 0) {
        this.logger.error('No valid include facets provided');
        throw new Error('At least one valid include facet must be provided');
      }

      let targetingCriteria = `(include:(and:List(${includeFacets.join(',')})))`;
      if (excludeFacets.length > 1) {
        targetingCriteria += `,exclude:(or:(${excludeFacets.join(',')}))`;
      }
      this.logger.log(`Formatted targetingCriteria: ${targetingCriteria}`);

      const params = new URLSearchParams({
        q: 'criteriaV2',
        account: `urn:li:sponsoredAccount:${input.adAccountId}`,
        bidType: input.bidType || 'CPM',
        campaignType: input.campaignType || 'SPONSORED_INMAILS',
        matchType: input.matchType || 'EXACT',
      });

      if (input.objectiveType) {
        params.append('objectiveType', input.objectiveType);
      }

      let queryString = params.toString();
      queryString += `&targetingCriteria=${targetingCriteria}`;

      const requestUrl = `https://api.linkedin.com/rest/adBudgetPricing?${queryString}`;
      this.logger.log(`Request URL: ${requestUrl}`);

      const response = await axios.get<{ elements: any[] }>(requestUrl, {
        headers,
      });

      const budgetData = response.data.elements[0];
      if (!budgetData) {
        throw new Error('No budget pricing data returned');
      }

      return {
        success: true,
        message: 'Budget recommendations fetched successfully',
        data: {
          bidLimits: {
            min: budgetData.bidLimits.min,
            max: budgetData.bidLimits.max,
          },
          suggestedBid: {
            min: budgetData.suggestedBid.min,
            default: budgetData.suggestedBid.default,
            max: budgetData.suggestedBid.max,
          },
          dailyBudgetLimits: {
            min: budgetData.dailyBudgetLimits.min,
            default: budgetData.dailyBudgetLimits.default,
            max: budgetData.dailyBudgetLimits.max,
          },
          estimatedCostPerResult: undefined,
        },
      };
    } catch (error: any) {
      this.logger.error(
        `Failed to fetch budget recommendations: ${error.message}`,
      );
      if (error.response) {
        this.logger.error(
          `LinkedIn API Error: ${error.response.status} - ${JSON.stringify(error.response.data)}`,
        );
        if (error.response.status === 401) {
          throw new UnauthorizedException('Invalid or expired access token');
        }
        if (error.response.status === 403) {
          throw new ForbiddenException('Missing required scopes (r_ads)');
        }
        if (error.response.status === 429) {
          throw new Error('Rate limit exceeded');
        }
      }
      throw new Error('Failed to fetch budget recommendations');
    }
  }

  async getAudienceCount(
    input: LinkedInCampaignInput['targetingCriteria'],
  ): Promise<{
    success: boolean;
    message: string;
    data?: {
      active: number;
      total: number;
    };
  }> {
    try {
      // Validate input structure
      if (
        !input ||
        !input.interfaceLocales ||
        !input.locations ||
        !input.industries ||
        !input.seniorities ||
        !input.titles ||
        !input.staffCountRanges
      ) {
        this.logger.error(
          'Invalid input: missing required targeting criteria fields',
        );
        throw new BadRequestException('Targeting criteria fields are required');
      }

      // Initialize facets with empty arrays if undefined
      const facets = {
        interfaceLocales: input.interfaceLocales?.include || [],
        locations: input.locations?.include || [],
        industries: input.industries?.include || [],
        seniorities: input.seniorities?.include || [],
        titles: input.titles?.include || [],
        staffCountRanges: input.staffCountRanges?.include || [],
      };

      // Check if at least one include facet is non-empty
      const hasIncludeFacet = Object.values(facets).some(
        (arr) => arr.length > 0,
      );
      if (!hasIncludeFacet) {
        this.logger.error('No valid include facets provided');
        throw new BadRequestException(
          'At least one include facet must be provided',
        );
      }

      const accessToken = await this.linkedinService.getValidAccessToken();
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        'LinkedIn-Version': '202505',
        'X-RestLi-Protocol-Version': '2.0.0',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };

      const validateURN = (urn: string): boolean => {
        const isValid = /^urn:li:[a-zA-Z]+:[a-zA-Z0-9:_,\(\)]+$/.test(urn);
        if (!isValid) {
          this.logger.warn(`Invalid URN detected: ${urn}`);
        }
        return isValid;
      };

      const encodeURN = (urn: string): string => {
        return encodeURIComponent(urn)
          .replace(/\(/g, '%28')
          .replace(/\)/g, '%29');
      };

      // Facet config: use correct URNs, and for job titles use 'urn:li:adTargetingFacet:titles'
      const facetConfig = [
        {
          urn: 'urn:li:adTargetingFacet:interfaceLocales',
          key: 'interfaceLocales',
        },
        { urn: 'urn:li:adTargetingFacet:locations', key: 'locations' },
        { urn: 'urn:li:adTargetingFacet:industries', key: 'industries' },
        { urn: 'urn:li:adTargetingFacet:seniorities', key: 'seniorities' },
        {
          urn: 'urn:li:adTargetingFacet:titles',
          key: 'titles',
          isJobTitles: true,
        },
        {
          urn: 'urn:li:adTargetingFacet:staffCountRanges',
          key: 'staffCountRanges',
        },
      ];

      const includeFacets: string[] = [];

      for (const { urn, key, isJobTitles } of facetConfig) {
        const includeItems = facets[key];
        if (includeItems.length > 0) {
          let values: string[];
          if (isJobTitles) {
            // For job titles, use the full URN (e.g., urn:li:title:114)
            values = includeItems
              .map((item) => item.value)
              .filter((urn) => /^urn:li:title:\d+$/.test(urn))
              .map(encodeURN);
          } else {
            values = includeItems
              .map((item) => item.value)
              .filter(validateURN)
              .map(encodeURN);
          }
          if (values.length > 0) {
            includeFacets.push(
              `(or:(${encodeURIComponent(urn)}:List(${values.join(',')})))`,
            );
          }
        }
      }

      this.logger.log(
        `Include facets: ${JSON.stringify(includeFacets, null, 2)}`,
      );

      if (includeFacets.length === 0) {
        this.logger.error('No valid include facets provided');
        throw new BadRequestException(
          'At least one valid include facet must be provided',
        );
      }

      let targetingCriteria = `(include:(and:List(${includeFacets.join(',')})))`;
      this.logger.debug(`Targeting Criteria String: ${targetingCriteria}`);

      const params = new URLSearchParams({
        q: 'targetingCriteriaV2',
      });

      let queryString = params.toString();
      queryString += `&targetingCriteria=${targetingCriteria}`;

      const requestUrl = `https://api.linkedin.com/rest/audienceCounts?${queryString}`;
      this.logger.log(`Request URL: ${requestUrl}`);

      const response = await axios.get<{ elements: any[] }>(requestUrl, {
        headers,
      });
      this.logger.log(
        `Response from LinkedIn API: ${JSON.stringify(response.data, null, 2)}`,
      );
      const countData = response.data.elements[0];

      this.logger.log(
        `Fetched audience count: ${JSON.stringify(countData, null, 2)}`,
      );
      return {
        success: true,
        message: 'Audience count fetched successfully',
        data: {
          active: countData.active || 0,
          total: countData.total || 0,
        },
      };
    } catch (error: any) {
      this.logger.error(`Failed to fetch audience count: ${error.message}`);
      if (error.response) {
        this.logger.error(
          `LinkedIn API Error: ${error.response.status || 'unknown'} - ${JSON.stringify(error.response.data || {})}`,
        );
        if (error.response.status === 401) {
          throw new UnauthorizedException('Invalid or expired access token');
        }
        if (error.response.status === 403) {
          throw new ForbiddenException('Missing required scopes (r_ads)');
        }
        if (error.response.status === 429) {
          throw new Error('Rate limit exceeded');
        }
      } else {
        this.logger.error(`Non-API error: ${error.message}`);
      }
      throw new BadRequestException(
        error.message || 'Failed to fetch audience count',
      );
    }
  }

  async updateCampaignStatus(
    campaignId: string,
    status: string,
    platformName: 'LinkedIn' | 'Google' | 'Meta',
    orgId: string,
  ): Promise<{ success: boolean; message: string }> {
    this.logger.log(
      `Updating campaign status for campaignId: ${campaignId}, platform: ${platformName}, status: ${status}`,
    );

    try {
      const validStatuses: { [key: string]: string[] } = {
        LinkedIn: ['ACTIVE', 'PAUSED', 'DRAFT', 'PENDING_DELETION', 'ARCHIVED'],
        Google: ['ENABLED', 'PAUSED'],
        Meta: ['ACTIVE', 'PAUSED'],
      };

      if (!validStatuses[platformName].includes(status)) {
        this.logger.error(
          `Invalid status '${status}' for platform ${platformName}. Valid statuses: ${validStatuses[platformName].join(', ')}`,
        );
        throw new BadRequestException(
          `Invalid status '${status}' for platform ${platformName}`,
        );
      }

      if (platformName === 'LinkedIn') {
        await this.prisma.marketingCampaign.update({
          where: { campaign_id: campaignId },
          data: {
            status: status as CampaignStatus,
            updated_at: new Date(),
          },
        });
      } else if (platformName === 'Google') {
        await this.prisma.googleCampaign.update({
          where: { campaign_id: campaignId },
          data: {
            status: status as 'ENABLED' | 'PAUSED',
            updated_at: new Date(),
          },
        });
      } else if (platformName === 'Meta') {
        await this.prisma.metaCampaign.update({
          where: { campaign_id: campaignId },
          data: {
            status: status as 'ACTIVE' | 'PAUSED',
            updated_at: new Date(),
          },
        });
      } else {
        this.logger.error(`Unsupported platform: ${platformName}`);
        throw new BadRequestException(`Unsupported platform: ${platformName}`);
      }

      // Determine notification type and content based on status
      const isLaunched = status === 'ACTIVE' || status === 'ENABLED';
      const isPaused = status === 'PAUSED';

      if (isLaunched || isPaused) {
        const notificationType = isLaunched
          ? 'receiveCampaignLaunched'
          : 'receiveCampaignPaused';
        const actionText = isLaunched ? 'launched' : 'paused';
        const successType = isLaunched
          ? 'success: campaign launched'
          : 'success: campaign paused';

        await this.notificationService.notifyUsersOfOrg(
          orgId,
          notificationType,
          {
            title: `${platformName} Campaign ${isLaunched ? 'Launched' : 'Paused'}`,
            message: `A ${platformName} campaign has been ${actionText}.`,
            type: successType,
            meta: { orgId, campaignId, url: 'http://localhost:3000/campaigns' },
          },
        );
      }

      this.logger.log(
        `Successfully updated campaign status for campaignId: ${campaignId} to ${status} on platform ${platformName}`,
      );

      return {
        success: true,
        message: `Campaign status updated to ${status} successfully`,
      };
    } catch (error: any) {
      this.logger.error(
        `Failed to update campaign status for campaignId: ${campaignId}, platform: ${platformName}: ${error.message}`,
      );

      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2025'
      ) {
        throw new BadRequestException(
          `Campaign with id ${campaignId} not found`,
        );
      }

      throw new Error(`Failed to update campaign status: ${error.message}`);
    }
  }
}
