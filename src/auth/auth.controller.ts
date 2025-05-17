import {
  Controller,
  Post,
  Body,
  UseGuards,
  Req,
  HttpException,
  HttpStatus,
  Get,
  Res,
  Redirect,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenGuard } from 'src/guards/refresh-token.guard';
import { JwtAuthGuard } from 'src/guards/jwt-auth.guard';
import { AuthGuard } from '@nestjs/passport';
import { Response, Request } from 'express';
import { PrismaService } from 'src/prisma/prisma.service';
import { LinkedInService } from './linkedIn/linkedIn.service';
import { Session as ExpressSession } from 'express-session';

interface LinkedInPageUser {
  redirect?: string;
  orgProfiles?: any[];
  // Add other possible page properties
  id?: string;
  name?: string;
  vanityName?: string;
}

interface AuthenticatedRequest extends Request {
  user?:
    | { user_id: string; email: string; orgId: string; role?: string }
    | LinkedInPageUser;
  session: ExpressSession;
}

@Controller('auth')
export class AuthController {
  constructor(
    private prisma: PrismaService,
    private readonly authService: AuthService,
    private readonly linkedInService: LinkedInService,
  ) {}

  @Post('register')
  async register(@Body() registerDto: RegisterDto) {
    const { user, tokens } = await this.authService.register(registerDto);
    return {
      message: 'User registered successfully',
      user: { user_id: user.user_id, email: user.email, orgId: user.orgId },
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
  }

  @Post('sign-in')
  async signIn(@Body() loginDto: LoginDto, @Res() res: Response) {
    const result = await this.authService.signIn(loginDto);

    const refreshTokenMaxAge = loginDto.keepLoggedIn
      ? 7 * 24 * 60 * 60 * 1000
      : 24 * 60 * 60 * 1000;

    res.cookie('accessToken', result.accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 15 * 60 * 1000,
    });

    res.cookie('refreshToken', result.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: refreshTokenMaxAge,
    });

