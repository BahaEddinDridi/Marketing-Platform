import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { LinkedInAnalyticsService } from './linkedin/linkedinAnalytics.service';
import { LeadStatus } from '@prisma/client';

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(
    private prisma: PrismaService,
    private linkedinAnalyticsService: LinkedInAnalyticsService,
  ) {}

  async create(data: any) {
    return this.prisma.campaignAnalytics.create(data);
  }

  async findAll() {
    return this.prisma.campaignAnalytics.findMany();
  }

  async findOne(id: string) {
    return this.prisma.campaignAnalytics.findUnique({ where: { id: id } });
  }

  async update(id: string, data: any) {
    return this.prisma.campaignAnalytics.update({
      where: { id: id },
      data: data,
    });
  }

  async remove(id: string) {
    return this.prisma.campaignAnalytics.delete({ where: { id: id } });
  }

  async getDashboardData(
    startDate: Date,
    endDate: Date,
  ): Promise<{
    totalSpend: {
      localCurrency: number;
      trend: Array<{ date: Date; localCurrency: number }>;
    };
    activeCampaigns: number;
    leadsGenerated: {
      total: number;
      bySource: Array<{ source: string; count: number }>;
      trend: Array<{ date: Date; count: number }>;
    };
    averageCTR: number;
    conversionRate: {
      overall: number;
      bySource: Array<{ source: string; rate: number; totalLeads: number }>;
      byStatus: Array<{ status: LeadStatus; count: number }>;
    };
    additionalMetrics: {
      topPerformingCampaigns: Array<{
        campaignId: string;
        name: string;
        impressions: number;
        clicks: number;
        qualifiedLeads: number;
      }>;
      engagementMetrics: {
        totalReactions: number;
        totalShares: number;
        totalComments: number;
      };
    };
  }> {
    this.logger.log(
      `Fetching dashboard data for period: ${startDate.toISOString()} to ${endDate.toISOString()}`,
    );

    // Validate date range
    if (startDate > endDate) {
      throw new BadRequestException(
        'startDate must be before or equal to endDate',
      );
    }

    // Fetch all required data concurrently
    const [
      totalSpend,
      activeCampaigns,
      leadsGenerated,
      averageCTR,
      conversionRate,
      additionalMetrics,
    ] = await Promise.all([
      this.getTotalSpend(startDate, endDate),
      this.getActiveCampaigns(),
      this.getLeadsGenerated(startDate, endDate),
      this.getAverageCTR(startDate, endDate),
      this.getConversionRate(startDate, endDate),
      this.getAdditionalMetrics(startDate, endDate),
    ]);

    return {
      totalSpend,
      activeCampaigns,
      leadsGenerated,
      averageCTR,
      conversionRate,
      additionalMetrics,
    };
  }

 
  private async getTotalSpend(
    startDate: Date,
    endDate: Date,
  ): Promise<{
    localCurrency: number;
    trend: Array<{ date: Date; localCurrency: number }>;
  }> {
    // Normalize dates to start and end of day to handle time portions
    const normalizedStartDate = new Date(startDate);
    normalizedStartDate.setHours(0, 0, 0, 0);
    const normalizedEndDate = new Date(endDate);
    normalizedEndDate.setHours(23, 59, 59, 999);

    this.logger.debug(
      `getTotalSpend: Querying for period ${normalizedStartDate.toISOString()} to ${normalizedEndDate.toISOString()}`,
    );

    // Aggregate total spend for ALL granularity
    const aggregate = await this.prisma.campaignAnalytics.aggregate({
      where: {
        timeGranularity: 'ALL',
        datePeriodStart: { gte: normalizedStartDate },
        datePeriodEnd: { lte: normalizedEndDate },
      },
      _sum: {
        costInLocalCurrency: true,
      },
    });

    // Fetch trend data for DAILY granularity
    const trendData = await this.prisma.campaignAnalytics.findMany({
      where: {
        timeGranularity: 'DAILY',
        datePeriodStart: { gte: normalizedStartDate },
        datePeriodEnd: { lte: normalizedEndDate },
      },
      select: {
        datePeriodStart: true,
        costInLocalCurrency: true,
      },
      orderBy: { datePeriodStart: 'asc' },
    });

    this.logger.debug(
      `getTotalSpend: Aggregate = ${JSON.stringify(aggregate)}, Trend = ${JSON.stringify(trendData)}`,
    );

    return {
      localCurrency: aggregate._sum.costInLocalCurrency ?? 0,
      trend: trendData.map((item) => ({
        date: item.datePeriodStart,
        localCurrency: item.costInLocalCurrency ?? 0,
      })),
    };
  }


  private async getActiveCampaigns(): Promise<number> {
    const count = await this.prisma.marketingCampaign.count({
      where: {
        status: 'ACTIVE',
      },
    });

    this.logger.debug(`getActiveCampaigns: Count = ${count}`);
    return count;
  }


  private async getLeadsGenerated(
    startDate: Date,
    endDate: Date,
  ): Promise<{
    total: number;
    bySource: Array<{ source: string; count: number }>;
    trend: Array<{ date: Date; count: number }>;
  }> {
    // Normalize dates to start and end of day
    const normalizedStartDate = new Date(startDate);
    normalizedStartDate.setHours(0, 0, 0, 0);
    const normalizedEndDate = new Date(endDate);
    normalizedEndDate.setHours(23, 59, 59, 999);

    this.logger.debug(
      `getLeadsGenerated: Querying for period ${normalizedStartDate.toISOString()} to ${normalizedEndDate.toISOString()}`,
    );

    // Total leads and by source
    const leads = await this.prisma.lead.groupBy({
      by: ['source'],
      where: {
        created_at: { gte: normalizedStartDate, lte: normalizedEndDate },
      },
      _count: { lead_id: true },
    });

    // Trend data (daily)
    const trendData = await this.prisma.lead.groupBy({
      by: ['created_at'],
      where: {
        created_at: { gte: normalizedStartDate, lte: normalizedEndDate },
      },
      _count: { lead_id: true },
      orderBy: { created_at: 'asc' },
    });

    const total = leads.reduce((sum, item) => sum + item._count.lead_id, 0);

    this.logger.debug(
      `getLeadsGenerated: Leads = ${JSON.stringify(leads)}, Trend = ${JSON.stringify(trendData)}, Total = ${total}`,
    );

    return {
      total,
      bySource: leads.map((item) => ({
        source: item.source,
        count: item._count.lead_id,
      })),
      trend: trendData.map((item) => ({
        date: item.created_at,
        count: item._count.lead_id,
      })),
    };
  }


  private async getAverageCTR(startDate: Date, endDate: Date): Promise<number> {
    // Normalize dates
    const normalizedStartDate = new Date(startDate);
    normalizedStartDate.setHours(0, 0, 0, 0);
    const normalizedEndDate = new Date(endDate);
    normalizedEndDate.setHours(23, 59, 59, 999);

    const analytics = await this.prisma.campaignAnalytics.findMany({
      where: {
        timeGranularity: 'ALL',
        datePeriodStart: { gte: normalizedStartDate },
        datePeriodEnd: { lte: normalizedEndDate },
      },
      select: {
        clicks: true,
        impressions: true,
      },
    });

    this.logger.debug(`getAverageCTR: Analytics = ${JSON.stringify(analytics)}`);

    if (analytics.length === 0) return 0;

    const totalClicks = analytics.reduce(
      (sum, item) => sum + (item.clicks ?? 0),
      0,
    );
    const totalImpressions = analytics.reduce(
      (sum, item) => sum + (item.impressions ?? 0),
      0,
    );

    const ctr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;
    this.logger.debug(
      `getAverageCTR: Clicks = ${totalClicks}, Impressions = ${totalImpressions}, CTR = ${ctr}`,
    );
    return ctr;
  }


  private async getConversionRate(
    startDate: Date,
    endDate: Date,
  ): Promise<{
    overall: number;
    bySource: Array<{ source: string; rate: number; totalLeads: number }>;
    byStatus: Array<{ status: LeadStatus; count: number }>;
  }> {
    // Normalize dates
    const normalizedStartDate = new Date(startDate);
    normalizedStartDate.setHours(0, 0, 0, 0);
    const normalizedEndDate = new Date(endDate);
    normalizedEndDate.setHours(23, 59, 59, 999);

    this.logger.debug(
      `getConversionRate: Querying for period ${normalizedStartDate.toISOString()} to ${normalizedEndDate.toISOString()}`,
    );

    // Group by source for total leads
    const totalLeadsBySource = await this.prisma.lead.groupBy({
      by: ['source'],
      where: {
        created_at: { gte: normalizedStartDate, lte: normalizedEndDate },
      },
      _count: { lead_id: true },
    });

    // Group by source for CONVERTED leads
    const convertedLeadsBySource = await this.prisma.lead.groupBy({
      by: ['source'],
      where: {
        created_at: { gte: normalizedStartDate, lte: normalizedEndDate },
        status: LeadStatus.CONVERTED,
      },
      _count: { lead_id: true },
    });

    // Group by status
    const byStatus = await this.prisma.lead.groupBy({
      by: ['status'],
      where: {
        created_at: { gte: normalizedStartDate, lte: normalizedEndDate },
      },
      _count: { lead_id: true },
    });

    const totalLeads = totalLeadsBySource.reduce(
      (sum, item) => sum + item._count.lead_id,
      0,
    );
    const totalConverted = convertedLeadsBySource.reduce(
      (sum, item) => sum + item._count.lead_id,
      0,
    );

    const bySource = totalLeadsBySource.map((item) => {
      const converted = convertedLeadsBySource.find(
        (c) => c.source === item.source,
      );
      const convertedCount = converted?._count.lead_id ?? 0;
      return {
        source: item.source,
        rate:
          item._count.lead_id > 0
            ? (convertedCount / item._count.lead_id) * 100
            : 0,
        totalLeads: item._count.lead_id,
      };
    });

    this.logger.debug(
      `getConversionRate: TotalLeads = ${totalLeads}, TotalConverted = ${totalConverted}, BySource = ${JSON.stringify(bySource)}, ByStatus = ${JSON.stringify(byStatus)}`,
    );

    return {
      overall: totalLeads > 0 ? (totalConverted / totalLeads) * 100 : 0,
      bySource,
      byStatus: byStatus.map((item) => ({
        status: item.status as LeadStatus,
        count: item._count.lead_id,
      })),
    };
  }

  private async getAdditionalMetrics(
  startDate: Date,
  endDate: Date,
): Promise<{
  topPerformingCampaigns: Array<{
    campaignId: string;
    name: string;
    impressions: number;
    clicks: number;
    qualifiedLeads: number;
  }>;
  engagementMetrics: {
    totalReactions: number;
    totalShares: number;
    totalComments: number;
  };
}> {
  // Normalize dates
  const normalizedStartDate = new Date(startDate);
  normalizedStartDate.setHours(0, 0, 0, 0);
  const normalizedEndDate = new Date(endDate);
  normalizedEndDate.setHours(23, 59, 59, 999);

  this.logger.debug(
    `getAdditionalMetrics: Querying for period ${normalizedStartDate.toISOString()} to ${normalizedEndDate.toISOString()}`,
  );

  // Top performing campaigns (by clicks, top 5, unique by campaign_id)
  const topCampaigns = await this.prisma.campaignAnalytics.groupBy({
    by: ['campaign_id'],
    where: {
      timeGranularity: 'ALL',
      datePeriodStart: { gte: normalizedStartDate },
      datePeriodEnd: { lte: normalizedEndDate },
    },
    _sum: {
      impressions: true,
      clicks: true,
      qualifiedLeads: true,
    },
    orderBy: { _sum: { clicks: 'desc' } },
    take: 5,
  });

  // Fetch campaign names for the selected campaign_ids
  const campaignIds = topCampaigns.map((item) => item.campaign_id);
  const campaigns = await this.prisma.marketingCampaign.findMany({
    where: {
      campaign_id: { in: campaignIds },
    },
    select: {
      campaign_id: true,
      campaign_name: true,
    },
  });

  // Map to topPerformingCampaigns format
  const topPerformingCampaigns = topCampaigns.map((item) => {
    const campaign = campaigns.find((c) => c.campaign_id === item.campaign_id);
    return {
      campaignId: item.campaign_id,
      name: campaign?.campaign_name ?? 'Unknown',
      impressions: item._sum.impressions ?? 0,
      clicks: item._sum.clicks ?? 0,
      qualifiedLeads: item._sum.qualifiedLeads ?? 0,
    };
  });

  // Engagement metrics
  const engagement = await this.prisma.campaignAnalytics.aggregate({
    where: {
      timeGranularity: 'ALL',
      datePeriodStart: { gte: normalizedStartDate },
      datePeriodEnd: { lte: normalizedEndDate },
    },
    _sum: {
      reactions: true,
      shares: true,
      comments: true,
    },
  });

  this.logger.debug(
    `getAdditionalMetrics: TopCampaigns = ${JSON.stringify(topCampaigns)}, Campaigns = ${JSON.stringify(campaigns)}, Engagement = ${JSON.stringify(engagement)}`,
  );

  return {
    topPerformingCampaigns,
    engagementMetrics: {
      totalReactions: engagement._sum.reactions ?? 0,
      totalShares: engagement._sum.shares ?? 0,
      totalComments: engagement._sum.comments ?? 0,
    },
  };
}
}