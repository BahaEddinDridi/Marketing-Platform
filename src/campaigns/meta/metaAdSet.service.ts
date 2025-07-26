import {
  Injectable,
  InternalServerErrorException,
  ForbiddenException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MetaService } from 'src/auth/meta/meta.service';
import { PrismaService } from 'src/prisma/prisma.service';
import axios from 'axios';
import Bottleneck from 'bottleneck';
import { MetaAdSet } from '@prisma/client';

export interface RegionSearchResult {
  key: string;
  name: string;
  country_code: string;
  country_name: string;
}

export interface InterestSearchResult {
  id: string;
  name: string;
  audience_size: number;
}

@Injectable()
export class MetaAdSetService {
  private readonly logger = new Logger(MetaAdSetService.name);
  private readonly limiter = new Bottleneck({
    maxConcurrent: 5,
    minTime: 200,
  });

  constructor(
    private readonly prisma: PrismaService,
    private readonly metaService: MetaService,
    private readonly configService: ConfigService,
  ) {}


  async searchRegions(orgId: string, query: string): Promise<RegionSearchResult[]> {
    this.logger.log(`Searching regions for org ${orgId} with query: ${query}`);

    // Validate organization
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
    });
    if (!org) {
      this.logger.error(`Organization not found for id: ${orgId}`);
      throw new InternalServerErrorException('Organization not found');
    }

    // Get Meta platform and credentials
    const platform = await this.prisma.marketingPlatform.findFirst({
      where: { orgId, platform_name: 'Meta' },
    });
    if (!platform) {
      this.logger.error('Meta platform not found for organization');
      throw new InternalServerErrorException('Meta platform not configured');
    }

    const creds = await this.metaService.getMetaCredentials();
    if (!creds.clientId || !creds.clientSecret) {
      this.logger.error('No valid Meta credentials found');
      throw new ForbiddenException('No valid Meta credentials found');
    }

    const platformCreds = await this.prisma.platformCredentials.findFirst({
      where: { platform_id: platform.platform_id, type: 'AUTH', user_id: null },
    });
    if (!platformCreds || !platformCreds.access_token) {
      this.logger.error('No valid Meta platform credentials found');
      throw new ForbiddenException('No valid Meta platform credentials found');
    }

    const accessToken = await this.metaService.getValidAccessToken(
      creds.clientId,
      creds.clientSecret,
      platformCreds.access_token,
      platform.platform_id,
    );

    // Prepare Meta API request
    const url = `https://graph.facebook.com/v23.0/search`;
    const params = {
      location_types: ['region'],
      type: 'adgeolocation',
      q: query,
      access_token: accessToken,
    };

    try {
      const response = await this.limiter.schedule(() =>
        axios.get<{ data: any[] }>(url, { params }),
      );
      const regions = response.data.data || [];

      this.logger.log(`Fetched ${regions.length} regions for query: ${query}`);

      // Format and limit to 10 results
      const formattedRegions: RegionSearchResult[] = regions
        .filter((region) => region.type === 'region')
        .slice(0, 10)
        .map((region) => ({
          key: region.key,
          name: region.name,
          country_code: region.country_code,
          country_name: region.country_name,
        }));

      return formattedRegions;
    } catch (error: any) {
      this.logger.error(
        `Failed to search regions for query ${query}: ${error.message}`,
        error.stack,
      );
      if (error.response?.status === 401) {
        throw new ForbiddenException('Invalid or expired access token');
      }
      if (error.response?.status === 429) {
        throw new InternalServerErrorException('Rate limit exceeded');
      }
      throw new InternalServerErrorException('Failed to search Meta regions');
    }
  }

  async searchInterests(orgId: string, interest: string): Promise<InterestSearchResult[]> {
    this.logger.log(`Searching interests for org ${orgId} with interest: ${interest}`);

    // Validate organization
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
    });
    if (!org) {
      this.logger.error(`Organization not found for id: ${orgId}`);
      throw new InternalServerErrorException('Organization not found');
    }

    // Get Meta platform and credentials
    const platform = await this.prisma.marketingPlatform.findFirst({
      where: { orgId, platform_name: 'Meta' },
    });
    if (!platform) {
      this.logger.error('Meta platform not found for organization');
      throw new InternalServerErrorException('Meta platform not configured');
    }

    const creds = await this.metaService.getMetaCredentials();
    if (!creds.clientId || !creds.clientSecret) {
      this.logger.error('No valid Meta credentials found');
      throw new ForbiddenException('No valid Meta credentials found');
    }

    const platformCreds = await this.prisma.platformCredentials.findFirst({
      where: { platform_id: platform.platform_id, type: 'AUTH', user_id: null },
    });
    if (!platformCreds || !platformCreds.access_token) {
      this.logger.error('No valid Meta platform credentials found');
      throw new ForbiddenException('No valid Meta platform credentials found');
    }

    const accessToken = await this.metaService.getValidAccessToken(
      creds.clientId,
      creds.clientSecret,
      platformCreds.access_token,
      platform.platform_id,
    );

    // Prepare Meta API request
    const url = `https://graph.facebook.com/v23.0/search`;
    const params = {
      interest_list: [interest],
      type: 'adinterestsuggestion',
      access_token: accessToken,
    };

    try {
      const response = await this.limiter.schedule(() =>
        axios.get<{ data: any[] }>(url, { params }),
      );
      const interests = response.data.data || [];

      this.logger.log(`Fetched ${interests.length} interests for interest: ${interest}`);

      // Format and limit to 10 results
      const formattedInterests: InterestSearchResult[] = interests
        .slice(0, 10)
        .map((interest) => ({
          id: interest.id,
          name: interest.name,
          audience_size: interest.audience_size || 0,
        }));

      return formattedInterests;
    } catch (error: any) {
      this.logger.error(
        `Failed to search interests for interest ${interest}: ${error.message}`,
        error.stack,
      );
      if (error.response?.status === 401) {
        throw new ForbiddenException('Invalid or expired access token');
      }
      if (error.response?.status === 429) {
        throw new InternalServerErrorException('Rate limit exceeded');
      }
      throw new InternalServerErrorException('Failed to search Meta interests');
    }
  }



