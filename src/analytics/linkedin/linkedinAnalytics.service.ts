import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LinkedInService } from 'src/auth/linkedIn/linkedIn.service';
import { PrismaService } from 'src/prisma/prisma.service';
import axios from 'axios';

@Injectable()
export class LinkedInAnalyticsService {
  private readonly logger = new Logger(LinkedInAnalyticsService.name);

  constructor(
    private prisma: PrismaService,
    private readonly linkedinService: LinkedInService,
    private readonly configService: ConfigService,
  ) {}

  private toFloat(value: any): number | null {
    if (value === null || value === undefined) {
      return null;
    }
    const parsed = parseFloat(value);
    return isNaN(parsed) ? null : parsed;
  }

  mapAnalyticsFields(item: any) {
    return {
      impressions: item.impressions ?? null,
      clicks: item.clicks ?? null,
      costInLocalCurrency: this.toFloat(item.costInLocalCurrency),
      qualifiedLeads: item.qualifiedLeads ?? null,
      externalWebsiteConversions: item.externalWebsiteConversions ?? null,
      landingPageClicks: item.landingPageClicks ?? null,
      reactions: item.reactions ?? null,
      shares: item.shares ?? null,
      follows: item.follows ?? null,
      costInUsd: this.toFloat(item.costInUsd),
      conversions: item.conversions ?? null,
      revenueWonUsd: this.toFloat(item.revenueWonUsd),
      returnOnAdSpend: this.toFloat(item.returnOnAdSpend),
      costPerQualifiedLead: this.toFloat(item.costPerQualifiedLead),
      videoViews: item.videoViews ?? null,
      videoCompletions: item.videoCompletions ?? null,
      comments: item.comments ?? null,
      averageDwellTime: this.toFloat(item.averageDwellTime),
      cardClicks: item.cardClicks ?? null,
      dateFetched: new Date(),
    };
  }
  private extractIdFromUrn(urn: string): string | null {
    const match = urn.match(/:(\d+)$/);
    if (!match) {
      this.logger.warn(`Invalid URN format: ${urn}`);
      return null;
    }
    return match[1];
  }
  ///////////////////////////////// CAMPAIGN ANALYTICS //////////////////////////////////////
  async fetchLinkedInCampaignAnalytics(
    campaignUrns: string[],
    timeGranularity: 'ALL' | 'DAILY',
    startDate: Date,
    endDate: Date,
    fields: string[],
  ): Promise<void> {
    this.logger.log(
      `Fetching LinkedIn campaign analytics for ${campaignUrns.length} campaigns with granularity ${timeGranularity}`,
    );

    const accessToken = await this.linkedinService.getValidAccessToken();
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'LinkedIn-Version': '202505',
      'X-RestLi-Protocol-Version': '2.0.0',
      'Content-Type': 'application/json',
    };

    const dateRange = `dateRange=(start:(year:${startDate.getUTCFullYear()},month:${startDate.getUTCMonth() + 1},day:${startDate.getUTCDate()}),end:(year:${endDate.getUTCFullYear()},month:${endDate.getUTCMonth() + 1},day:${endDate.getUTCDate()}))`;
    const campaignsParam = `List(${campaignUrns.map((urn) => encodeURIComponent(urn)).join(',')})`;
    const queryString = [
      'q=analytics',
      'pivot=CAMPAIGN',
      `timeGranularity=${timeGranularity}`,
      `fields=${fields.join(',')}`,
      dateRange,
      `campaigns=${campaignsParam}`,
    ].join('&');

    const url = `https://api.linkedin.com/rest/adAnalytics?${queryString}`;

