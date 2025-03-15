import { Controller, Post, Body, UseGuards, Req, HttpException, HttpStatus, Get } from '@nestjs/common';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenGuard } from 'src/guards/refresh-token.guard';
import { JwtAuthGuard } from 'src/guards/jwt-auth.guard';
import { Request } from 'express';
import { AuthGuard } from '@nestjs/passport';


@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  async register(@Body() registerDto: RegisterDto) {
    return this.authService.register(registerDto);
  }

  @Post('sign-in')
  async signIn(@Body() loginDto: LoginDto) {
    return this.authService.signIn(loginDto);
  }

  @Post('refresh')
  @UseGuards(RefreshTokenGuard)
  async refresh(@Req() request: Request) {
    const refreshToken = request.cookies['refresh_token'];
    const userId = (request as any).user.user_id;
    return this.authService.refreshToken(userId, refreshToken);
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  async logout(@Req() request: Request) {
    const userId = (request as any).user.user_id;
    return this.authService.logout(userId);
  }

  ///////////////////////// GOOGLE ////////////////////////

  @Get('google')
  @UseGuards(AuthGuard('google'))
  async googleAuth() {
    return { message: 'Redirecting to Google...' };
  }

  // Handle Google OAuth callback
  @Get('google/redirect')
  @UseGuards(AuthGuard('google'))
  async googleAuthRedirect(@Req() req) {
    return this.authService.generateTokens(req.user.user_id, req.user.email);
  }
}
