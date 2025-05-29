import {
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
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

interface MicrosoftTestTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
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
      user: { user_id: user.user_id, email: user.email, orgId: user.orgId, role: user.role },
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
      user.role,
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


  async saveMicrosoftEntraCredentials(
    userId: string,
    creds: { clientId: string; clientSecret: string; tenantId: string },
  ) {
    const user = await this.prisma.user.findUnique({ where: { user_id: userId } });
    if (!user) throw new UnauthorizedException('User not found');
    if (user.role !== 'ADMIN') throw new ForbiddenException('Only admins can save Entra credentials');
  
    await this.prisma.marketingPlatform.upsert({
      where: {
        orgId_platform_name: {
          orgId: 'single-org',
          platform_name: 'Microsoft'
        }
      },
      create: {
        platform_name: 'Microsoft',
        orgId: 'single-org',
        sync_status: 'CONNECTED'
      },
      update: {}
    });
    
    await this.prisma.organization.update({
      where: { id: 'single-org' },
      data: {
        microsoftEntraCreds: {
          clientId: creds.clientId,
          clientSecret: creds.clientSecret,
          tenantId: creds.tenantId,
        },
      },
    });
  
    this.logger.log(`Saved Microsoft Entra credentials for org single-org`);
    return { message: 'Entra credentials saved successfully' };
  }
  
  async testMicrosoftEntraConnection(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { user_id: userId } });
    if (!user) throw new UnauthorizedException('User not found');
    if (user.role !== 'ADMIN') throw new ForbiddenException('Only admins can test Entra credentials');
  
    const org = await this.prisma.organization.findUnique({
      where: { id: 'single-org' },
      select: { microsoftEntraCreds: true },
    });
    if (!org || !org.microsoftEntraCreds) {
      throw new Error('No Entra credentials found');
    }
  
    const { clientId, clientSecret, tenantId } = org.microsoftEntraCreds as any;
    this.logger.log(`Testing Entra connection for org single-org with clientId: ${clientId}, tenantId: ${tenantId}`);
  
    try {
      const response = await axios.post<MicrosoftTestTokenResponse>(
        `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
        new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'client_credentials',
          scope: 'https://graph.microsoft.com/.default',
        }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      );
  
      const { access_token } = response.data;
      this.logger.log(`Entra connection test successful for org single-org: Token acquired`);
  
      return { message: 'Connection successful: Valid credentials confirmed' };
    } catch (error: any) {
      if (error.response) {
        const { status, data } = error.response;
        this.logger.error(`Entra connection test failed: HTTP ${status} - ${JSON.stringify(data)}`);
        if (status === 401) {
          throw new Error('Invalid credentials: Check Client ID, Client Secret, or Tenant ID.');
        }
      }
      this.logger.error(`Entra connection test failed: ${error.message}`);
      throw new Error('Failed to test Entra connection');
    }
  }

  async getEntraCredentials() {
    const org = await this.prisma.organization.findUnique({
      where: { id: 'single-org' },
      select: { microsoftEntraCreds: true },
    });

    if (!org || !org.microsoftEntraCreds) {
      throw new InternalServerErrorException('Microsoft Entra credentials not found in database');
    }

    const { clientId, clientSecret, tenantId } = org.microsoftEntraCreds as {
      clientId: string;
      clientSecret: string;
      tenantId: string;
    };

    if (!clientId || !clientSecret || !tenantId) {
      throw new InternalServerErrorException('Invalid Microsoft Entra credentials in database');
    }

    return { clientId, clientSecret, tenantId };
  }


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


        let tenantId: string | null = null;
        if (role === 'ADMIN') {
  try {
    const entraCreds = await this.getEntraCredentials();
    tenantId = entraCreds.tenantId;
    this.logger.log(`Using tenantId from Entra credentials: ${tenantId}`);
  } catch (error) {
    this.logger.warn(`Failed to get Entra credentials: ${error.message}, falling back to .env`);
    tenantId = this.configService.get('TENANT_ID') || null;
    if (!tenantId) {
      this.logger.warn(`No tenantId found in .env`);
    }
  }

  if (tenantId) {
    await prisma.organization.update({
      where: { id: org.id },
      data: { tenantId },
    });
    this.logger.log(`Updated organization ${org.id} with tenantId: ${tenantId}`);
  } else {
    this.logger.warn(`No tenantId available to update organization ${org.id}`);
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
console.log(`Microsoft user validated: ${user.email}, tokens generated`);
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

}
