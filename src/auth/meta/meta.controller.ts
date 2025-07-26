import {
  Controller,
  Post,
  Get,
  Body,
  Req,
  Query,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { MetaService } from './meta.service';
import { JwtAuthGuard } from 'src/guards/jwt-auth.guard';

interface AuthenticatedRequest extends Request {
  user?: { user_id: string; email: string; orgId: string; role?: string };
}

@Controller('auth/meta')
export class MetaController {
  constructor(private readonly metaService: MetaService) {}

  @UseGuards(JwtAuthGuard)
  @Post('credentials')
  async saveCredentials(
    @Req() req: AuthenticatedRequest,
    @Body()
    body: {
      clientId: string;
      clientSecret: string;
      businessManagerId: string;
    },
  ) {
    const user = req.user!;
    return this.metaService.saveMetaCredentials(user.user_id, body);
  }

  @UseGuards(JwtAuthGuard)
  @Get('credentials')
  async getCredentials() {
    return this.metaService.getMetaCredentials();
  }

  @UseGuards(JwtAuthGuard)
  @Get('auth-url')
  async getAuthUrl() {
    return this.metaService.generateAuthUrl();
  }

  @Get('callback')
  async handleAuthCallback(@Query('code') code: string) {
    return this.metaService.handleAuthCode(code);
  }

  @UseGuards(JwtAuthGuard)
  @Post('connect-bm')
  async connectBusinessManager(@Req() req: AuthenticatedRequest) {
    const user = req.user!;
    try {
      return await this.metaService.connectAndFetchBusinessManagerInfo(user.user_id);
    } catch (error) {
      if (
        error instanceof BadRequestException &&
        error.message.includes('Authentication required')
      ) {
        return {
          message: 'Authentication required: Please authenticate with Meta.',
          authUrl: (await this.metaService.generateAuthUrl()).url,
        };
      }
      throw error;
    }
  }

  @UseGuards(JwtAuthGuard)
  @Post('test-connection')
  async testConnection(@Req() req: AuthenticatedRequest) {
    const user = req.user!;
    try {
      return await this.metaService.testConnection(user.user_id);
    } catch (error) {
      if (
        error instanceof BadRequestException &&
        error.message.includes('Authentication required')
      ) {
        return {
          message: 'Authentication required: Please authenticate with Meta.',
          authUrl: (await this.metaService.generateAuthUrl()).url,
        };
      }
      throw error;
    }
  }

  @UseGuards(JwtAuthGuard)
  @Post('disconnect-bm')
  async disconnectBusinessManager(@Req() req: AuthenticatedRequest) {
    const user = req.user!;
    return this.metaService.disconnectBusinessManager(user.user_id);
  }

  @UseGuards(JwtAuthGuard)
  @Get('bm-info')
  async getBusinessManagerInfo(@Req() req: AuthenticatedRequest) {
    const user = req.user!;
    return this.metaService.getBusinessManagerInfo(user.user_id);
  }
}
