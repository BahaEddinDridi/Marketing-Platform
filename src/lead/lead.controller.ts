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
  Query,
} from '@nestjs/common';
import { LeadService } from './lead.service';
import { JwtAuthGuard } from 'src/guards/jwt-auth.guard';
import { LeadStatus } from '@prisma/client';

interface AuthenticatedRequest extends Request {
  user?: { user_id: string; email: string; orgId: string; role: string };
}
interface Folder {
  id: string;
  name: string;
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
    return this.leadService.fetchAndStoreLeads(user.orgId);
  }

  @Get('getByUserId')
  @UseGuards(JwtAuthGuard)
  async getByUserId(
    @Req() req: AuthenticatedRequest,
    @Query('page') page: string,
    @Query('pageSize') pageSize: string,
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('source') source?: string,
  ) {
    const user = req.user as { user_id: string; email: string; orgId: string };
    console.log('Received query params:', {
      page,
      pageSize,
      search,
      status,
      source,
    });
    let validatedStatuses: LeadStatus[] | undefined;
    if (status) {
      const statusArray = status.split(',').map((s) => s.trim());
      const validStatuses = Object.values(LeadStatus);
      validatedStatuses = statusArray.filter((s) =>
        validStatuses.includes(s as LeadStatus),
      ) as LeadStatus[];
      if (validatedStatuses.length === 0) {
        throw new HttpException(
          'Invalid status values',
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    let validatedSources: string[] | undefined;
    if (source) {
      validatedSources = source.split(',').map((s) => s.trim());
      const validSources = ['email', 'web', 'manual'];
      validatedSources = validatedSources.filter((s) =>
        validSources.includes(s),
      );
      if (validatedSources.length === 0) {
        throw new HttpException(
          'Invalid source values',
          HttpStatus.BAD_REQUEST,
        );
      }
    }
    return this.leadService.fetchLeadsByUserId(
      user.orgId,
      user.user_id,
      parseInt(page) || 1,
      parseInt(pageSize) || 10,
      { search, status: validatedStatuses, source: validatedSources },
    );
  }

  @Get('getAllByUserId')
  @UseGuards(JwtAuthGuard)
  async getAllByUserId(@Req() req: AuthenticatedRequest) {
    const user = req.user as { user_id: string; email: string; orgId: string };
    return this.leadService.fetchAllLeadsByUserId(user.orgId, user.user_id);
  }

  @Get('conversation/:leadId')
  @UseGuards(JwtAuthGuard)
  async getLeadConversation(@Param('leadId') leadId: string) {
    return this.leadService.fetchLeadConversation(leadId);
  }

  @Post('update-status')
  @UseGuards(JwtAuthGuard)
  async updateLeadStatus(@Body() body: { leadId: string; status: string }) {
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
      folders?: Record<string, { id: string; name: string }[]>;
      syncInterval?: string;
      excludedEmails?: string[];
      specialEmails?: string[];
      sharedMailbox?: string;
    },
  ) {
    console.log(`Received lead config update for org ${orgId}: ${JSON.stringify(data, null, 2)}`);
    const user = req.user as { orgId: string };
    if (user.orgId !== orgId)
      throw new HttpException('Forbidden', HttpStatus.FORBIDDEN);
    return this.leadService.updateLeadConfig(orgId, data);
  }
  @Get(':orgId/:mailboxEmail/folders')
  @UseGuards(JwtAuthGuard)
  async listMailboxFolders(
    @Param('orgId') orgId: string,
    @Param('mailboxEmail') mailboxEmail: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<Folder[]> {
    const user = req.user as { orgId: string };

    return this.leadService.listMailboxFolders(orgId, mailboxEmail);
  }

  @Post('setup')
  @UseGuards(JwtAuthGuard)
  async setupLeadSync(
    @Req() req: AuthenticatedRequest,
    @Body()
    data: {
      sharedMailbox: string;
      filters?: string[];
      syncInterval?: string;
      excludedEmails?: string[];
      specialEmails?: string[];
    },
  ) {
    const user = req.user as { user_id: string; orgId: string };
    return this.leadService.setupLeadSync(user.orgId, user.user_id, data);
  }

  @Post('connect')
  @UseGuards(JwtAuthGuard)
  async connectLeadSync(@Req() req: AuthenticatedRequest) {
    const user = req.user as { user_id: string; orgId: string };
    return this.leadService.connectLeadSync(user.user_id);
  }

  @Post('disconnect')
  @UseGuards(JwtAuthGuard)
  async disconnectLeadSync(@Req() req: AuthenticatedRequest) {
    const user = req.user as { user_id: string; orgId: string };
    return this.leadService.disconnectLeadSync(user.user_id);
  }

  @Post('connect-member')
  @UseGuards(JwtAuthGuard)
  async connectMemberLeadSync(@Req() req: AuthenticatedRequest) {
    const user = req.user as { user_id: string; orgId: string };
    return this.leadService.connectMemberLeadSync(user.user_id);
  }

  @Post('disconnect-member')
  @UseGuards(JwtAuthGuard)
  async disconnectMemberLeadSync(@Req() req: AuthenticatedRequest) {
    const user = req.user as { user_id: string; orgId: string };
    return this.leadService.disconnectMemberLeadSync(user.user_id);
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
