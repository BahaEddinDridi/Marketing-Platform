import {
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
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

    const userCount = await this.prisma.user.count();
    const role = userCount === 0 ? 'ADMIN' : 'USER';

    const user = await this.prisma.$transaction(async (prisma) => {
      let org = await prisma.organization.findUnique({
        where: { id: 'single-org' },
      });

      if (!org) {
        org = await prisma.organization.create({
          data: { id: 'single-org', name: 'ERP Organization' },
        });

        await prisma.microsoftPreferences.create({
          data: { orgId: 'single-org', signInMethod: true },
        });
      }
      await prisma.microsoftPreferences.upsert({
        where: { orgId: 'single-org' },
        create: { orgId: 'single-org', signInMethod: true },
        update: {},
      });

      return prisma.user.create({
        data: {
          firstName,
          lastName,
          email,
          password: hashedPassword,
          orgId: org.id,
          role,
        },
      });
    });

    const tokens = await this.generateTokens(
      user.user_id,
      user.email,
      user.orgId,
      user.role,
    );
    await this.saveRefreshToken(user.user_id, tokens.refreshToken);

    return { message: 'User registered successfully', user, tokens };
  }

  async signIn(loginDto: LoginDto) {
    const { email, password } = loginDto;
    const user = await this.prisma.user.findUnique({ where: { email } });

    if (!user || !user.password)
      throw new UnauthorizedException('Invalid credentials');

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid)
      throw new UnauthorizedException('Invalid credentials');

    const tokens = await this.generateTokens(
      user.user_id,
      user.email,
      user.orgId,
      user.role,
    );
    await this.saveRefreshToken(user.user_id, tokens.refreshToken);

    return {
      message: 'Login successful',
      user: { user_id: user.user_id, email: user.email, orgId: user.orgId },
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
  }

  async generateTokens(
    userId: string,
    email: string,
    orgId: string,
    role?: string,
  ) {
    console.log('Generating tokens for user:', userId, email, orgId, role);
    const accessToken = this.jwtService.sign(
      { sub: userId, email, orgId, role },
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
    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
    });
    if (!user || !user.refreshToken)
      throw new UnauthorizedException('Unauthorized');

    const isValid = await bcrypt.compare(refreshToken, user.refreshToken);
    if (!isValid) throw new UnauthorizedException('Unauthorized');

    const tokens = await this.generateTokens(
      user.user_id,
      user.email,
      user.orgId,
    );
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

    const tokens = await this.generateTokens(
      user.user_id,
      user.email,
      user.orgId,
    );
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

    try {
      const result = await this.prisma.$transaction(async (prisma) => {
        let user = await prisma.user.findUnique({ where: { email } });
        this.logger.log(
          `User lookup by email (${email}): ${user ? 'Found' : 'Not found'}`,
        );

        let org = await prisma.organization.findUnique({
          where: { id: 'single-org' },
        });

        if (!org) {
          this.logger.log('Creating new organization: single-org');
          org = await prisma.organization.create({
            data: { id: 'single-org', name: 'ERP Organization' },
          });
        } else {
          this.logger.log('Organization single-org already exists');
        }

        this.logger.log(
          'Creating/ensuring MicrosoftPreferences for single-org',
        );
        await prisma.microsoftPreferences.upsert({
          where: { orgId: 'single-org' },
          create: { orgId: 'single-org', signInMethod: true },
          update: { signInMethod: true },
        });

        // Determine role: use existing role or assign based on user count
        let role: 'USER' | 'ADMIN' = user ? user.role : 'USER'; // Default to 'USER' for new users
        if (!user) {
          const userCount = await prisma.user.count();
          role = userCount === 0 ? 'ADMIN' : 'USER';
        }

        // For admins, fetch and update tenantId
        let tenantId: string | null = null;
        if (role === 'ADMIN') {
          try {
            tenantId = await this.getTenantIdFromToken(accessToken);
            this.logger.log(`Extracted tenantId for admin: ${tenantId}`);

            await prisma.organization.update({
              where: { id: org.id },
              data: { tenantId },
            });
            this.logger.log(
              `Updated organization ${org.id} with tenantId: ${tenantId}`,
            );
          } catch (error) {
            this.logger.warn(
              `Failed to extract or update tenantId: ${error.message}`,
            );
            // Continue without setting tenantId
          }
        }

        if (!user) {
          user = await prisma.user.create({
            data: {
              microsoftId,
              email,
              firstName,
              lastName,
              occupation,
              phoneNumber,
              password: null,
              orgId: org.id,
              role,
            },
          });
          this.logger.log(`User created: ${user.user_id}, role: ${user.role}`);
        }

        let platform = await prisma.marketingPlatform.findFirst({
          where: { orgId: org.id, platform_name: 'Microsoft' },
        });
        if (!platform) {
          platform = await prisma.marketingPlatform.create({
            data: {
              platform_name: 'Microsoft',
              orgId: org.id,
              sync_status: 'CONNECTED',
            },
          });
        }

        await prisma.platformCredentials.upsert({
          where: {
            platform_id_user_id_type: {
              platform_id: platform.platform_id,
              user_id: user.user_id,
              type: 'AUTH',
            },
          },
          create: {
            platform_id: platform.platform_id,
            user_id: user.user_id,
            type: 'AUTH',
            access_token: accessToken,
            refresh_token: refreshToken || null,
            scopes,
            expires_at: new Date(Date.now() + expiresIn * 1000),
          },
          update: {
            access_token: accessToken,
            refresh_token: refreshToken || null,
            expires_at: new Date(Date.now() + expiresIn * 1000),
          },
        });

        return { user };
      });

      const user = result.user;
      const tokens = await this.generateTokens(
        user.user_id,
        user.email,
        user.orgId,
        user.role,
      );
      await this.saveRefreshToken(user.user_id, tokens.refreshToken);

      this.logger.log(`Microsoft user validated: ${user.email}`);
      return { user, tokens };
    } catch (error) {
      this.logger.error(
        `Microsoft validation failed: ${error.message}`,
        error.stack,
      );
      throw new Error(`Failed to validate Microsoft user: ${error.message}`);
    }
  }

  async connectMicrosoft(userId: string) {
    this.logger.log(`Connecting Microsoft for user ${userId}`);
    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
    });
    if (!user) throw new UnauthorizedException('User not found');

    if (user.role !== 'ADMIN')
      throw new ForbiddenException('Only admins can connect Microsoft');

    await this.prisma.$transaction(async (prisma) => {
      const org = await prisma.organization.findUnique({
        where: { id: 'single-org' },
      });
      if (!org) throw new Error('Single organization not found');

      await prisma.microsoftPreferences.upsert({
        where: { orgId: 'single-org' },
        create: { orgId: 'single-org', signInMethod: true },
        update: { signInMethod: true },
      });
    });

    this.logger.log(`Microsoft Sign-in Method enabled for user ${userId}`);
    return { url: 'http://localhost:5000/auth/microsoft' };
  }

  async disconnectMicrosoft(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
    });
    if (!user) throw new UnauthorizedException('User not found');

    if (user.role !== 'ADMIN')
      throw new ForbiddenException('Only admins can disconnect Microsoft');

    const platform = await this.prisma.marketingPlatform.findFirst({
      where: { orgId: 'single-org', platform_name: 'Microsoft' },
    });
    if (!platform) throw new Error('Microsoft platform not found');

    await this.prisma.platformCredentials.deleteMany({
      where: { platform_id: platform.platform_id, type: 'AUTH' },
    });

    await this.prisma.microsoftPreferences.update({
      where: { orgId: 'single-org' },
      data: { signInMethod: false },
    });

    this.logger.warn(
      'Microsoft Sign-in Method disconnected. Admins should send password reset emails to affected users.',
    );
    return {
      message:
        'Microsoft Sign-in Method disconnected. Send password reset emails to users for email/password login.',
    };
  }

  async refreshMicrosoftToken(
    orgId: string,
    scopes: string[],
  ): Promise<string> {
    const platform = await this.prisma.marketingPlatform.findFirst({
      where: { orgId, platform_name: 'Microsoft' },
    });
    if (!platform) throw new Error('No Microsoft platform found');

    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { tenantId: true },
    });
    if (!org || !org.tenantId) {
      this.logger.error(`No tenantId found for org ${orgId}`);
      throw new Error('No tenantId found for organization');
    }

    const creds = await this.prisma.platformCredentials.findFirst({
      where: {
        platform_id: platform.platform_id,
        scopes: { hasEvery: scopes },
      },
    });
    if (!creds || !creds.refresh_token)
      throw new Error('No valid refresh token');

    try {
      const clientId = this.configService.get('MICROSOFT_CLIENT_ID');
      const clientSecret = this.configService.get('MICROSOFT_CLIENT_SECRET');

      if (!clientId || !clientSecret) {
        throw new Error('Missing Microsoft OAuth configuration');
      }

      const response = await axios.post<MicrosoftTokenResponse>(
        `https://login.microsoftonline.com/${org.tenantId}/oauth2/v2.0/token`,
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
          updated_at: new Date(),
        },
      });

      return access_token;
    } catch (error) {
      this.logger.error(
        `Failed to refresh token: ${error.message}`,
        error.response?.data,
      );
      throw new Error('No valid credentials');
    }
  }

  async getMicrosoftToken(
    orgId: string,
    scopes: string[],
  ): Promise<string> {
    const platform = await this.prisma.marketingPlatform.findFirst({
      where: { orgId, platform_name: 'Microsoft' },
    });
    if (!platform) throw new Error('No Microsoft platform found');

    const creds = await this.prisma.platformCredentials.findFirst({
      where: {
        platform_id: platform.platform_id,
        scopes: { hasEvery: scopes },
      },
    });
    if (!creds || !creds.refresh_token) throw new Error('No valid credentials');

    const isExpired =
      creds.expires_at && new Date(creds.expires_at) < new Date();
    if (!isExpired && creds.access_token) return creds.access_token;

    return this.refreshMicrosoftToken(orgId, scopes);
  }

  async updateMicrosoftCredentials(
    microsoftId: string,
    email: string,
    accessToken: string,
    refreshToken: string | null,
    expiresIn: number,
    scopes: string[],
    type: 'AUTH' | 'LEADS',
  ) {
    this.logger.log(
      `Updating Microsoft credentials for org (email: ${email}, type: ${type})`,
    );
  
    // Find the organization
    const org = await this.prisma.organization.findUnique({
      where: { id: 'single-org' },
    });
    if (!org) {
      this.logger.error(`Organization not found for id: single-org`);
      throw new Error('Organization not found');
    }
  
    // Fetch tenantId by decoding the access token
    let tenantId: string | null = null;
    try {
      tenantId = await this.getTenantIdFromToken(accessToken);
      if (tenantId && tenantId !== 'tenant-id-placeholder') {
        await this.prisma.organization.update({
          where: { id: org.id },
          data: { tenantId },
        });
        this.logger.log(`Updated tenantId for org ${org.id}: ${tenantId}`);
      } else {
        this.logger.warn(`Invalid or placeholder tenantId for email: ${email}: ${tenantId}`);
      }
    } catch (error) {
      this.logger.error(`Failed to fetch tenantId for email: ${email}: ${error.message}`);
    }
  
    // Upsert MarketingPlatform for Microsoft
    const platform = await this.prisma.marketingPlatform.upsert({
      where: {
        orgId_platform_name: {
          orgId: org.id,
          platform_name: 'Microsoft',
        },
      },
      create: {
        orgId: org.id,
        platform_name: 'Microsoft',
        sync_status: 'CONNECTED',
      },
      update: {
        sync_status: 'CONNECTED',
      },
    });
  
    const existingCredentials = await this.prisma.platformCredentials.findFirst({
      where: {
        platform_id: platform.platform_id,
        user_id: null, // Org-wide credentials
        type,
      },
    });
  
    if (existingCredentials) {
      // Update existing credentials
      await this.prisma.platformCredentials.update({
        where: { credential_id: existingCredentials.credential_id },
        data: {
          access_token: accessToken,
          refresh_token: refreshToken,
          scopes,
          expires_at: new Date(Date.now() + expiresIn * 1000),
        },
      });
    } else {
      // Create new credentials
      await this.prisma.platformCredentials.create({
        data: {
          platform_id: platform.platform_id,
          user_id: null, // Org-wide credentials
          type,
          access_token: accessToken,
          refresh_token: refreshToken,
          scopes,
          expires_at: new Date(Date.now() + expiresIn * 1000),
        },
      });
    }
    this.logger.log(
      `Microsoft credentials updated for org ${org.id}, email: ${email}, type: ${type}`,
    );
    return { message: 'Microsoft credentials updated', tenantId };
  }

  async getTenantIdFromToken(token: string): Promise<string> {
    const decoded = this.jwtService.decode(token) as any;
    return decoded?.tid || 'tenant-id-placeholder'; // Replace with actual logic
  }
}
