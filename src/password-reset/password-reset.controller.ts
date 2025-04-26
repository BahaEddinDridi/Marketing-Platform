import {
  Controller,
  Post,
  Body,
  BadRequestException,
  UseGuards,
  HttpException,
  HttpStatus,
  Req,
} from '@nestjs/common';
import { PasswordResetService } from './password-reset.service';
import { JwtAuthGuard } from 'src/guards/jwt-auth.guard';
import { PrismaService } from 'src/prisma/prisma.service';

interface AuthenticatedRequest extends Request {
  user?: { user_id: string; email: string };
}

@Controller('auth')
export class PasswordResetController {
  constructor(
    private readonly passwordResetService: PasswordResetService,
      private prisma: PrismaService,
  ) {}

  @Post('forgot-password')
  async forgotPassword(@Body('email') email: string) {
    if (!email) {
      throw new BadRequestException('Email is required');
    }
    return this.passwordResetService.sendResetLink(email);
  }

  @Post('admin/reset-password')
  @UseGuards(JwtAuthGuard)
  async sendAdminResetPassword(
    @Req() req: AuthenticatedRequest,
    @Body() body: { email: string },
  ) {
    const user = req.user as { user_id: string; email: string; orgId: string };
    const userRecord = await this.prisma.user.findUnique({
      where: { user_id: user.user_id },
    });
    if (!userRecord || userRecord.role !== 'ADMIN') {
      throw new HttpException(
        'Only admins can send reset emails',
        HttpStatus.FORBIDDEN,
      );
    }

    if (!body.email) {
      throw new HttpException('Email is required', HttpStatus.BAD_REQUEST);
    }

    return this.passwordResetService.sendResetLink(body.email);
  }

  @Post('reset-password')
  async resetPassword(
    @Body('token') token: string,
    @Body('password') password: string,
  ) {
    if (!token || !password) {
      throw new BadRequestException('Token and password are required');
    }
    return this.passwordResetService.resetPassword(token, password);
  }
}
