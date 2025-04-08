import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as bcrypt from 'bcryptjs';
import { JwtService } from '@nestjs/jwt';
import { RegisterDto } from './dto/register.dto';
import { ConfigService } from '@nestjs/config';
import { LoginDto } from './dto/login.dto';
import axios from 'axios';
import { OrganizationService } from 'src/organization/organization.service';

interface MicrosoftTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private configService: ConfigService,
    private readonly organizationService: OrganizationService,
  ) {}

  async register(registerDto: RegisterDto) {
    const { firstName, lastName, email, password } = registerDto;
    const hashedPassword = await bcrypt.hash(password, 10);

    let org = await this.prisma.organization.findFirst({
      where: { name: `${email.split('@')[1]} Org` },
    });
    if (!org) {
      org = await this.prisma.organization.create({
        data: { name: `${email.split('@')[1]} Org` },
      });
    }

    const user = await this.prisma.user.create({
      data: {
        firstName,
        lastName,
        email,
        password: hashedPassword,
        orgId: org.id,
        role: 'USER',
      },
    });

    const tokens = await this.generateTokens(user.user_id, user.email, org.id);
    await this.saveRefreshToken(user.user_id, tokens.refreshToken);

    return { message: 'User registered successfully', user, tokens };
  }

  async signIn(loginDto: LoginDto) {
    const { email, password } = loginDto;
    const user = await this.prisma.user.findUnique({ where: { email } });

    if (!user) throw new UnauthorizedException('Invalid credentials');

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) throw new UnauthorizedException('Invalid credentials');

    const tokens = await this.generateTokens(user.user_id, user.email, user.orgId);
    await this.saveRefreshToken(user.user_id, tokens.refreshToken);

    return {
      message: 'Login successful',
      user: { user_id: user.user_id, email: user.email, orgId: user.orgId },
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
  }

  async generateTokens(userId: string, email: string, orgId: string) {
    const accessToken = this.jwtService.sign(
      { sub: userId, email, orgId },
      {
        secret: process.env.JWT_SECRET,
        expiresIn: '15m',
      },
    );

    const refreshToken = this.jwtService.sign(
      { sub: userId, orgId },
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
    const user = await this.prisma.user.findUnique({ where: { user_id: userId } });
    if (!user || !user.refreshToken) throw new UnauthorizedException('Unauthorized');

    const isValid = await bcrypt.compare(refreshToken, user.refreshToken);
    if (!isValid) throw new UnauthorizedException('Unauthorized');

    const tokens = await this.generateTokens(user.user_id, user.email, user.orgId);
    await this.saveRefreshToken(user.user_id, tokens.refreshToken);

    return tokens;
  }

  async logout(userId: string) {
    await this.prisma.user.update({
      where: { user_id: userId },
      data: { refreshToken: null },
    });
  }

  /////////////////////////// GOOGLE ///////////////////////////////////

  async validateGoogleUser(googleId: string, email: string, firstName: string) {
    let user = await this.prisma.user.findUnique({ where: { email } });
    let org;

    if (!user) {
      org = await this.prisma.organization.findFirst({
        where: { name: `${email.split('@')[1]} Org` },
      });
      if (!org) {
        org = await this.prisma.organization.create({
          data: { name: `${email.split('@')[1]} Org` },
        });
      }

      user = await this.prisma.user.create({
        data: {
          googleId,
          email,
          firstName,
          lastName: '',
          password: '',
          orgId: org.id,
          role: 'USER',
        },
      });
    }

    const tokens = await this.generateTokens(user.user_id, user.email, user.orgId);
    await this.saveRefreshToken(user.user_id, tokens.refreshToken);
    return tokens;
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
    this.logger.log(`Validating Microsoft user: ${email}`);

    let user = await this.prisma.user.findUnique({ where: { email } });
    this.logger.log(`User lookup by email (${email}): ${user ? 'Found' : 'Not found'}`);

    let org;
    let isNewOrg = false;

    const tenantId = await this.getTenantIdFromToken(accessToken);
    this.logger.log(`Extracted tenantId from token: ${tenantId}`);

    if (!user) {
      this.logger.log(`No user found, checking organization by tenantId: ${tenantId}`);
      org = await this.organizationService.getOrganizationByTenantId(tenantId);
      if (!org) {
        this.logger.log(`No organization found for tenantId: ${tenantId}, creating new org`);
        org = await this.organizationService.createOrganization(tenantId, email);
        isNewOrg = true;
        this.logger.log(`New organization created: ${org.id}, isNewOrg set to true`);
      } else {
        this.logger.log(`Existing organization found: ${org.id}, isNewOrg remains false`);
      }

      user = await this.prisma.user.create({
        data: {
          microsoftId,
          email,
          firstName,
          lastName,
          occupation,
          phoneNumber,
          password: '',
          orgId: org.id,
          role: isNewOrg ? 'ADMIN' : 'USER',
        },
      });
      this.logger.log(`User created: ${user.user_id}, role: ${user.role}`);
    } else {
      this.logger.log(`Existing user found: ${user.user_id}, fetching organization`);
      org = await this.prisma.organization.findUnique({ where: { id: user.orgId } });
      if (!org) {
        this.logger.error(`User ${user.user_id} has no organization`);
        throw new Error('User has no organization');
      }
      this.logger.log(`Organization for existing user: ${org.id}, isNewOrg remains false`);
    }

    let platform = await this.prisma.marketingPlatform.findFirst({
      where: { orgId: org.id, platform_name: 'Microsoft' },
    });
    if (!platform) {
      this.logger.log(`No Microsoft platform found for org ${org.id}, creating one`);
      platform = await this.prisma.marketingPlatform.create({
        data: { platform_name: 'Microsoft', orgId: org.id },
      });
    } else {
      this.logger.log(`Microsoft platform exists for org ${org.id}: ${platform.platform_id}`);
    }

    let creds = await this.prisma.platformCredentials.findFirst({
      where: { platform_id: platform.platform_id, scopes: { equals: scopes } },
    });
    if (!creds) {
      this.logger.log(`No credentials found for platform ${platform.platform_id}, creating`);
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
      this.logger.log(`Credentials found for platform ${platform.platform_id}, updating`);
      creds = await this.prisma.platformCredentials.update({
        where: { credential_id: creds.credential_id },
        data: {
          access_token: accessToken,
          refresh_token: refreshToken || null,
          expires_at: new Date(Date.now() + expiresIn * 1000),
        },
      });
    }

    const tokens = await this.generateTokens(user.user_id, user.email, org.id);
    await this.saveRefreshToken(user.user_id, tokens.refreshToken);

    this.logger.log(`Validation complete for ${email}, isNewOrg: ${isNewOrg}`);
    return { user, tokens, isNewOrg };
  }

  async refreshMicrosoftToken(orgId: string, scopes: string[]): Promise<string> {
    const platform = await this.prisma.marketingPlatform.findFirst({
      where: { orgId, platform_name: 'Microsoft' },
      include: { credentials: true },
    });
    if (!platform) throw new Error('Microsoft platform not found for organization');

    const creds = platform.credentials.find((cred) =>
      scopes.every((scope) => cred.scopes.includes(scope)),
    );
    if (!creds || !creds.refresh_token) throw new Error('No valid refresh token found');

    const isExpired = creds.expires_at && new Date() > creds.expires_at;
    if (!isExpired && creds.access_token) return creds.access_token;

    const clientId = this.configService.get<string>('MICROSOFT_CLIENT_ID');
    const clientSecret = this.configService.get<string>('MICROSOFT_CLIENT_SECRET');
    const org = await this.prisma.organization.findUnique({ where: { id: orgId } });

    if (!clientId || !clientSecret) {
      throw new Error('Microsoft client ID or secret not configured');
    }
    if (!org?.tenantId) {
      throw new Error('Organization tenant ID not found');
    }
    
    const response = await axios.post<MicrosoftTokenResponse>(
      `https://login.microsoftonline.com/${org?.tenantId}/oauth2/v2.0/token`,
      new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
        refresh_token: creds.refresh_token,
        scope: scopes.join(' '),
      }).toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
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

  async getMicrosoftToken(orgId: string, scopes: string[]): Promise<string> {
    const platform = await this.prisma.marketingPlatform.findFirst({
      where: { orgId, platform_name: 'Microsoft' },
      include: { credentials: true },
    });
    if (!platform) throw new Error('No Microsoft platform found');

    const creds = platform.credentials.find((cred) =>
      scopes.every((scope) => cred.scopes.includes(scope)),
    );
    if (!creds || !creds.refresh_token) throw new Error('No valid credentials');

    const isExpired = creds.expires_at && new Date(creds.expires_at) < new Date();
    if (!isExpired && creds.access_token) return creds.access_token;

    return this.refreshMicrosoftToken(orgId, scopes);
  }

  async updateMicrosoftCredentials(
    microsoftId: string,
    email: string,
    refreshToken: string,
    accessToken: string,
    expiresIn: number,
    scopes: string[],
  ) {
    const user = await this.prisma.user.findUnique({ where: { microsoftId } });
    if (!user) throw new Error('User not found');

    const org = await this.prisma.organization.findUnique({ where: { id: user.orgId } });
    if (!org) throw new Error('Organization not found');

    let platform = await this.prisma.marketingPlatform.findFirst({
      where: { orgId: org.id, platform_name: 'Microsoft' },
    });
    if (!platform) {
      platform = await this.prisma.marketingPlatform.create({
        data: { platform_name: 'Microsoft', orgId: org.id },
      });
    }

    let creds = await this.prisma.platformCredentials.findFirst({
      where: { platform_id: platform.platform_id, scopes: { equals: scopes } },
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

    return creds;
  }

  private async getTenantIdFromToken(token: string): Promise<string> {
    const decoded = this.jwtService.decode(token) as any;
    return decoded?.tid || 'tenant-id-placeholder'; // Replace with actual logic
  }
}