    return res.json({
      message: result.message,
      user: result.user,
    });
  }

  @Post('refresh')
  @UseGuards(RefreshTokenGuard)
  async refresh(@Req() req: AuthenticatedRequest, @Res() res: Response) {
    const refreshToken = req.cookies['refreshToken'];
    const user = req.user as { user_id: string; email: string; orgId: string };
    const userId = user.user_id;

    const tokens = await this.authService.refreshToken(userId, refreshToken);

    res.cookie('accessToken', tokens.accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 15 * 60 * 1000,
    });

    res.cookie('refreshToken', tokens.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    return res.json({ message: 'Token refreshed' });
  }

  @Post('logout')
  @UseGuards(JwtAuthGuard)
  async logout(@Req() req: AuthenticatedRequest, @Res() res: Response) {
    const user = req.user as { user_id: string; email: string; orgId: string };
    const user_id = user.user_id;

    await this.authService.logout(user_id);
    res.clearCookie('accessToken');
    res.clearCookie('refreshToken');
    return res.json({ message: 'Logged out successfully' });
  }

  @Get('check')
  @UseGuards(JwtAuthGuard)
  async checkAuth(@Req() req: AuthenticatedRequest) {
    const user = req.user as { user_id: string; email: string; orgId: string };
    return { user };
  }

  ///////////////////////// GOOGLE ////////////////////////

  @Get('google')
  @UseGuards(AuthGuard('google'))
  async googleAuth() {
    return { message: 'Redirecting to Google...' };
  }

  @Get('google/redirect')
  @UseGuards(AuthGuard('google'))
  async googleAuthRedirect(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ) {
    const user = req.user as { user_id: string; email: string; orgId: string };
    const tokens = await this.authService.generateTokens(
      user.user_id,
      user.email,
      user.orgId,
    );

    res.cookie('accessToken', tokens.accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 15 * 60 * 1000,
    });

    res.cookie('refreshToken', tokens.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.redirect('http://localhost:3000/signin?callback=google');
  }

  ///////////////////////// MICROSOFT ////////////////////////

  @UseGuards(JwtAuthGuard)
  @Post('entra-credentials')
  async saveEntraCredentials(
    @Req() req: AuthenticatedRequest,
    @Body() body: { clientId: string; clientSecret: string; tenantId: string },
  ) {
    const user = req.user as { user_id: string; email: string; orgId: string };
    const userId = user.user_id;
    return this.authService.saveMicrosoftEntraCredentials(userId, body);
  }

  @UseGuards(JwtAuthGuard)
  @Post('test-entra-connection')
  async testEntraConnection(@Req() req: AuthenticatedRequest) {
    const user = req.user as { user_id: string; email: string; orgId: string };
    const userId = user.user_id;

    return this.authService.testMicrosoftEntraConnection(userId);
  }

  @Get('microsoft')
  @UseGuards(AuthGuard('microsoft'))
  async microsoftLogin() {}

  @Get('microsoft/callback')
  @UseGuards(AuthGuard('microsoft'))
  async microsoftLoginCallback(@Req() req, @Res() res: Response) {
    console.log('Microsoft callback triggered, req.user:', req.user);
    if (!req.user || !req.user.user || !req.user.tokens) {
      console.error('Invalid req.user data:', req.user);
      return res.redirect('http://localhost:3000/signin?error=microsoft');
    }
    const { user, tokens } = req.user;
    console.log('Setting cookies for user:', user, 'tokens:', tokens);
    res.cookie('accessToken', tokens.accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 15 * 60 * 1000,
    });

    res.cookie('refreshToken', tokens.refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    const redirectUrl = 'http://localhost:3000/signin?callback=microsoft';
    console.log('Redirecting to:', redirectUrl);
    res.redirect(redirectUrl);
  }

  @Get('microsoft/leads')
  @UseGuards(AuthGuard('microsoft-leads'))
  async microsoftLeadsLogin() {}

  @Get('microsoft/leads/callback')
  @UseGuards(AuthGuard('microsoft-leads'))
  async microsoftLeadsCallback(@Req() req, @Res() res: Response) {
    res.redirect('http://localhost:3000/leads?auth=success');
  }

  @Post('microsoft/connect')
  @UseGuards(JwtAuthGuard)
  @Redirect()
  async connectMicrosoft(@Req() req: AuthenticatedRequest) {
    const user = req.user as {
      user_id: string;
      email: string;
      orgId: string;
      role: string;
    };
    return this.authService.connectMicrosoft(user.user_id);
  }

  @Post('microsoft/disconnect')
  @UseGuards(JwtAuthGuard)
  async disconnectMicrosoft(@Req() req: AuthenticatedRequest) {
    const user = req.user as { user_id: string; email: string; orgId: string };
    const userRecord = await this.prisma.user.findUnique({
      where: { user_id: user.user_id },
    });
    if (!userRecord || userRecord.role !== 'ADMIN') {
      throw new HttpException(
        'Only admins can disconnect Microsoft',
        HttpStatus.FORBIDDEN,
      );
    }

    return this.authService.disconnectMicrosoft(user.user_id);
  }

  @Get('microsoft-preferences')
  async getPreferences() {
    const preferences = await this.prisma.microsoftPreferences.findUnique({
      where: { orgId: 'single-org' },
    });
    return {
      signInMethod: preferences?.signInMethod ?? true,
      leadSyncEnabled: preferences?.leadSyncEnabled ?? false,
    };
  }

  ///////////////////////// Linkedin ////////////////////////

  @Get('linkedin')
  @UseGuards(AuthGuard('linkedin'))
  async linkedinLogin() {}

  @Get('linkedin/callback')
  @UseGuards(AuthGuard('linkedin'))
  async linkedinCallback(@Req() req) {
    const user = req.user;
    return { message: 'LinkedIn profile connected', user };
  }

  @Get('linkedin-page')
  @UseGuards(AuthGuard('linkedin-page'))
  async linkedinPageLogin() {}

  @Get('linkedin-page/callback')
  @UseGuards(AuthGuard('linkedin-page'))
  async linkedinPageCallback(
    @Req() req: Request & { session: ExpressSession },
    @Res() res: Response,
  ) {
    const page = req.user as LinkedInPageUser;
    console.log(
      'linkedinPageCallback: req.user=',
      page,
      'session=',
      req.session,
    );

    if (!page || page.redirect !== '/select-page') {
      console.error('Invalid req.user data:', req.user);
      return res.redirect(
        'http://localhost:3000/settings/integrations?error=auth_failed',
      );
    }

    const redirectUrl =
      'http://localhost:3000/select-linkedin-page?auth=success';
    console.log('Redirecting to:', redirectUrl);
    res.redirect(redirectUrl);
  }
}
