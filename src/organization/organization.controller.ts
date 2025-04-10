import {
  Controller,
  Get,
  Post,
  Put,
  Param,
  Body,
  Req,
  Res,
  UseGuards,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { OrganizationService } from './organization.service';
import { JwtAuthGuard } from 'src/guards/jwt-auth.guard';
import { Response, Request } from 'express';

interface AuthenticatedRequest extends Request {
  user?: { user_id: string; email: string; orgId: string; role: string };
}

@Controller('org')
export class OrganizationController {
  constructor(private readonly organizationService: OrganizationService) {}

  @Get(':orgId/members')
  @UseGuards(JwtAuthGuard)
  async getOrganizationMembers(
    @Param('orgId') orgId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    const user = req.user as { orgId: string };
    if (user.orgId !== orgId)
      throw new HttpException('Forbidden', HttpStatus.FORBIDDEN);
    return this.organizationService.getOrganizationMembers(orgId);
  }

  @Get(':orgId')
  @UseGuards(JwtAuthGuard)
  async getOrg(
    @Param('orgId') orgId: string,
    @Req() req: AuthenticatedRequest,
  ) {
    const user = req.user as { orgId: string };
    if (user.orgId !== orgId)
      throw new HttpException('Forbidden', HttpStatus.FORBIDDEN);
    return this.organizationService.getOrganization(orgId);
  }

  @Post('setup')
  @UseGuards(JwtAuthGuard)
  async completeOrgSetup(
    @Req() req: AuthenticatedRequest,
    @Body() setupDto: { name: string; sharedMailbox: string },
    @Res() res: Response,
  ) {
    const user = req.user as { user_id: string; email: string; orgId: string };

    await this.organizationService.updateOrganization(user.orgId, setupDto);
    res.json({ message: 'Organization setup complete' });
  }

  @Post('invite')
  @UseGuards(JwtAuthGuard)
  async inviteUser(
    @Req() req: AuthenticatedRequest,
    @Body() { email }: { email: string },
  ) {
    const user = req.user as { orgId: string; role: string };
    if (user.role !== 'ADMIN')
      throw new HttpException('Unauthorized', HttpStatus.FORBIDDEN);
    return this.organizationService.inviteUser(user.orgId, email, user.role);
  }

  
}
