import {
  Controller,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Req,
  UseGuards,
  HttpException,
  HttpStatus,
  Get,
} from '@nestjs/common';
import { AutoReplyService } from './auto-reply.service';
import { JwtAuthGuard } from 'src/guards/jwt-auth.guard';

interface AuthenticatedRequest extends Request {
  user?: { user_id: string; email: string; orgId: string; role: string };
}

@UseGuards(JwtAuthGuard)
@Controller('auto-reply')
export class AutoReplyController {
  constructor(private readonly autoReplyService: AutoReplyService) {}

  @Get('config')
  async getAll(@Req() req: AuthenticatedRequest) {
    const user = req.user as { user_id: string; email: string; orgId: string; role: string };
    try {
      return await this.autoReplyService.getConfigs(user.orgId);
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to fetch auto-reply configs',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('config/trigger/:triggerType')
  async getByTriggerType(
    @Req() req: AuthenticatedRequest,
    @Param('triggerType') triggerType: string,
  ) {
    const user = req.user as { user_id: string; email: string; orgId: string; role: string };
    try {
      return await this.autoReplyService.getByTriggerType(user.orgId, triggerType);
    } catch (error) {
      throw new HttpException(
        error.message || `Failed to fetch auto-reply configs for trigger ${triggerType}`,
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
  
  @Post('config')
  async create(
    @Req() req: AuthenticatedRequest,
    @Body() body: { templateId: string; mailbox: string; schedule: string },
  ) {
    const user = req.user as { user_id: string; email: string; orgId: string; role: string };
    try {
      return await this.autoReplyService.createConfig(
        user.orgId,
        user.user_id,
        body.templateId,
        body.mailbox,
        body.schedule,
      );
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to create auto-reply config',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Patch('config/:id')
  async update(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: { templateId?: string; mailbox?: string; schedule?: string; isActive?: boolean },
  ) {
    const user = req.user as { user_id: string; email: string; orgId: string; role: string };
    try {
      return await this.autoReplyService.updateConfig(
        user.orgId,
        user.user_id,
        id,
        body.templateId,
        body.mailbox,
        body.schedule,
        body.isActive,
      );
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to update auto-reply config',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Delete('config/:id')
  async remove(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ) {
    const user = req.user as { user_id: string; email: string; orgId: string; role: string };
    try {
      return await this.autoReplyService.deleteConfig(
        user.orgId,
        user.user_id,
        id,
      );
    } catch (error) {
      throw new HttpException(
        error.message || 'Failed to delete auto-reply config',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}