async createAdSet(orgId: string, campaignId: string, data: {
  name: string;
  billing_event: string;
  optimization_goal: string;
  status: string;
  targeting: {
    age_min: number;
    age_max: number;
    genders: number[];
    geo_locations: {
      regions: { key: string; name: string }[];
    };
    interests: { id: string; name: string }[];
    device_platforms: string[];
    targeting_automation: { advantage_audience: number };
  };
  run_schedule: {
    start_time: string;
    end_time?: string; // Optional end_time
  };
}) {
  this.logger.log(
    `Creating Meta ad set for campaign ${campaignId} in org ${orgId}, data: ${JSON.stringify(data, null, 2)}`,
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
  const url = `https://graph.facebook.com/v23.0/${campaign.ad_account_id}/adsets`;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
  };

  const payload: any = {
    campaign_id: campaignId,
    name: data.name,
    billing_event: data.billing_event,
    optimization_goal: data.optimization_goal,
    status: data.status,
    start_time: new Date(data.run_schedule.start_time).toISOString(),
    targeting: {
      age_min: data.targeting.age_min,
      age_max: data.targeting.age_max,
      genders: data.targeting.genders,
      geo_locations: {
        regions: data.targeting.geo_locations.regions.map((region) => ({
          key: region.key,
        })),
      },
      interests: data.targeting.interests.map((interest) => ({
        id: interest.id,
      })),
      device_platforms: data.targeting.device_platforms,
      targeting_automation: data.targeting.targeting_automation,
    },
  };

  // Include end_time in payload if provided
  if (data.run_schedule.end_time) {
    payload.end_time = new Date(data.run_schedule.end_time).toISOString();
  }

  try {
    // Create ad set via Meta API
    const response = await this.limiter.schedule(() =>
      axios.post<any>(url, payload, { headers }),
    );
    const adSet = response.data;

    if (!adSet.id) {
      this.logger.error('Meta API did not return an ad set ID');
      throw new InternalServerErrorException(
        'Failed to create ad set: No ID returned',
      );
    }

    // Save to database with full targeting data (including names)
    const adSetData = {
      ad_set_id: adSet.id,
      campaign_id: campaignId,
      name: data.name,
      status: data.status as MetaAdSet['status'],
      billing_event: data.billing_event as MetaAdSet['billing_event'],
      optimization_goal: data.optimization_goal as MetaAdSet['optimization_goal'],
      bid_amount: null, // Not provided in the form
      daily_budget: null, // Not provided in the form
      lifetime_budget: null, // Not provided in the form
      pacing_type: ['STANDARD'] as MetaAdSet['pacing_type'], // Default value
      start_time: new Date(data.run_schedule.start_time),
      end_time: data.run_schedule.end_time
        ? new Date(data.run_schedule.end_time)
        : null, // Save end_time if provided
      targeting: {
        age_min: data.targeting.age_min,
        age_max: data.targeting.age_max,
        genders: data.targeting.genders,
        geo_locations: {
          regions: data.targeting.geo_locations.regions, // Save full region objects with key and name
        },
        interests: data.targeting.interests, // Save full interest objects with id and name
        device_platforms: data.targeting.device_platforms,
        targeting_automation: data.targeting.targeting_automation,
      },
      promoted_object: undefined, // Set to undefined to match Prisma type
      data: { ...payload, id: adSet.id },
      created_at: new Date(),
      updated_at: new Date(),
    };

    const savedAdSet = await this.prisma.metaAdSet.create({
      data: adSetData,
    });

    this.logger.log(
      `Created ad set ${adSet.id} for campaign ${campaignId}`,
    );
    return savedAdSet;
  } catch (error: any) {
    this.logger.error(
      `Failed to create ad set for campaign ${campaignId}: ${error.message}`,
      error.stack,
    );
    if (error.response?.status === 401) {
      throw new ForbiddenException('Invalid or expired access token');
    }
    if (error.response?.status === 429) {
      throw new InternalServerErrorException('Rate limit exceeded');
    }
    if (error.response?.status === 400) {
      throw new InternalServerErrorException('Invalid ad set data');
    }
    throw new InternalServerErrorException('Failed to create Meta ad set');
  }
}
}