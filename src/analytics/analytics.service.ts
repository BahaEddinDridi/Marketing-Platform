// src/services/analytics.service.ts
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { LeadStatus } from '@prisma/client';
import { LinkedInAnalyticsService } from './linkedin/linkedinAnalytics.service';

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
    sections: string[] = [],
  ): Promise<{
    totalSpend?: {
      localCurrency: number;
      trend: Array<{ date: Date; localCurrency: number }>;
    };
    activeCampaigns?: number;
    leadsGenerated?: {
      total: number;
      bySource: Array<{ source: string; count: number }>;
      trend: Array<{ date: Date; count: number }>;
    };
    averageCTR?: number;
    conversionRate?: {
      overall: number;
      bySource: Array<{ source: string; rate: number; totalLeads: number }>;
      byStatus: Array<{ status: LeadStatus; count: number }>;
    };
    additionalMetrics?: {
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
      `Fetching dashboard data for period: ${startDate.toISOString()} to ${endDate.toISOString()}, sections: ${sections.join(',')}`,
    );

    // Validate date range
    if (startDate > endDate) {
      throw new BadRequestException('startDate must be before or equal to endDate');
    }

    const includeAll = sections.length === 0;
    const result: any = {};

    const promises: Promise<void>[] = [];
    if (includeAll || sections.includes('totalSpend')) {
      promises.push(this.getTotalSpend(startDate, endDate).then((data) => { result.totalSpend = data; }));
    }
    if (includeAll || sections.includes('activeCampaigns')) {
      promises.push(this.getActiveCampaigns().then((data) => { result.activeCampaigns = data; }));
    }
    if (includeAll || sections.includes('leadsGenerated')) {
      promises.push(this.getLeadsGenerated(startDate, endDate).then((data) => { result.leadsGenerated = data; }));
    }
    if (includeAll || sections.includes('averageCTR')) {
      promises.push(this.getAverageCTR(startDate, endDate).then((data) => { result.averageCTR = data; }));
    }
    if (includeAll || sections.includes('conversionRate')) {
      promises.push(this.getConversionRate(startDate, endDate).then((data) => { result.conversionRate = data; }));
    }
    if (includeAll || sections.includes('additionalMetrics')) {
      promises.push(this.getAdditionalMetrics(startDate, endDate).then((data) => { result.additionalMetrics = data; }));
    }

    await Promise.allSettled(promises).then((results) => {
      results.forEach((result, index) => {
        if (result.status === 'rejected') {
          this.logger.error(`Error in section ${sections[index] || 'unknown'}: ${result.reason}`);
        }
      });
    });

    return result;
  }

  private async getTotalSpend(
    startDate: Date,
    endDate: Date,
  ): Promise<{
    localCurrency: number;
    trend: Array<{ date: Date; localCurrency: number }>;
  }> {
    const normalizedStartDate = new Date(startDate);
    normalizedStartDate.setHours(0, 0, 0, 0);
    const normalizedEndDate = new Date(endDate);
    normalizedEndDate.setHours(23, 59, 59, 999);

    const aggregate = await this.prisma.campaignAnalytics.aggregate({
      where: {
        timeGranularity: 'ALL',
        datePeriodStart: { gte: normalizedStartDate },
        datePeriodEnd: { lte: normalizedEndDate },
      },
      _sum: { costInLocalCurrency: true },
    });

    const trendData = await this.prisma.campaignAnalytics.findMany({
      where: {
        timeGranularity: 'DAILY',
        datePeriodStart: { gte: normalizedStartDate },
        datePeriodEnd: { lte: normalizedEndDate },
      },
      select: { datePeriodStart: true, costInLocalCurrency: true },
      orderBy: { datePeriodStart: 'asc' },
    });

    return {
      localCurrency: aggregate._sum.costInLocalCurrency ?? 0,
      trend: trendData.map((item) => ({
        date: item.datePeriodStart,
        localCurrency: item.costInLocalCurrency ?? 0,
      })),
    };
  }

  private async getActiveCampaigns(): Promise<number> {
    return this.prisma.marketingCampaign.count({
      where: { status: 'ACTIVE' },
    });
  }

  private async getLeadsGenerated(
    startDate: Date,
    endDate: Date,
  ): Promise<{
    total: number;
    bySource: Array<{ source: string; count: number }>;
    trend: Array<{ date: Date; count: number }>;
  }> {
    const normalizedStartDate = new Date(startDate);
    normalizedStartDate.setHours(0, 0, 0, 0);
    const normalizedEndDate = new Date(endDate);
    normalizedEndDate.setHours(23, 59, 59, 999);

    const leads = await this.prisma.lead.groupBy({
      by: ['source'],
      where: {
        created_at: { gte: normalizedStartDate, lte: normalizedEndDate },
      },
      _count: { lead_id: true },
    });

    const trendData = await this.prisma.lead.groupBy({
      by: ['created_at'],
      where: {
        created_at: { gte: normalizedStartDate, lte: normalizedEndDate },
      },
      _count: { lead_id: true },
      orderBy: { created_at: 'asc' },
    });

    const total = leads.reduce((sum, item) => sum + item._count.lead_id, 0);

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
      select: { clicks: true, impressions: true },
    });

    if (analytics.length === 0) return 0;

    const totalClicks = analytics.reduce((sum, item) => sum + (item.clicks ?? 0), 0);
    const totalImpressions = analytics.reduce((sum, item) => sum + (item.impressions ?? 0), 0);

    return totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;
  }

  private async getConversionRate(
    startDate: Date,
    endDate: Date,
  ): Promise<{
    overall: number;
    bySource: Array<{ source: string; rate: number; totalLeads: number }>;
    byStatus: Array<{ status: LeadStatus; count: number }>;
  }> {
    const normalizedStartDate = new Date(startDate);
    normalizedStartDate.setHours(0, 0, 0, 0);
    const normalizedEndDate = new Date(endDate);
    normalizedEndDate.setHours(23, 59, 59, 999);

    const totalLeadsBySource = await this.prisma.lead.groupBy({
      by: ['source'],
      where: {
        created_at: { gte: normalizedStartDate, lte: normalizedEndDate },
      },
      _count: { lead_id: true },
    });

    const convertedLeadsBySource = await this.prisma.lead.groupBy({
      by: ['source'],
      where: {
        created_at: { gte: normalizedStartDate, lte: normalizedEndDate },
        status: LeadStatus.CONVERTED,
      },
      _count: { lead_id: true },
    });

    const byStatus = await this.prisma.lead.groupBy({
      by: ['status'],
      where: {
        created_at: { gte: normalizedStartDate, lte: normalizedEndDate },
      },
      _count: { lead_id: true },
    });

    const totalLeads = totalLeadsBySource.reduce((sum, item) => sum + item._count.lead_id, 0);
    const totalConverted = convertedLeadsBySource.reduce((sum, item) => sum + item._count.lead_id, 0);

    const bySource = totalLeadsBySource.map((item) => {
      const converted = convertedLeadsBySource.find((c) => c.source === item.source);
      const convertedCount = converted?._count.lead_id ?? 0;
      return {
        source: item.source,
        rate: item._count.lead_id > 0 ? (convertedCount / item._count.lead_id) * 100 : 0,
        totalLeads: item._count.lead_id,
      };
    });

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
    const normalizedStartDate = new Date(startDate);
    normalizedStartDate.setHours(0, 0, 0, 0);
    const normalizedEndDate = new Date(endDate);
    normalizedEndDate.setHours(23, 59, 59, 999);

    // Aggregate metrics by campaign_id to avoid duplicates
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
        reactions: true,
        shares: true,
        comments: true,
      },
      orderBy: { _sum: { clicks: 'desc' } },
      take: 6, // Fetch top 6 campaigns
    });

    // Fetch campaign names for the aggregated campaign IDs
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

    // Map aggregated data to topPerformingCampaigns, ensuring no duplicates
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

    // Aggregate engagement metrics
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

    return {
      topPerformingCampaigns,
      engagementMetrics: {
        totalReactions: engagement._sum.reactions ?? 0,
        totalShares: engagement._sum.shares ?? 0,
        totalComments: engagement._sum.comments ?? 0,
      },
    };
  }


  async getPlatformConfigs(): Promise<Array<{
  platform: string;
  lastSyncedAt: Date | null;
  autoSyncEnabled: boolean;
}>> {
  this.logger.log('Fetching platform configuration details');

  // Fetch configurations for LinkedIn, Google, and Meta
  const [linkedInConfig, googleConfig, metaConfig] = await Promise.all([
    this.prisma.linkedInCampaignConfig.findFirst({
      select: {
        lastSyncedAt: true,
        autoSyncEnabled: true,
      },
    }),
    this.prisma.googleCampaignConfig.findFirst({
      select: {
        lastSyncedAt: true,
        autoSyncEnabled: true,
      },
    }),
    this.prisma.metaCampaignConfig.findFirst({
      select: {
        lastSyncedAt: true,
        autoSyncEnabled: true,
      },
    }),
  ]);

  // Construct the result array
  const result = [
    {
      platform: 'LinkedIn',
      lastSyncedAt: linkedInConfig?.lastSyncedAt ?? null,
      autoSyncEnabled: linkedInConfig?.autoSyncEnabled ?? false,
    },
    {
      platform: 'Google',
      lastSyncedAt: googleConfig?.lastSyncedAt ?? null,
      autoSyncEnabled: googleConfig?.autoSyncEnabled ?? false,
    },
    {
      platform: 'Meta',
      lastSyncedAt: metaConfig?.lastSyncedAt ?? null,
      autoSyncEnabled: metaConfig?.autoSyncEnabled ?? false,
    },
  ];

  return result;
}
}