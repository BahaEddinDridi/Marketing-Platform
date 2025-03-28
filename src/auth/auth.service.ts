import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as bcrypt from 'bcryptjs';
import { JwtService } from '@nestjs/jwt';
import { RegisterDto } from './dto/register.dto';
import { ConfigService } from '@nestjs/config';
import { LoginDto } from './dto/login.dto';
import axios from 'axios';

interface MicrosoftTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

  async register(registerDto: RegisterDto) {
    const { firstName, lastName, email, password } = registerDto;
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await this.prisma.user.create({
      data: {
        firstName,
        lastName,
        email,
        password: hashedPassword,
        role: 'USER',
      },
    });
    return { message: 'User registered successfully', user };
  }

  async signIn(loginDto: LoginDto) {
    const { email, password } = loginDto;
    const user = await this.prisma.user.findUnique({ where: { email } });

    if (!user) throw new UnauthorizedException('Invalid credentials');

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid)
      throw new UnauthorizedException('Invalid credentials');

    const tokens = await this.generateTokens(user.user_id, user.email);
    await this.saveRefreshToken(user.user_id, tokens.refreshToken);

    return {
      message: 'Login successful',
      user: {
        user_id: user.user_id,
        email: user.email,
      },
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
  }

  async generateTokens(userId: string, email: string) {
    const accessToken = this.jwtService.sign(
      { sub: userId, email },
      {
        secret: process.env.JWT_SECRET,
        expiresIn: '15m',
      },
    );

    const refreshToken = this.jwtService.sign(
      { sub: userId },
      {
        secret: process.env.JWT_REFRESH_SECRET,
        expiresIn: '7d',
      },
    );

    return { accessToken, refreshToken };
  }

  async saveRefreshToken(userId: string, refreshToken: string) {
    const hashedToken = await bcrypt.hash(refreshToken, 10);
    await this.prisma.user.update({
      where: { user_id: userId },
      data: { refreshToken: hashedToken },
    });
  }

  async refreshToken(userId: string, refreshToken: string) {
    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
    });

    if (!user || !user.refreshToken)
      throw new UnauthorizedException('Unauthorized');

    const isValid = await bcrypt.compare(refreshToken, user.refreshToken);
    if (!isValid) throw new UnauthorizedException('Unauthorized');

    const tokens = await this.generateTokens(user.user_id, user.email);
    await this.saveRefreshToken(user.user_id, tokens.refreshToken);

    return tokens;
  }

  async logout(userId: string) {
    try {
      await this.prisma.user.update({
        where: { user_id: userId },
        data: { refreshToken: null },
      });
    } catch (error) {
      throw new Error('Failed to logout user');
    }
  }

  /////////////////////////// GOOGLE ///////////////////////////////////

  async validateGoogleUser(googleId: string, email: string, firstName: string) {
    let user = await this.prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      user = await this.prisma.user.create({
        data: {
          googleId,
          email,
          firstName,
          lastName: '',
          password: '',
          role: 'USER',
        },
      });
    }

    return this.generateTokens(user.user_id, user.email);
  }

  /////////////////////////// MICROSOFT ///////////////////////////////////

  async validateMicrosoftUser(
    microsoftId: string,
    email: string,
    firstName: string,
    lastName: string,
    occupation: string,
    phoneNumber: string,
    refreshToken: string,
    accessToken: string,
    expiresIn: number,
    scopes: string[],
  ) {
    let user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      user = await this.prisma.user.create({
        data: {
          microsoftId,
          email,
          firstName,
          lastName,
          occupation,
          phoneNumber,
          password: '',
          role: 'USER',
        },
      });
    }

    let platform = await this.prisma.marketingPlatform.findFirst({
      where: { user_id: user.user_id, platform_name: 'Microsoft' },
    });
    if (!platform) {
      platform = await this.prisma.marketingPlatform.create({
        data: { platform_name: 'Microsoft', user_id: user.user_id },
      });
    }

    let creds = await this.prisma.platformCredentials.findFirst({
      where: {
        platform_id: platform.platform_id,
        scopes: { equals: scopes },
      },
    });

    if (!creds) {
      creds = await this.prisma.platformCredentials.create({
        data: {
          platform_id: platform.platform_id,
          access_token: accessToken,
          refresh_token: refreshToken || null,
          scopes,
          expires_at: new Date(Date.now() + expiresIn * 1000),
        },
      });
    } else {
      creds = await this.prisma.platformCredentials.update({
        where: { credential_id: creds.credential_id },
        data: {
          access_token: accessToken,
          refresh_token: refreshToken || null,
          expires_at: new Date(Date.now() + expiresIn * 1000),
        },
      });
    }

    const tokens = await this.generateTokens(user.user_id, user.email);
    await this.saveRefreshToken(user.user_id, tokens.refreshToken);
    return { user, tokens };
  }

  async refreshMicrosoftToken(
    userId: string,
    scopes: string[],
  ): Promise<string> {
    const platform = await this.prisma.marketingPlatform.findFirst({
      where: { user_id: userId, platform_name: 'Microsoft' },
      include: { credentials: true },
    });

    if (!platform) {
      throw new Error('Microsoft platform not found for user');
    }

    const creds = platform.credentials.find((cred) =>
      scopes.every((scope) => cred.scopes.includes(scope)),
    );

    if (!creds || !creds.refresh_token) {
      throw new Error('No valid refresh token found for the specified scopes');
    }

    if (!creds.expires_at || new Date() > creds.expires_at) {
      const clientId = this.configService.get<string>('MICROSOFT_CLIENT_ID');
      const clientSecret = this.configService.get<string>(
        'MICROSOFT_CLIENT_SECRET',
      );

      if (!clientId || !clientSecret) {
        throw new Error('Microsoft client ID or secret not configured');
      }

      const response = await axios.post<MicrosoftTokenResponse>(
        'https://login.microsoftonline.com/common/oauth2/v2.0/token',
        new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'refresh_token',
          refresh_token: creds.refresh_token,
          scope: scopes.join(' '),
        }).toString(),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        },
      );

      const { access_token, refresh_token, expires_in } = response.data;

      await this.prisma.platformCredentials.update({
        where: { credential_id: creds.credential_id },
        data: {
          access_token,
          refresh_token: refresh_token || creds.refresh_token,
          expires_at: new Date(Date.now() + expires_in * 1000),
        },
      });

      return access_token;
    }

    if (!creds.access_token) {
      throw new Error('Access token is missing despite not being expired');
    }

    return creds.access_token;
  }

  async getMicrosoftToken(userId: string, scopes: string[]): Promise<string> {
    const platform = await this.prisma.marketingPlatform.findFirst({
      where: { user_id: userId, platform_name: 'Microsoft' },
      include: { credentials: true },
    });

    if (!platform) {
      throw new Error('Microsoft platform not found for user');
    }

    const creds = platform.credentials.find((cred) =>
      scopes.every((scope) => cred.scopes.includes(scope)),
    );

    if (!creds) {
      throw new Error('No credentials found for the specified scopes');
    }

    return this.refreshMicrosoftToken(userId, scopes);
  }
}
