import {
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
import { Prisma, CampaignType, CampaignStatus, OptimizationTargetType, ObjectiveType, CostType, Format } from '@prisma/client';


const mapToPrismaEnum = <T extends Record<string, string>>(
  value: string,
  enumObject: T,
  defaultValue: T[keyof T] | null,
): T[keyof T] | null => {
  return Object.values(enumObject).includes(value as T[keyof T])
    ? (value as T[keyof T])
    : defaultValue;
};

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

@Injectable()
export class CampaignsService {
  private readonly logger = new Logger(CampaignsService.name);
  constructor(
    private prisma: PrismaService,
    private readonly authService: AuthService,
    private readonly linkedinService: LinkedInService,
    private readonly configService: ConfigService,
  ) {}

  async create(createCampaignDto: CreateCampaignDto) {
    return this.prisma.marketingCampaign.create({ data: createCampaignDto });
  }

  async findAll() {
    return this.prisma.marketingCampaign.findMany({
      include: {
        platform: {
          select: {
            platform_name: true,
          },
        },
      },
    });
  }

  async findOne(id: string) {
    return this.prisma.marketingCampaign.findUnique({
      where: { campaign_id: id },
      include: {
        performances: true,
        platform: {
          select: {
            platform_name: true,
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
      'EVERY_5_MINUTES',
      'EVERY_15_MINUTES',
      'EVERY_30_MINUTES',
      'EVERY_HOUR',
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

  async fetchLinkedInCampaigns(adAccountIds: string[]): Promise<any[]> {
    this.logger.log(
      `Fetching LinkedIn campaigns for ad accounts: ${adAccountIds.join(', ')}`,
    );

    const accessToken = await this.linkedinService.getValidAccessToken();
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'LinkedIn-Version': '202411',
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

    // Type guard to check if a JsonValue is an array of { value: string; name: string }
    const isMetadataArray = (
      data: JsonValue,
    ): data is { value: string; name: string }[] => {
      return (
        Array.isArray(data) &&
        data.every(
          (item) =>
            typeof item === 'object' &&
            item !== null &&
            'value' in item &&
            'name' in item &&
            typeof item.value === 'string' &&
            typeof item.name === 'string',
        )
      );
    };

    // Create lookup maps for URNs to names with type safety (exclude locations)
    const metadataMaps: { [key: string]: Map<string, string> } = {
      industries: new Map(
        isMetadataArray(metadata.targeting_industries)
          ? metadata.targeting_industries.map((item) => [item.value, item.name])
          : [],
      ),
      titles: new Map(
        isMetadataArray(metadata.targeting_titles)
          ? metadata.targeting_titles.map((item) => [item.value, item.name])
          : [],
      ),
      interfaceLocales: new Map(
        isMetadataArray(metadata.targeting_locales)
          ? metadata.targeting_locales.map((item) => [item.value, item.name])
          : [],
      ),
    };


    const mappedCampaigns = campaigns.map((campaign) => {
      // Transform targetingCriteria
      let transformedData = {};
      if (campaign.targetingCriteria) {
        const transformFacet = (facetData: any, facetUrn: string): any => {
          const facetKey = facetUrn.split(':').pop() || facetUrn; // e.g., "industries"
          if (facetKey === 'locations') {
            return facetData; // Skip name mapping for locations
          }
          const map = metadataMaps[facetKey];
          if (!map) {
            this.logger.warn(`No metadata map for facet: ${facetKey}`);
            return facetData; // Return unchanged if no metadata
          }
          return facetData.map((urn: string) => ({
            urn,
            name: map.get(urn) || 'Unknown',
          }));
        };

        const transformedCriteria = {
          include: campaign.targetingCriteria.include
            ? {
                and: campaign.targetingCriteria.include.and.map(
                  (andClause: any) => ({
                    or: Object.fromEntries(
                      Object.entries(andClause.or).map(([facetUrn, urns]) => [
                        facetUrn, // Keep full URN, e.g., "urn:li:adTargetingFacet:industries"
                        transformFacet(urns, facetUrn),
                      ]),
                    ),
                  }),
                ),
              }
            : undefined,
        };

        transformedData = { targetingCriteria: transformedCriteria };
      }

      return {
        campaign_name: campaign.name || 'Unnamed Campaign',
        platform_id: platform.platform_id,
        external_id: campaign.id?.toString(),
        ad_account_id: campaign.adAccountId,
        campaign_group_id: campaign.campaignGroup?.split(':').pop(),
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
        format: campaign.format ? mapToPrismaEnum(campaign.format, Format, null)
          : null,
        status: campaign.status
          ? (mapToPrismaEnum(
              campaign.status,
              CampaignStatus,
              CampaignStatus.DRAFT,
            ) as CampaignStatus) // Ensure non-null
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
          ad_account_id: campaign.ad_account_id,
          campaign_group_id: campaign.campaign_group_id,
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

    this.logger.log(`Saved ${mappedCampaigns.length} campaigns to database`);
  
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
      'LinkedIn-Version': '202411',
      'X-RestLi-Protocol-Version': '2.0.0',
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

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
        let hasMore = false; // Single request since start/count are excluded
        const facetKey = facetUrn.split(':').pop() as keyof typeof facetData;

        try {
          const baseUrl = 'https://api.linkedin.com/rest/adTargetingEntities';
          const encodedFacet = encodeURIComponent(facetUrn);
          const fullUrl = `${baseUrl}?q=adTargetingFacet&queryVersion=QUERY_USES_URNS&facet=${encodedFacet}&locale=(language:en,country:US)`;
          this.logger.log(
            `https://api.linkedin.com/rest/adTargetingEntities:${fullUrl}`,
          );
          const response = await axios.get<{
            elements: any[];
            paging: { total: number; links: any[] };
          }>(fullUrl, { headers });

          const elements = response.data.elements || [];
          facetData[facetKey].push(...elements);
          this.logger.log(
            `Fetched ${elements.length} ${facetKey} from adTargetingEntities`,
          );

          hasMore =
            response.data.paging?.links?.some(
              (link: any) => link.rel === 'next',
            ) || false;
          if (hasMore) {
            this.logger.warn(
              `Pagination not supported without start/count for ${facetUrn}; only first page retrieved`,
            );
            hasMore = false;
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

      const metadata = {
        targeting_industries: facetData.industries.map((facet) => ({
          name: facet.name || 'Unknown Industry',
          value: facet.urn || 'Unknown',
        })),
        targeting_locations: [],
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
        'LinkedIn-Version': '202411',
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
    this.logger.log(`Response headers: ${JSON.stringify(linkedinResponse.headers, null, 2)}`);
    this.logger.log(`Response body: ${JSON.stringify(linkedinResponse.data, null, 2)}`);


    if (linkedinResponse.status !== 201) {
      this.logger.error(`Unexpected response status: ${linkedinResponse.status}`);
      throw new Error(`Failed to create campaign group: Received status ${linkedinResponse.status}`);
    }


    let campaignGroupId = linkedinResponse.headers['x-restli-id'] || linkedinResponse.headers['x-linkedin-id'];
    if (!campaignGroupId) {
      // Fallback to parsing Location header
      const locationHeader = linkedinResponse.headers['location'];
      if (locationHeader) {
        const match = locationHeader.match(/\/adCampaignGroups\/(\d+)$/);
        campaignGroupId = match ? match[1] : null;
      }
      if (!campaignGroupId) {
        this.logger.error('No campaign group ID found in x-restli-id, x-linkedin-id, or Location headers');
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
    this.logger.error(`Ad account not found for id: ${campaignGroup.adAccountId}`);
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
      'LinkedIn-Version': '202411',
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
      this.logger.error(`Unexpected response status: ${linkedinResponse.status}`);
      throw new Error(`Failed to update campaign group: Received status ${linkedinResponse.status}`);
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
    // Log action instead of modifying database
    this.logger.log(`Would delete campaign group with id: ${id}`);
    return {
      success: true,
      message: 'Campaign group deletion logged successfully',
      data: { id },
    };
  }
}
