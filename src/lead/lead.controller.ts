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
  Res,
  UnauthorizedException,
  Put,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { LeadService } from './lead.service';
import { CreateLeadDto } from './dto/create-lead.dto';
import { UpdateLeadDto } from './dto/update-lead.dto';
import { JwtAuthGuard } from 'src/guards/jwt-auth.guard';
import { AuthGuard } from '@nestjs/passport';

interface AuthenticatedRequest extends Request {
  user?: { user_id: string; email: string; orgId: string; role: string };
}

@Controller('leads')
export class LeadController {
  constructor(private readonly leadService: LeadService) {}

  @Get()
  findAll() {
    return this.leadService.findAll();
  }

  @Get('fetch')
  @UseGuards(JwtAuthGuard)
  async fetchEmails(@Req() req: AuthenticatedRequest) {
    const user = req.user as { user_id: string; email: string; orgId: string };
    const org_id = user.orgId;
    try {
      const result = await this.leadService.fetchAndStoreLeads(org_id);
      return result || { error: 'No data returned from service' };
    } catch (error) {
      console.error('LeadController: Error:', error.message);
      throw error;
    }
  }

  @Get('getByUserId')
  @UseGuards(JwtAuthGuard)
  async getByUserId(@Req() req: AuthenticatedRequest) {
    const user = req.user as { user_id: string; email: string; orgId: string };
    const org_id = user.orgId;
    return this.leadService.fetchLeadsByUserId(org_id);
  }

  @Post('update-status')
  @UseGuards(JwtAuthGuard)
  async updateLeadStatus(
    @Req() req,
    @Body() body: { leadId: string; status: string },
  ) {
    const { leadId, status } = body;
    return this.leadService.updateLeadStatus(leadId, status);
  }

  @Put(':leadId')
  @UseGuards(JwtAuthGuard)
  async updateLead(
    @Param('leadId') leadId: string,
    @Body()
    updateData: {
      name?: string;
      phone?: string | null;
      company?: string | null;
      jobTitle?: string | null;
    },
  ) {
    return this.leadService.updateLead(leadId, updateData);
  }

  @Put(':orgId/lead-config')
  @UseGuards(JwtAuthGuard)
  async updateLeadConfig(
    @Param('orgId') orgId: string,
    @Req() req: AuthenticatedRequest,
    @Body()
    data: {
      filters?: string[];
      folders?: Record<string, string>;
      syncInterval?: string;
    },
  ) {
    const user = req.user as { orgId: string };
    if (user.orgId !== orgId)
      throw new HttpException('Forbidden', HttpStatus.FORBIDDEN);
    return this.leadService.updateLeadConfig(orgId, data);
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  findOne(@Param('id') id: string) {
    return this.leadService.findOne(id);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  remove(@Param('id') id: string) {
    return this.leadService.remove(id);
  }
}
