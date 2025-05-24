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

export enum CampaignStatus {
  ACTIVE = 'ACTIVE',
  PAUSED = 'PAUSED',
  COMPLETED = 'COMPLETED',
  DRAFT = 'DRAFT',
  ARCHIVED = 'ARCHIVED',
}

export enum CampaignObjective {
  LEAD_GENERATION = 'LEAD_GENERATION',
  BRAND_AWARENESS = 'BRAND_AWARENESS',
  WEBSITE_VISIT = 'WEBSITE_VISIT',
  ENGAGEMENT = 'ENGAGEMENT',
  CONVERSIONS = 'CONVERSIONS',
  APP_INSTALLS = 'APP_INSTALLS',
  VIDEO_VIEWS = 'VIDEO_VIEWS',
  REACH = 'REACH',
}

export enum CampaignType {
  SPONSORED_UPDATES = 'SPONSORED_UPDATES',
  SPONSORED_CONTENT = 'SPONSORED_CONTENT',
  TEXT_AD = 'TEXT_AD',
  DYNAMIC_AD = 'DYNAMIC_AD',
  VIDEO_AD = 'VIDEO_AD',
  DISPLAY_AD = 'DISPLAY_AD',
  SEARCH_AD = 'SEARCH_AD',
}

export enum CostType {
  CPM = 'CPM',
  CPC = 'CPC',
  CPA = 'CPA',
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
            params, // Axios will handle proper encoding
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
      this.logger.log(
        `Campaigns fetched successfully: ${JSON.stringify(campaigns)}`,
      );
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

    let platform = await this.prisma.marketingPlatform.findFirst({
      where: { orgId: org.id, platform_name: 'LinkedIn' },
    });
    if (!platform) {
      this.logger.error('LinkedIn platform not found for organization');
      throw new Error('LinkedIn platform not configured');
    }

    const mappedCampaigns = campaigns.map((campaign) => ({
      campaign_name: campaign.name,
      platform_id: platform?.platform_id, // Extract ID from URN
      external_id: campaign.id.toString(), // Store LinkedIn ID here
      ad_account_id: campaign.adAccountId,
      campaign_group_id: campaign.campaignGroup?.split(':').pop(),
      objective: campaign.objectiveType as CampaignObjective,
      type: campaign.type as CampaignType,
      format: campaign.format,
      status: campaign.status as CampaignStatus,
      serving_statuses: campaign.servingStatuses,
      budget: parseFloat(campaign.dailyBudget?.amount) || null,
      total_budget: null, // Set as needed
      unit_cost: parseFloat(campaign.unitCost?.amount) || null,
      cost_type: campaign.costType as CostType,
      start_date: new Date(campaign.runSchedule.start),
      end_date: campaign.runSchedule.end
        ? new Date(campaign.runSchedule.end)
        : null,
      audience_expansion: campaign.audienceExpansionEnabled,
      pacing_strategy: campaign.pacingStrategy,
      locale: `${campaign.locale.language}_${campaign.locale.country}`,
      created_at: new Date(campaign.changeAuditStamps.created.time),
      updated_at: new Date(campaign.changeAuditStamps.lastModified.time),
      data: { targetingCriteria: campaign.targetingCriteria },
    }));

    for (const campaign of mappedCampaigns) {
      await this.prisma.marketingCampaign.upsert({
        where: { external_id: campaign.external_id }, // Use external_id for uniqueness
        update: campaign,
        create: campaign,
      });
    }

    this.logger.log(`Saved ${mappedCampaigns.length} campaigns to database`);
  }
}
