import { Controller, Post, Get, Body, Req, UseGuards, Query, BadRequestException } from '@nestjs/common';
import { GoogleService } from './google.service';
import { JwtAuthGuard } from 'src/guards/jwt-auth.guard';

interface AuthenticatedRequest extends Request {
  user?: { user_id: string; email: string; orgId: string; role?: string };
}

@Controller('auth/google')
export class GoogleController {
  constructor(private googleService: GoogleService) {}

  @UseGuards(JwtAuthGuard)
  @Post('credentials')
  async saveCredentials(
    @Req() req: AuthenticatedRequest,
    @Body() body: {
      clientId: string;
      clientSecret: string;
      developerToken: string;
      customerAccountId: string;
    },
  ) {
    const user = req.user as { user_id: string; email: string; orgId: string };
    return this.googleService.saveGoogleCredentials(user.user_id, body);
  }

  @UseGuards(JwtAuthGuard)
  @Get('credentials')
  async getCredentials() {
    return this.googleService.getGoogleCredentials();
  }

  @UseGuards(JwtAuthGuard)
  @Get('auth-url')
  async getAuthUrl() {
    return this.googleService.generateAuthUrl();
  }

  @Get('redirect')
  async handleAuthCallback(@Query('code') code: string) {
    return this.googleService.handleAuthCode(code);
  }

  @UseGuards(JwtAuthGuard)
  @Post('connect-mcc')
  async connectMCC(@Req() req: AuthenticatedRequest) {
    const user = req.user as { user_id: string; email: string; orgId: string };
    try {
      return await this.googleService.connectAndFetchMCCInfo(user.user_id);
    } catch (error) {
      if (error instanceof BadRequestException && error.message.includes('Authentication required')) {
        return {
          message: 'Authentication required: Please authenticate with Google.',
          authUrl: (await this.googleService.generateAuthUrl()).url,
        };
      }
      throw error; // Re-throw other errors
    }
  }

  @UseGuards(JwtAuthGuard)
  @Post('test-connection')
  async testConnection(@Req() req: AuthenticatedRequest) {
    const user = req.user as { user_id: string; email: string; orgId: string };
    try {
      return await this.googleService.testConnection(user.user_id);
    } catch (error) {
      if (error instanceof BadRequestException && error.message.includes('Authentication required')) {
        return {
          message: 'Authentication required: Please authenticate with Google.',
          authUrl: (await this.googleService.generateAuthUrl()).url,
        };
      }
      throw error;
    }
  }

  @UseGuards(JwtAuthGuard)
  @Post('disconnect-mcc')
  async disconnectMCC(@Req() req: AuthenticatedRequest) {
    const user = req.user as { user_id: string; email: string; orgId: string };
    return await this.googleService.disconnectMCC(user.user_id);
  }

  @UseGuards(JwtAuthGuard)
  @Get('mcc-info')
  async getMCCInfo(@Req() req: AuthenticatedRequest) {
    const user = req.user as { user_id: string; email: string; orgId: string };
    return await this.googleService.getMCCInfo(user.user_id);
  }
}