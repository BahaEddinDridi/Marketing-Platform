import { Controller, Post, Body, BadRequestException } from '@nestjs/common';
import { PasswordResetService } from './password-reset.service';

@Controller('auth')
export class PasswordResetController {
  constructor(private readonly passwordResetService: PasswordResetService) {}

  @Post('forgot-password')
  async forgotPassword(@Body('email') email: string) {
    if (!email) {
      throw new BadRequestException('Email is required');
    }
    return this.passwordResetService.sendResetLink(email);
  }

  @Post('reset-password')
  async resetPassword(@Body('token') token: string, @Body('password') password: string) {
    if (!token || !password) {
      throw new BadRequestException('Token and password are required');
    }
    return this.passwordResetService.resetPassword(token, password);
  }
}