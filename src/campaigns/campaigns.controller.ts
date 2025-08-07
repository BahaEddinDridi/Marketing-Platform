import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  Req,
  Query,
  Res,
} from '@nestjs/common';
import { CampaignsService, LinkedInCampaignInput } from './campaigns.service';
import { CreateCampaignDto } from './dto/create-campaign.dto';
import { UpdateCampaignDto } from './dto/update-campaign.dto';
import { JwtAuthGuard } from 'src/guards/jwt-auth.guard';
import { CampaignStatus, ObjectiveType } from '@prisma/client';
import { LinkedInCampaignsService } from './linkedin/linkedinCampaign.service';
import { Response } from 'express';
interface AuthenticatedRequest extends Request {
  user?: { user_id: string; email: string; orgId: string; role: string };
}

interface BudgetRecommendationsRequest {
  adAccountId: string;
  objectiveType?: ObjectiveType;
  targetingCriteria: LinkedInCampaignInput['targetingCriteria'];
  campaignType?: string;
  bidType?: string;
  matchType?: string;
}

interface AudienceCountRequest {
  targetingCriteria: LinkedInCampaignInput['targetingCriteria'];
}

@Controller('campaigns')
export class CampaignsController {
  constructor(private readonly campaignsService: CampaignsService,
    private readonly linkedinCampaignsService: LinkedInCampaignsService

  ) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  create(@Body() createCampaignDto: CreateCampaignDto) {
    return this.campaignsService.create(createCampaignDto);
  }

