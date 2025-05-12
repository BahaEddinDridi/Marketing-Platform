import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  Request,
  HttpStatus,
  HttpException,
  Req,
} from '@nestjs/common';
import { EmailTemplateService } from './email-template.service';
import { CreateEmailTemplateDto } from './dto/create-email-template.dto';
import { UpdateEmailTemplateDto } from './dto/update-email-template.dto';
import { JwtAuthGuard } from 'src/guards/jwt-auth.guard';

interface AuthenticatedRequest extends Request {
  user?: { user_id: string; email: string; orgId: string; role: string };
}


@UseGuards(JwtAuthGuard)
@Controller('email-templates')
export class EmailTemplateController {
  constructor(private readonly emailTemplateService: EmailTemplateService) {}

  @Post()
  async create(
    @Req() req: AuthenticatedRequest,
    @Body() createEmailTemplateDto: CreateEmailTemplateDto
  ) {
    const user = req.user as { user_id: string; email: string; orgId: string };
    try {
      return await this.emailTemplateService.createTemplate(
        user.orgId,
        createEmailTemplateDto
      );
    } catch (error) {
      throw new HttpException(
        error.message,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Get()
  async findAll(@Req() req: AuthenticatedRequest) {
    const user = req.user as { user_id: string; email: string; orgId: string };
    return this.emailTemplateService.getTemplates(user.orgId);
  }

  @Get('active')
  async findActive(@Req() req: AuthenticatedRequest) {
    const user = req.user as { user_id: string; email: string; orgId: string };

    const template = await this.emailTemplateService.getActiveTemplate(user.orgId);
    if (!template) {
      throw new HttpException(
        'No active template found',
        HttpStatus.NOT_FOUND
      );
    }
    return template;
  }

  @Get(':id')
  async findOne(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const user = req.user as { user_id: string; email: string; orgId: string };

    const template = await this.emailTemplateService.getTemplateById(
      user.orgId,
      id
    );
    if (!template) {
      throw new HttpException(
        'Template not found',
        HttpStatus.NOT_FOUND
      );
    }
    return template;
  }

  @Patch(':id')
  async update(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() updateEmailTemplateDto: UpdateEmailTemplateDto
  ) {
    try {
      return await this.emailTemplateService.updateTemplate(
        id,
        updateEmailTemplateDto
      );
    } catch (error) {
      throw new HttpException(
        error.message,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }

  @Delete(':id')
  async remove(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    try {
      return await this.emailTemplateService.deleteTemplate(id);
    } catch (error) {
      throw new HttpException(
        error.message,
        HttpStatus.INTERNAL_SERVER_ERROR
      );
    }
  }
}