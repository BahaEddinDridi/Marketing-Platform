import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  UseGuards,
  Delete,
  Patch,
  InternalServerErrorException,
  Query,
  ParseArrayPipe,
} from '@nestjs/common';
import { MetaCampaignInput, MetaCampaignService } from './metaCampaign.service';
import { JwtAuthGuard } from 'src/guards/jwt-auth.guard';
import { MetaAdSetService } from './metaAdSet.service';

@Controller('campaigns/meta')
export class MetaCampaignController {
  constructor(
    private readonly metaCampaignService: MetaCampaignService,
    private readonly metaAdSetService: MetaAdSetService,
  ) {}

  @Get('/list')
  @UseGuards(JwtAuthGuard)
  async listMetaCampaigns(
    @Query('search') search?: string,
    @Query('status', new ParseArrayPipe({ items: String, optional: true, separator: ',' })) status?: string[],
    @Query('objective', new ParseArrayPipe({ items: String, optional: true, separator: ',' })) objective?: string[],
    @Query('startDateFrom') startDateFrom?: string,
    @Query('startDateTo') startDateTo?: string,
    @Query('endDateFrom') endDateFrom?: string,
    @Query('endDateTo') endDateTo?: string,
    @Query('minDailyBudget') minDailyBudget?: number,
    @Query('maxDailyBudget') maxDailyBudget?: number,
    @Query('minLifetimeBudget') minLifetimeBudget?: number,
    @Query('maxLifetimeBudget') maxLifetimeBudget?: number,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: 'asc' | 'desc',
  ) {
    return this.metaCampaignService.fetchAllCampaigns({
      search,
      status: status && status.length > 0 ? status : undefined,
      objective: objective && objective.length > 0 ? objective : undefined,
      startDateFrom: startDateFrom ? new Date(startDateFrom) : undefined,
      startDateTo: startDateTo ? new Date(startDateTo) : undefined,
      endDateFrom: endDateFrom ? new Date(endDateFrom) : undefined,
      endDateTo: endDateTo ? new Date(endDateTo) : undefined,
      minDailyBudget,
      maxDailyBudget,
      minLifetimeBudget,
      maxLifetimeBudget,
      page,
      limit,
      sortBy,
      sortOrder,
    });
  }

  @Get('/list/:campaignId')
  @UseGuards(JwtAuthGuard)
  async getMetaCampaignById(@Param('campaignId') campaignId: string) {
    return this.metaCampaignService.fetchCampaignById(campaignId);
  }

  @Get('/adsets/:campaignId')
  @UseGuards(JwtAuthGuard)
  async getAdSetsWithAds(@Param('campaignId') campaignId: string) {
    return this.metaCampaignService.fetchAdSetsWithAds(campaignId);
  }

  @Post('/config')
  @UseGuards(JwtAuthGuard)
  async createOrUpdateMetaCampaignConfig(
    @Body()
    config: {
      syncInterval: string;
      autoSyncEnabled: boolean;
      adAccountIds: string[];
    },
  ) {
    return this.metaCampaignService.createOrUpdateMetaCampaignConfig(
      'single-org',
      config,
    );
  }

  @Get('/config/:orgId')
  @UseGuards(JwtAuthGuard)
  async getMetaCampaignConfigByOrgId(
    @Param('orgId') orgId: string = 'single-org',
  ) {
    try {
      const configRecord =
        await this.metaCampaignService.getMetaCampaignConfigByOrgId(orgId);
      return { success: true, config: configRecord };
    } catch (error: any) {
      throw new InternalServerErrorException(
        `Failed to fetch Meta campaign configuration: ${error.message || 'Unknown error'}`,
      );
    }
  }
  @Post('/create')
  @UseGuards(JwtAuthGuard)
  async createMetaCampaign(@Body() data: MetaCampaignInput) {
    return this.metaCampaignService.createCampaign('single-org', data);
  }

  @Patch('/update/:campaignId')
  @UseGuards(JwtAuthGuard)
  async updateMetaCampaign(
    @Param('campaignId') campaignId: string,
    @Body() data: Partial<MetaCampaignInput>,
  ) {
    return this.metaCampaignService.updateCampaign(
      'single-org',
      campaignId,
      data,
    );
  }

  @Delete('/delete/:campaignId')
  @UseGuards(JwtAuthGuard)
  async deleteMetaCampaign(@Param('campaignId') campaignId: string) {
    return this.metaCampaignService.deleteCampaign('single-org', campaignId);
  }

  @Get('/regions/:query')
  @UseGuards(JwtAuthGuard)
  async searchRegions(@Param('query') query: string) {
    return this.metaAdSetService.searchRegions('single-org', query);
  }

  @Get('/interests/:interest')
  @UseGuards(JwtAuthGuard)
  async searchInterests(@Param('interest') interest: string) {
    return this.metaAdSetService.searchInterests('single-org', interest);
  }

  @Post('/adsets/create/:campaignId')
  @UseGuards(JwtAuthGuard)
  async createAdSet(
    @Param('campaignId') campaignId: string,
    @Body()
    data: {
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
        end_time?: string;
      };
    },
  ) {
    return this.metaAdSetService.createAdSet('single-org', campaignId, data);
  }
}