    this.logger.log(`Fetching LinkedIn campaign analytics from URL: ${url}`);
    try {
      const response = await axios.get<{ elements: any[] }>(url, { headers });

      const analyticsData = response.data.elements || [];
      this.logger.log(`Fetched ${analyticsData.length} analytics records`);

      switch (timeGranularity) {
        case 'ALL':
          await this.saveLinkedInCampaignAnalyticsAll(analyticsData);
          break;
        case 'DAILY':
          await this.saveLinkedInCampaignAnalyticsDaily(analyticsData);
          break;
        default:
          throw new Error(`Unsupported time granularity: ${timeGranularity}`);
      }
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
        if (error.response.status === 401)
          throw new UnauthorizedException('Invalid or expired access token');
        if (error.response.status === 403)
          throw new ForbiddenException(
            'Missing required scopes (r_ads, r_ads_reporting)',
          );
        if (error.response.status === 429)
          throw new Error('Rate limit exceeded');
      }
      this.logger.error(`Failed to fetch campaign analytics: ${error.message}`);
      throw new Error('Failed to fetch LinkedIn campaign analytics');
    }
  }

  async saveLinkedInCampaignAnalyticsAll(analyticsData: any[]): Promise<void> {
    for (const item of analyticsData) {
      const urn = item.pivotValues?.[0];
      if (!urn) {
        this.logger.warn(
          `Skipping analytics entry without pivotValues: ${JSON.stringify(item)}`,
        );
        continue;
      }
      const externalId = this.extractIdFromUrn(urn);
      if (!externalId) {
        this.logger.warn(`Invalid campaign URN: ${urn}`);
        continue;
      }
      const campaign = await this.prisma.marketingCampaign.findUnique({
        where: { external_id: externalId },
      });
      if (!campaign) {
        this.logger.warn(
          `Campaign not found for external ID ${externalId}, skipping`,
        );
        continue;
      }

      await this.prisma.campaignAnalytics.upsert({
        where: {
          campaign_id_datePeriodStart_datePeriodEnd_timeGranularity: {
            campaign_id: campaign.campaign_id,
            datePeriodStart: campaign.start_date, // Or campaign start date
            datePeriodEnd: new Date(), // Now
            timeGranularity: 'ALL',
          },
        },
        update: this.mapAnalyticsFields(item),
        create: {
          campaign_id: campaign.campaign_id,
          timeGranularity: 'ALL',
          datePeriodStart: campaign.start_date, // Or campaign start date
          datePeriodEnd: new Date(), // Now
          ...this.mapAnalyticsFields(item),
          dateFetched: new Date(),
        },
      });
    }
    this.logger.log(
      `Saved ALL granularity analytics for ${analyticsData.length} campaigns`,
    );
  }

  async saveLinkedInCampaignAnalyticsDaily(
    analyticsData: any[],
  ): Promise<void> {
    for (const item of analyticsData) {
      const urn = item.pivotValues?.[0];
      if (!urn) {
        this.logger.warn(
          `Skipping analytics entry without pivotValues: ${JSON.stringify(item)}`,
        );
        continue;
      }
      const externalId = this.extractIdFromUrn(urn);
      if (!externalId) {
        this.logger.warn(`Invalid campaign URN: ${urn}`);
        continue;
      }
      const campaign = await this.prisma.marketingCampaign.findUnique({
        where: { external_id: externalId },
      });
      if (!campaign) {
        this.logger.warn(
          `Campaign not found for external ID ${externalId}, skipping`,
        );
        continue;
      }

      await this.prisma.campaignAnalytics.upsert({
        where: {
          campaign_id_datePeriodStart_datePeriodEnd_timeGranularity: {
            campaign_id: campaign.campaign_id,
            datePeriodStart: new Date(
              `${item.dateRange.start.year}-${item.dateRange.start.month}-${item.dateRange.start.day}`,
            ),
            datePeriodEnd: new Date(
              `${item.dateRange.end.year}-${item.dateRange.end.month}-${item.dateRange.end.day}`,
            ),
            timeGranularity: 'DAILY',
          },
        },
        update: this.mapAnalyticsFields(item),
        create: {
          campaign_id: campaign.campaign_id,
          timeGranularity: 'DAILY',
          datePeriodStart: new Date(
            `${item.dateRange.start.year}-${item.dateRange.start.month}-${item.dateRange.start.day}`,
          ),
          datePeriodEnd: new Date(
            `${item.dateRange.end.year}-${item.dateRange.end.month}-${item.dateRange.end.day}`,
          ),
          ...this.mapAnalyticsFields(item),
          dateFetched: new Date(),
        },
      });
    }
    this.logger.log(
      `Saved DAILY granularity analytics for ${analyticsData.length} campaigns`,
    );
  }

  async getCampaignAnalyticsByCampaignId(campaignId: string): Promise<{
    allAnalytics: any[];
    dailyAnalytics: any[];
  }> {
    this.logger.log(`Fetching analytics for campaign ID: ${campaignId}`);

    // Verify campaign exists
    const campaign = await this.prisma.marketingCampaign.findUnique({
      where: { campaign_id: campaignId },
    });

    if (!campaign) {
      this.logger.warn(`Campaign not found for ID: ${campaignId}`);
      throw new NotFoundException(`Campaign with ID ${campaignId} not found`);
    }

    // Fetch ALL granularity analytics
    const allAnalytics = await this.prisma.campaignAnalytics.findMany({
      where: {
        campaign_id: campaignId,
        timeGranularity: 'ALL',
      },
      orderBy: {
        dateFetched: 'desc',
      },
    });

    // Fetch DAILY granularity analytics
    const dailyAnalytics = await this.prisma.campaignAnalytics.findMany({
      where: {
        campaign_id: campaignId,
        timeGranularity: 'DAILY',
      },
      orderBy: {
        datePeriodStart: 'asc',
      },
    });

    this.logger.log(
      `Retrieved ${allAnalytics.length} ALL and ${dailyAnalytics.length} DAILY analytics records for campaign ID: ${campaignId}`,
    );

    return {
      allAnalytics,
      dailyAnalytics,
    };
  }

  ///////////////////////////////// ADS ANALYTICS //////////////////////////////////////

  async fetchLinkedInAdAnalytics(
    creativeUrns: string[],
    timeGranularity: 'ALL' | 'DAILY',
    startDate: Date,
    endDate: Date,
    fields: string[],
  ): Promise<void> {
    this.logger.log(
      `Fetching LinkedIn ad analytics for ${creativeUrns.length} creatives with granularity ${timeGranularity}`,
    );

    const accessToken = await this.linkedinService.getValidAccessToken();
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'LinkedIn-Version': '202505',
      'X-RestLi-Protocol-Version': '2.0.0',
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    const dateRange = `dateRange=(start:(year:${startDate.getUTCFullYear()},month:${startDate.getUTCMonth() + 1},day:${startDate.getUTCDate()}),end:(year:${endDate.getUTCFullYear()},month:${endDate.getUTCMonth() + 1},day:${endDate.getUTCDate()}))`;
    const creativesParam = `List(${creativeUrns.map((urn) => encodeURIComponent(urn)).join(',')})`;
    const queryString = [
      'q=analytics',
      'pivot=CREATIVE',
      `timeGranularity=${timeGranularity}`,
      `fields=${fields.join(',')}`,
      dateRange,
      `creatives=${creativesParam}`,
    ].join('&');

    const url = `https://api.linkedin.com/rest/adAnalytics?${queryString}`;

    try {
      const response = await axios.get<{ elements: any[] }>(url, { headers });

      const analyticsData = response.data.elements || [];
      this.logger.log(`Fetched ${analyticsData.length} ad analytics records`);

      switch (timeGranularity) {
        case 'ALL':
          await this.saveLinkedInAdAnalyticsAll(analyticsData);
          break;
        case 'DAILY':
          await this.saveLinkedInAdAnalyticsDaily(analyticsData);
          break;
        default:
          throw new Error(`Unsupported time granularity: ${timeGranularity}`);
      }
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
        if (error.response.status === 401)
          throw new UnauthorizedException('Invalid or expired access token');
        if (error.response.status === 403)
          throw new ForbiddenException(
            'Missing required scopes (r_ads, r_ads_reporting)',
          );
        if (error.response.status === 429)
          throw new Error('Rate limit exceeded');
      }
      this.logger.error(`Failed to fetch ad analytics: ${error.message}`);
      throw new Error('Failed to fetch LinkedIn ad analytics');
    }
  }

  async saveLinkedInAdAnalyticsAll(analyticsData: any[]): Promise<void> {
    this.logger.log(
      `Saving ALL granularity ad analytics for ${analyticsData.length} creatives`,
    );
    this.logger.debug(
      `Analytics data: ${JSON.stringify(analyticsData, null, 2)}`,
    );
    for (const item of analyticsData) {
      const urn = item.pivotValues?.[0];
      if (!urn) {
        this.logger.warn(
          `Skipping analytics entry without pivotValues: ${JSON.stringify(item)}`,
        );
        continue;
      }
      const externalId = this.extractIdFromUrn(urn);
      if (!externalId) {
        this.logger.warn(`Invalid creative URN: ${urn}`);
        continue;
      }
      const ad = await this.prisma.ad.findUnique({
        where: { id: externalId },
      });
      if (!ad) {
        this.logger.warn(
          `Ad not found for external ID ${externalId}, skipping`,
        );
        continue;
      }

      const campaign = await this.prisma.marketingCampaign.findUnique({
        where: { campaign_id: ad.campaignId },
      });
      if (!campaign) {
        this.logger.warn(
          `Campaign not found for external ID ${externalId}, skipping`,
        );
        continue;
      }

      await this.prisma.adAnalytics.upsert({
        where: {
          adId_datePeriodStart_datePeriodEnd_timeGranularity: {
            adId: ad.id,
            datePeriodStart: campaign.start_date,
            datePeriodEnd: new Date(),
            timeGranularity: 'ALL',
          },
        },
        update: this.mapAnalyticsFields(item),
        create: {
          adId: ad.id,
          timeGranularity: 'ALL',
          datePeriodStart: campaign.start_date,
          datePeriodEnd: new Date(),
          ...this.mapAnalyticsFields(item),
        },
      });
    }
    this.logger.log(
      `Saved ALL granularity ad analytics for ${analyticsData.length} creatives`,
    );
  }

  async saveLinkedInAdAnalyticsDaily(analyticsData: any[]): Promise<void> {
    for (const item of analyticsData) {
      const externalId = item.pivotValues?.creative;
      if (!externalId) {
        this.logger.warn(
          `Skipping analytics entry without creative pivot: ${JSON.stringify(item)}`,
        );
        continue;
      }
      const ad = await this.prisma.ad.findUnique({
        where: { id: externalId },
      });
      if (!ad) {
        this.logger.warn(
          `Ad not found for external ID ${externalId}, skipping`,
        );
        continue;
      }

      await this.prisma.adAnalytics.upsert({
        where: {
          adId_datePeriodStart_datePeriodEnd_timeGranularity: {
            adId: ad.id,
            datePeriodStart: new Date(item.dateRange.start),
            datePeriodEnd: new Date(item.dateRange.end),
            timeGranularity: 'DAILY',
          },
        },
        update: this.mapAnalyticsFields(item),
        create: {
          adId: ad.id,
          timeGranularity: 'DAILY',
          datePeriodStart: new Date(item.dateRange.start),
          datePeriodEnd: new Date(item.dateRange.end),
          ...this.mapAnalyticsFields(item),
        },
      });
    }
    this.logger.log(
      `Saved DAILY granularity ad analytics for ${analyticsData.length} creatives`,
    );
  }

  async getAdsAndAnalyticsByCampaignId(campaignId: string): Promise<{
    ads: Array<{
      id: string;
      name: string;
      campaignId: string;
      reviewStatus: string;
      servingHoldReasons?: string[];
      rejectionReasons?: string[];
      intendedStatus?: string;
      leadgenCallToAction?: any;
      isServing: boolean;
      createdAt: Date;
      lastModifiedAt: Date;
      allAnalytics: any[];
      dailyAnalytics: any[];
    }>;
  }> {
    this.logger.log(
      `Fetching ads and analytics for campaign ID: ${campaignId}`,
    );

    // Verify campaign exists
    const campaign = await this.prisma.marketingCampaign.findUnique({
    where: { campaign_id: campaignId },
    select: {
      campaign_id: true,
      objective: true, // Assuming 'objective' is a field in the MarketingCampaign model
    },
  });

    if (!campaign) {
      this.logger.warn(`Campaign not found for ID: ${campaignId}`);
      throw new NotFoundException(`Campaign with ID ${campaignId} not found`);
    }

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

    // Fetch ads and their analytics
    const ads = await this.prisma.ad.findMany({
    where: {
      campaignId: campaignId,
    },
    select: {
      id: true,
      name: true,
      campaignId: true,
      reviewStatus: true,
      isServing: true,
      servingHoldReasons: true,
      rejectionReasons: true,
      intendedStatus: true,
      leadgenCallToAction: true,
      createdAt: true,
      lastModifiedAt: true,
      AdAnalytics: {
        where: {
          OR: [{ timeGranularity: 'ALL' }, { timeGranularity: 'DAILY' }],
        },
        select: {
          id: true,
          adId: true,
          dateFetched: true,
          timeGranularity: true,
          datePeriodStart: true,
          datePeriodEnd: true,
          // Dynamically select only the relevant metrics
          ...metrics.reduce((acc, metric) => ({ ...acc, [metric]: true }), {}),
        },
        orderBy: [
          { timeGranularity: 'asc' },
          { datePeriodStart: 'asc' },
          { dateFetched: 'desc' },
        ],
      },
    },
  });

    // Structure response
    const formattedAds = ads.map((ad) => ({
    id: ad.id,
    name: ad.name ?? '',
    campaignId: ad.campaignId,
    reviewStatus: ad.reviewStatus ?? '',
    servingHoldReasons: ad.servingHoldReasons ?? [],
    rejectionReasons: ad.rejectionReasons ?? [],
    intendedStatus: ad.intendedStatus ?? '',
    leadgenCallToAction: ad.leadgenCallToAction,
    isServing: ad.isServing ?? false,
    createdAt: ad.createdAt ?? new Date(0),
    lastModifiedAt: ad.lastModifiedAt ?? new Date(0),
    allAnalytics: ad.AdAnalytics.filter(
      (analytics) => analytics.timeGranularity === 'ALL',
    ).map((analytics) => ({
      id: analytics.id,
      adId: analytics.adId,
      dateFetched: analytics.dateFetched,
      timeGranularity: analytics.timeGranularity,
      datePeriodStart: analytics.datePeriodStart,
      datePeriodEnd: analytics.datePeriodEnd,
      // Include only the selected metrics
      ...metrics.reduce(
        (acc, metric) => ({ ...acc, [metric]: analytics[metric] }),
        {},
      ),
    })),
    dailyAnalytics: ad.AdAnalytics.filter(
      (analytics) => analytics.timeGranularity === 'DAILY',
    ).map((analytics) => ({
      id: analytics.id,
      adId: analytics.adId,
      dateFetched: analytics.dateFetched,
      timeGranularity: analytics.timeGranularity,
      datePeriodStart: analytics.datePeriodStart,
      datePeriodEnd: analytics.datePeriodEnd,
      // Include only the selected metrics
      ...metrics.reduce(
        (acc, metric) => ({ ...acc, [metric]: analytics[metric] }),
        {},
      ),
    })),
  }));

    this.logger.log(
      `Retrieved ${formattedAds.length} ads with ${formattedAds.reduce(
        (sum, ad) => sum + ad.allAnalytics.length + ad.dailyAnalytics.length,
        0,
      )} total analytics records for campaign ID: ${campaignId}`,
    );

    return { ads: formattedAds };
  }
}
