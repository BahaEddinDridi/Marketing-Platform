import {
  Body,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { LinkedInService } from './linkedIn.service';
import { JwtAuthGuard } from 'src/guards/jwt-auth.guard';
import { AuthGuard } from '@nestjs/passport';
import { PrismaService } from 'src/prisma/prisma.service';
import { Request } from 'express';
import { Session as ExpressSession } from 'express-session';
import { Session } from '@nestjs/common';

// Define possible types for req.user in linkedInPageCallback
interface LinkedInPageUser {
  redirect?: string;
  orgProfiles?: any[];
  // Add other possible page properties
  id?: string;
  name?: string;
  vanityName?: string;
}

interface AuthenticatedRequest extends Request {
  user?: { user_id: string; email: string; orgId: string; role?: string } | LinkedInPageUser;
  session: ExpressSession;
}

@Controller('auth/linkedin')
export class LinkedInController {
  constructor(
    private linkedInService: LinkedInService,
    private prisma: PrismaService,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Post('credentials')
  async saveCredentials(
    @Req() req: AuthenticatedRequest,
    @Body() body: { clientId: string; clientSecret: string },
  ) {
    const user = req.user as { user_id: string; email: string; orgId: string };
    return this.linkedInService.saveLinkedInCredentials(user.user_id, body);
  }

  @UseGuards(JwtAuthGuard)
  @Post('test-connection')
  async testConnection(@Req() req: AuthenticatedRequest) {
    const user = req.user as { user_id: string; email: string; orgId: string };
    return this.linkedInService.testLinkedInConnection(user.user_id, req.session);
  }

  @Get('callback')
  async handleCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Req() req: Request & { session: ExpressSession },
  ) {
    return this.linkedInService.handleLinkedInCallback(code, state, req.session);
  }

  @UseGuards(JwtAuthGuard)
  @Get('credentials')
  async getCredentials() {
    return this.linkedInService.getLinkedInCredentials();
  }

  @UseGuards(JwtAuthGuard)
  @Post('connect')
  async connectLinkedIn(@Req() req: AuthenticatedRequest) {
    const user = req.user as { user_id: string; email: string; orgId: string };
    return this.linkedInService.connectLinkedIn(user.user_id, req.session);
  }

  @UseGuards(JwtAuthGuard)
  @Post('disconnect')
  async disconnectLinkedIn(@Req() req: AuthenticatedRequest) {
    const user = req.user as { user_id: string; email: string; orgId: string };
    return this.linkedInService.disconnectLinkedIn(user.user_id);
  }

  @UseGuards(JwtAuthGuard)
  @Get('profile')
  async getLinkedInProfile(@Req() req: AuthenticatedRequest) {
    const user = req.user as { user_id: string; email: string; orgId: string };
    return this.linkedInService.getStoredLinkedInProfile(user.user_id);
  }

  @UseGuards(JwtAuthGuard)
  @Post('preferences')
  async updateLinkedInPreferences(
    @Req() req: AuthenticatedRequest,
    @Body() body: { signInMethod: boolean },
  ) {
    const user = req.user as { user_id: string; email: string; orgId: string };
    return this.linkedInService.updateLinkedInPreferences(user.user_id, body.signInMethod);
  }

  @UseGuards(JwtAuthGuard)
  @Get('linkedIn-preferences')
  async getPreferences() {
    const preferences = await this.prisma.linkedInPreferences.findUnique({
      where: { orgId: 'single-org' },
    });
    return {
      signInMethod: preferences?.signInMethod ?? true,
    };
  }

  @UseGuards(JwtAuthGuard)
  @Post('page/connect')
  async connectLinkedInPage(@Req() req: AuthenticatedRequest) {
    const user = req.user as { user_id: string; email: string; orgId: string; role: string };
    if (user.role !== 'ADMIN') {
      throw new HttpException('Only admins can connect LinkedIn pages', HttpStatus.FORBIDDEN);
    }
    return this.linkedInService.connectLinkedInPage(user.user_id, req.session);
  }



  @UseGuards(JwtAuthGuard)
  @Post('page/disconnect')
  async disconnectLinkedInPage(
    @Req() req: AuthenticatedRequest,
    @Body() body: { pageId: string },
  ) {
    const user = req.user as { user_id: string; email: string; orgId: string; role: string };
    if (user.role !== 'ADMIN') {
      throw new HttpException('Only admins can disconnect LinkedIn pages', HttpStatus.FORBIDDEN);
    }
    return this.linkedInService.disconnectLinkedInPage(user.user_id, body.pageId, req.session);
  }

  @UseGuards(JwtAuthGuard)
  @Get('pages')
  async getLinkedInPages(@Req() req: AuthenticatedRequest) {
    const user = req.user as { user_id: string; email: string; orgId: string; role: string };
    if (user.role !== 'ADMIN') {
      throw new HttpException('Only admins can view LinkedIn pages', HttpStatus.FORBIDDEN);
    }
    return this.linkedInService.getStoredLinkedInPages();
  }

  @UseGuards(JwtAuthGuard)
  @Post('page/select')
  async selectPage(
    @Body() body: { pageId: string },
    @Req() req: AuthenticatedRequest,
    @Session() session: ExpressSession,
  ) {
    const user = req.user as { user_id: string; email: string; orgId: string; role: string };
    if (!session) {
      throw new HttpException('Session not found', HttpStatus.BAD_REQUEST);
    }
    return this.linkedInService.selectLinkedInPage(user.user_id, body.pageId, session);
  }

  @UseGuards(JwtAuthGuard)
  @Get('page/profiles')
  async getPageProfiles(@Session() session: ExpressSession) {
    if (!session) {
      throw new HttpException('Session not found', HttpStatus.BAD_REQUEST);
    }
    if (!session.orgProfiles) {
      throw new HttpException('No organization profiles found', HttpStatus.NOT_FOUND);
    }
    console.log('Session in getPageProfiles at 19:07 CET:', session.orgProfiles);
    return { orgProfiles: session.orgProfiles };
  }
}