  @Get()
@UseGuards(JwtAuthGuard)
findAll(
  @Query('page') page: string,
  @Query('pageSize') pageSize: string,
  @Query('campaignGroupId') campaignGroupId?: string,
  @Query('objective') objective?: string,
  @Query('status') status?: string,
  @Query('search') search?: string,
) {
  return this.campaignsService.findAll(
    parseInt(page) || 1,
    parseInt(pageSize) || 10,
    campaignGroupId,
    objective as ObjectiveType,
    status as CampaignStatus,
    search,
  );
}

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  findOne(@Param('id') id: string) {
    return this.campaignsService.findOne(id);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  update(
    @Param('id') id: string,
    @Body() updateCampaignDto: UpdateCampaignDto,
  ) {
    return this.campaignsService.update(id, updateCampaignDto);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  remove(@Param('id') id: string) {
    return this.campaignsService.remove(id);
  }

  @Post('linkedin/fetch')
  @UseGuards(JwtAuthGuard)
  async fetchLinkedInCampaigns(
    @Body('adAccountIds') adAccountIds: string | string[],
  ) {
    const ids = Array.isArray(adAccountIds) ? adAccountIds : [adAccountIds];
    const campaigns = await this.campaignsService.fetchLinkedInCampaigns(ids);
    return { success: true, campaigns };
  }

  @Post('linkedin/create')
  @UseGuards(JwtAuthGuard)
  async createLinkedInCampaign(
    @Req() req: AuthenticatedRequest,
    @Body() data: LinkedInCampaignInput,
  ) {
    const user = req.user as { user_id: string; orgId: string };
    const result = await this.campaignsService.createLinkedInCampaign(data);
    return {
      success: result.success,
      message: result.message,
    };
  }

  @Patch('linkedin/:campaignId')
  @UseGuards(JwtAuthGuard)
  async updateLinkedInCampaign(
    @Req() req: AuthenticatedRequest,
    @Param('campaignId') campaignId: string,
    @Body() data: LinkedInCampaignInput,
  ) {
    const user = req.user as { user_id: string; orgId: string };
    const result = await this.campaignsService.updateLinkedInCampaign(
      campaignId,
      data,
    );
    return {
      success: result.success,
      message: result.message,
      data: result.data,
    };
  }

  @Delete('linkedin/:campaignId')
  @UseGuards(JwtAuthGuard)
  async deleteLinkedInCampaign(
    @Req() req: AuthenticatedRequest,
    @Param('campaignId') campaignId: string,
  ) {
    const user = req.user as { user_id: string; orgId: string };
    const result =
      await this.campaignsService.deleteLinkedInCampaign(campaignId);
    return {
      success: result.success,
      message: result.message,
      data: result.data,
    };
  }

  @Post('linkedin/budget-recommendations')
  @UseGuards(JwtAuthGuard)
  async getBudgetRecommendations(@Body() data: BudgetRecommendationsRequest) {
    const result = await this.campaignsService.getBudgetRecommendations(data);
    return {
      success: result.success,
      message: result.message,
      data: result.data,
    };
  }

  @Post('linkedin/audience-count')
  @UseGuards(JwtAuthGuard)
  async getAudienceCount(@Body() body: any) {
    const result = await this.campaignsService.getAudienceCount(body);
    return {
      success: result.success,
      message: result.message,
      data: result.data,
    };
  }

  @Post('linkedin/metadata')
  @UseGuards(JwtAuthGuard)
  async fetchLinkedInMetadata(@Req() req: AuthenticatedRequest) {
    const user = req.user as { user_id: string; orgId: string };
    await this.campaignsService.fetchAndSaveLinkedInMetadata(user.orgId);
    return {
      success: true,
      message: 'LinkedIn metadata fetched and saved successfully',
    };
  }

  @Get('linkedin/metadata')
  @UseGuards(JwtAuthGuard)
  async getLinkedInMetadata(@Req() req: AuthenticatedRequest) {
    const user = req.user as { user_id: string; orgId: string };
    const metadata = await this.campaignsService.fetchLinkedInMetadata(
      user.orgId,
    );
    return {
      success: true,
      data: metadata,
    };
  }

  @Get('linkedin/metadata/search')
  @UseGuards(JwtAuthGuard)
  async searchLinkedInMetadata(
    @Req() req: AuthenticatedRequest,
    @Query('facet') facet: string,
    @Query('searchTerm') searchTerm = '',
  ) {
    const user = req.user as { user_id: string; orgId: string };
    const metadata = await this.campaignsService.searchLinkedInMetadata(
      user.orgId,
      facet,
      searchTerm,
    );
    return {
      success: true,
      data: metadata,
    };
  }

  @Post('linkedin/config')
  @UseGuards(JwtAuthGuard)
  async createOrUpdateLinkedInCampaignConfig(
    @Req() req: AuthenticatedRequest,
    @Body()
    config: {
      syncInterval: string;
      adAccountIds: string[];
      campaignGroupIds: string[];
      autoSyncEnabled: boolean;
    },
  ) {
    const user = req.user as { user_id: string; orgId: string };
    const configRecord =
      await this.linkedinCampaignsService.createOrUpdateLinkedInCampaignConfig(
        user.orgId,
        config,
      );
    return {
      success: true,
      message: 'LinkedIn campaign configuration saved successfully',
      config: configRecord,
    };
  }
  @Get('linkedin/config')
  @UseGuards(JwtAuthGuard)
  async getLinkedInCampaignConfig(
    @Req() req: AuthenticatedRequest,
  ): Promise<{ success: boolean; config: any }> {
    const config = await this.campaignsService.getLinkedInCampaignConfig();
    return {
      success: true,
      config,
    };
  }

  @Post('groups')
  @UseGuards(JwtAuthGuard)
  async createCampaignGroup(
    @Body()
    data: {
      adAccountId: string;
      name: string;
      runSchedule: { start: number; end?: number };
      status: 'ACTIVE' | 'DRAFT';
      totalBudget?: { amount: string; currencyCode: string };
      objectiveType?: string;
    },
  ) {
    const result = await this.campaignsService.createCampaignGroup(data);
    return {
      success: true,
      message: result.message,
      data: result.data,
    };
  }

  @Get('groups/getAll')
  @UseGuards(JwtAuthGuard)
  async findAllCampaignGroups() {
    const campaignGroups = await this.campaignsService.findAllCampaignGroups();
    return campaignGroups;
  }

  @Get('groups/:id')
  @UseGuards(JwtAuthGuard)
  async findOneCampaignGroup(@Param('id') id: string) {
    const campaignGroup = await this.campaignsService.findOneCampaignGroup(id);
    return campaignGroup;
  }

  @Patch('groups/:id')
  @UseGuards(JwtAuthGuard)
  async updateCampaignGroup(
    @Param('id') id: string,
    @Body()
    data: {
      name?: string;
      status?: 'ACTIVE' | 'DRAFT' | 'PAUSED' | 'ARCHIVED' | 'PENDING_DELETION';
      runSchedule?: { start?: number; end?: number };
      totalBudget?: { amount: string; currencyCode: string };
    },
  ) {
    const result = await this.campaignsService.updateCampaignGroup(id, data);
    return {
      success: true,
      message: result.message,
      data: result.data,
    };
  }

  @Delete('groups/:id')
  @UseGuards(JwtAuthGuard)
  async removeCampaignGroup(@Param('id') id: string) {
    const result = await this.campaignsService.removeCampaignGroup(id);
    return {
      success: true,
      message: result.message,
      data: result.data,
    };
  }

    @Get(':campaignId/report/pdf')
  @UseGuards(JwtAuthGuard)
  async downloadCampaignReport(
    @Param('campaignId') campaignId: string,
    @Res() res: Response,
  ) {
    try {
      const pdfBuffer = await this.linkedinCampaignsService.createPdfReport(campaignId);
      res.set({
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename=campaign-report-${campaignId}.pdf`,
        'Content-Length': pdfBuffer.length,
      });
      res.send(pdfBuffer);
    } catch (error: any) {
      return res.status(500).json({
        success: false,
        message: 'Failed to generate PDF report',
        error: error.message,
      });
    }
  }
}
