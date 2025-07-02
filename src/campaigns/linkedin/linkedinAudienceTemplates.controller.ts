import {
  Controller,
  Get,
  Post,
  Param,
  UseGuards,
  Req,
  Body,
  Delete,
} from '@nestjs/common';
import { JwtAuthGuard } from 'src/guards/jwt-auth.guard';
import {
  CreateAudienceTemplateInput,
  LinkedInAudienceService,
} from './linkedinAudienceTemplates.service';

interface AuthenticatedRequest extends Request {
  user?: { user_id: string; email: string; orgId: string; role: string };
}

@Controller('linkedin/audience')
export class LinkedInAudienceController {
  constructor(
    private readonly linkedInAudienceService: LinkedInAudienceService,
  ) {}

  @Post('templates')
  @UseGuards(JwtAuthGuard)
  async fetchAudienceTemplates(@Req() req: AuthenticatedRequest) {
    const user = req.user as { user_id: string; orgId: string };
    const result = await this.linkedInAudienceService.fetchAudienceTemplates(
      user.orgId,
    );
    return {
      success: result.success,
      message: result.message,
      data: result.data,
    };
  }

  @Get('templates/all')
  @UseGuards(JwtAuthGuard)
  async getAllAudienceTemplates(@Req() req: AuthenticatedRequest) {
    const result = await this.linkedInAudienceService.getAllAudienceTemplates();
    return {
      success: result.success,
      message: result.message,
      data: result.data,
    };
  }

  @Get('templates/:adAccountId')
  @UseGuards(JwtAuthGuard)
  async getAudienceTemplatesByAccountId(
    @Req() req: AuthenticatedRequest,
    @Param('adAccountId') adAccountId: string,
  ) {
    const result =
      await this.linkedInAudienceService.getAudienceTemplatesByAccountId(
        adAccountId,
      );
    return {
      success: result.success,
      message: result.message,
      data: result.data,
    };
  }

  @Post('templates/create')
  @UseGuards(JwtAuthGuard)
  async createAudienceTemplate(
    @Req() req: AuthenticatedRequest,
    @Body() input: CreateAudienceTemplateInput,
  ) {
    const result =
      await this.linkedInAudienceService.createAudienceTemplate(input);
    return {
      success: result.success,
      message: result.message,
      data: result.data,
    };
  }

  @Post('templates/update/:templateId')
  @UseGuards(JwtAuthGuard)
  async updateAudienceTemplate(
    @Req() req: AuthenticatedRequest,
    @Param('templateId') templateId: string,
    @Body() input: CreateAudienceTemplateInput,
  ) {
    const result = await this.linkedInAudienceService.updateAudienceTemplate(
      templateId,
      input,
    );
    return {
      success: result.success,
      message: result.message,
      data: result.data,
    };
  }

  @Delete('templates/:templateId')
  @UseGuards(JwtAuthGuard)
  async deleteAudienceTemplate(
    @Req() req: AuthenticatedRequest,
    @Param('templateId') templateId: string,
  ) {
    const result = await this.linkedInAudienceService.deleteAudienceTemplate(
      templateId,
    );
    return {
      success: result.success,
      message: result.message,
      data: result.data,
    };
  }
}
