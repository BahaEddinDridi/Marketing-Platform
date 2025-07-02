import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  NotFoundException,
} from '@nestjs/common';
import { JwtAuthGuard } from 'src/guards/jwt-auth.guard';
import { LinkedInAnalyticsService } from './linkedinAnalytics.service';

@Controller('analytics/linkedin')
export class LinkedInAnalyticsController {
  constructor(
    private readonly linkedInAnalyticsService: LinkedInAnalyticsService,
  ) {}

  @Get('campaigns/:id')
  @UseGuards(JwtAuthGuard)
  async getCampaignAnalytics(@Param('id') campaignId: string) {
    try {
      const analytics =
        await this.linkedInAnalyticsService.getCampaignAnalyticsByCampaignId(
          campaignId,
        );
      return {
        status: 'success',
        data: analytics,
      };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw new NotFoundException(error.message);
      }
      throw error;
    }
  }

  @Get('campaigns/ads/:id')
  @UseGuards(JwtAuthGuard)
  async getAdsAndAnalytics(@Param('id') campaignId: string) {
    try {
      const adsAnalytics =
        await this.linkedInAnalyticsService.getAdsAndAnalyticsByCampaignId(
          campaignId,
        );
      return {
        status: 'success',
        data: adsAnalytics,
      };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw new NotFoundException(error.message);
      }
      throw error;
    }
  }
}
