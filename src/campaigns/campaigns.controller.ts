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
} from '@nestjs/common';
import { CampaignsService } from './campaigns.service';
import { CreateCampaignDto } from './dto/create-campaign.dto';
import { UpdateCampaignDto } from './dto/update-campaign.dto';
import { JwtAuthGuard } from 'src/guards/jwt-auth.guard';

interface AuthenticatedRequest extends Request {
  user?: { user_id: string; email: string; orgId: string; role: string };
}

@Controller('campaigns')
export class CampaignsController {
  constructor(private readonly campaignsService: CampaignsService) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  create(@Body() createCampaignDto: CreateCampaignDto) {
    return this.campaignsService.create(createCampaignDto);
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  findAll() {
    return this.campaignsService.findAll();
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
    console.log(
      'Fetched LinkedIn Campaigns:',
      JSON.stringify(campaigns, null, 2),
    );
    return { success: true, campaigns };
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
      await this.campaignsService.createOrUpdateLinkedInCampaignConfig(
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
}
