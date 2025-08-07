import {
  Injectable,
  UnauthorizedException,
  ForbiddenException,
  InternalServerErrorException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import axios from 'axios';
import * as qs from 'querystring';
import { Prisma } from '@prisma/client';
import { decrypt, encrypt } from 'src/middlewares/crypto.helper';

@Injectable()
export class MetaService {
  private readonly logger = new Logger(MetaService.name);

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
  ) {}

  async saveMetaCredentials(
    userId: string,
    creds: {
      clientId: string;
      clientSecret: string;
      businessManagerId: string;
    },
  ) {
    // Verify user existence
    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
    });
    if (!user) {
      this.logger.error(`User with ID ${userId} not found`);
      throw new UnauthorizedException('User not found');
    }

    // Check user role
    if (user.role !== 'ADMIN') {
      this.logger.warn(
        `User ${userId} attempted to save Meta credentials without ADMIN role`,
      );
      throw new ForbiddenException('Only admins can save Meta credentials');
    }

    // Update organization with Meta credentials
    await this.prisma.organization.update({
      where: { id: 'single-org' },
      data: {
        metaCreds: {
          clientId: encrypt(creds.clientId),
          clientSecret: encrypt(creds.clientSecret),
          businessManagerId: encrypt(creds.businessManagerId),
        },
      },
    });

    this.logger.log(
      'Meta credentials saved successfully for organization single-org',
    );
    return { message: 'Meta credentials saved successfully' };
  }

  async getMetaCredentials() {
    // Fetch organization with Meta credentials
    const org = await this.prisma.organization.findUnique({
      where: { id: 'single-org' },
      select: { metaCreds: true },
    });

    if (!org || !org.metaCreds) {
    this.logger.log('No Meta credentials found in database for organization single-org');
    return { clientId: '', clientSecret: '', businessManagerId: '' };
  }

    // Extract and validate credentials
    const { clientId, clientSecret, businessManagerId } = org.metaCreds as {
      clientId: string;
      clientSecret: string;
      businessManagerId: string;
    };

    if (!clientId || !clientSecret || !businessManagerId) {
    this.logger.log('Invalid or incomplete Meta credentials in database');
    return { clientId: '', clientSecret: '', businessManagerId: '' };
  }

    return { clientId: decrypt(clientId), clientSecret: decrypt(clientSecret), businessManagerId: decrypt(businessManagerId) };
  }
  
  async generateAuthUrl(): Promise<{ url: string }> {
    const { clientId } = await this.getMetaCredentials();
    const redirectUri = this.configService.get('META_CALLBACK_URL');
    const scope = 'ads_management,business_management';

    const query = qs.stringify({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope,
    });

    return {
      url: `https://www.facebook.com/v23.0/dialog/oauth?${query}`,
    };
  }

  async handleAuthCode(code: string) {
    const { clientId, clientSecret } = await this.getMetaCredentials();
    const redirectUri = this.configService.get('META_CALLBACK_URL');
    const scope = 'ads_management,business_management';
    try {
      const response = await axios.post<any>(
        'https://graph.facebook.com/v23.0/oauth/access_token',
        qs.stringify({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
        }),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        },
      );

      const { access_token, expires_in } = response.data;
      const expiresAt = new Date(Date.now() + expires_in * 1000);

      // Get the organization
      const org = await this.prisma.organization.findUnique({
        where: { id: 'single-org' },
      });
      if (!org) {
        this.logger.error(`Organization not found for id: single-org`);
        throw new InternalServerErrorException('Organization not found');
      }

      // Find or create the "Meta" marketing platform
      let platform = await this.prisma.marketingPlatform.findFirst({
        where: {
          orgId: org.id,
          platform_name: 'Meta',
        },
      });

      if (!platform) {
        platform = await this.prisma.marketingPlatform.create({
          data: {
            orgId: org.id,
            platform_name: 'Meta',
          },
        });
      }

      // Upsert the platformCredentials
      const existingCredentials =
        await this.prisma.platformCredentials.findFirst({
          where: {
            platform_id: platform.platform_id,
            user_id: null,
            type: 'AUTH',
          },
        });

      if (existingCredentials) {
        await this.prisma.platformCredentials.update({
          where: { credential_id: existingCredentials.credential_id },
          data: {
            access_token,
            expires_at: expiresAt,
          },
        });
      } else {
        await this.prisma.platformCredentials.create({
          data: {
            platform_id: platform.platform_id,
            user_id: null,
            type: 'AUTH',
            access_token,
            expires_at: expiresAt,
            scopes: scope.split(','),
          },
        });
      }

      return { access_token, expires_in };
    } catch (error) {
      this.logger.error(
        'Meta OAuth token exchange failed',
        error.response?.data || error,
      );
      throw new InternalServerErrorException(
        'Meta OAuth token exchange failed',
      );
    }
  }

  async testConnection(userId: string) {
    // Verify user existence and role
    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
    });
    if (!user) {
      this.logger.error(`User with ID ${userId} not found`);
      throw new UnauthorizedException('User not found');
    }
    if (user.role !== 'ADMIN') {
      this.logger.warn(
        `User ${userId} attempted to test connection without ADMIN role`,
      );
      throw new ForbiddenException('Only admins can test Meta connection');
    }

    // Get organization
    const org = await this.prisma.organization.findUnique({
      where: { id: 'single-org' },
    });
    if (!org) {
      this.logger.error('Organization not found for id: single-org');
      throw new InternalServerErrorException('Organization not found');
    }

    // Check for existing platform credentials
    let platform = await this.prisma.marketingPlatform.findFirst({
      where: { orgId: org.id, platform_name: 'Meta' },
    });
    if (!platform) {
      platform = await this.prisma.marketingPlatform.create({
        data: {
          orgId: org.id,
          platform_name: 'Meta',
        },
      });
    }

    const platformCreds = await this.prisma.platformCredentials.findFirst({
      where: {
        platform_id: platform.platform_id,
        type: 'AUTH',
        user_id: null,
      },
    });
    if (!platformCreds || !platformCreds.access_token) {
      this.logger.warn('No valid Meta platform credentials found');
      throw new BadRequestException(
        'Authentication required: No valid access token found. Please authenticate with Meta.',
      );
    }

    // Get stored Meta credentials
    const creds = await this.getMetaCredentials();

    // Get valid access token
    const accessToken = await this.getValidAccessToken(
      creds.clientId,
      creds.clientSecret,
      platformCreds.access_token,
      platform.platform_id,
    );

    try {
      // Test connection by fetching Business Manager info
      const response = await axios.get<any>(
        `https://graph.facebook.com/v23.0/${creds.businessManagerId}`,
        {
          params: {
            access_token: accessToken,
            fields: 'id,name,currency,timezone_name',
          },
        },
      );

      const businessManager = response.data;

      if (!businessManager.id) {
        this.logger.error('No Business Manager data returned from Meta API');
        throw new BadRequestException('No Business Manager data returned');
      }

      this.logger.log('Meta API test connection successful');
      return {
        message: 'Meta API connection successful',
        businessManager: {
          id: businessManager.id,
          name: businessManager.name,
          currency: businessManager.currency,
          timeZone: businessManager.timezone_name,
        },
      };
    } catch (error) {
      this.logger.error(
        'Meta API test connection failed',
        error.response?.data || error,
      );
      throw new InternalServerErrorException(
        `Meta API connection failed: ${error.message || error}`,
      );
    }
  }

  async connectAndFetchBusinessManagerInfo(userId: string) {
    // Verify user existence and role
    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
    });
    if (!user) {
      this.logger.error(`User with ID ${userId} not found`);
      throw new UnauthorizedException('User not found');
    }
    if (user.role !== 'ADMIN') {
      this.logger.warn(
        `User ${userId} attempted to connect Business Manager without ADMIN role`,
      );
      throw new ForbiddenException(
        'Only admins can connect Business Manager accounts',
      );
    }

    // Get organization
    const org = await this.prisma.organization.findUnique({
      where: { id: 'single-org' },
    });
    if (!org) {
      this.logger.error('Organization not found for id: single-org');
      throw new InternalServerErrorException('Organization not found');
    }

    // Check for existing platform credentials
    let platform = await this.prisma.marketingPlatform.findFirst({
      where: { orgId: org.id, platform_name: 'Meta' },
    });
    if (!platform) {
      platform = await this.prisma.marketingPlatform.create({
        data: {
          orgId: org.id,
          platform_name: 'Meta',
        },
      });
    }

    const platformCreds = await this.prisma.platformCredentials.findFirst({
      where: {
        platform_id: platform.platform_id,
        type: 'AUTH',
        user_id: null,
      },
    });
    if (!platformCreds || !platformCreds.access_token) {
      this.logger.warn('No valid Meta platform credentials found');
      throw new BadRequestException(
        'Authentication required: No valid access token found. Please authenticate with Meta.',
      );
    }

    // Get stored Meta credentials
    const creds = await this.getMetaCredentials();

    // Get valid access token
    const accessToken = await this.getValidAccessToken(
      creds.clientId,
      creds.clientSecret,
      platformCreds.access_token,
      platform.platform_id,
    );

    try {
      // Fetch Business Manager info
      const bmResponse = await axios.get<any>(
        `https://graph.facebook.com/v23.0/${creds.businessManagerId}`,
        {
          params: {
            access_token: accessToken,
            fields: 'id,name,timezone_id',
          },
        },
      );

      const bmData = bmResponse.data;

      // Fetch ad accounts
      const adAccountsResponse = await axios.get<any>(
        `https://graph.facebook.com/v23.0/${creds.businessManagerId}/owned_ad_accounts`,
        {
          params: {
            access_token: accessToken,
            fields: 'id,name,timezone_id',
          },
        },
      );

      const adAccounts = adAccountsResponse.data.data.map((account: any) => ({
        id: account.id,
        name: account.name,
        timeZone: account.timezone_id.toString(),
      }));

      // Save or update Business Manager info and ad accounts in MetaAccount table
      const businessManagerId = bmData.id;
      await this.prisma.metaAccount.upsert({
        where: {
          orgId_businessManagerId: {
            orgId: org.id,
            businessManagerId,
          },
        },
        create: {
          orgId: org.id,
          platformId: platform.platform_id,
          businessManagerId,
          descriptiveName: bmData.name || null,
          timeZone: bmData.timezone_id.toString() || null,
          adAccounts: adAccounts.length > 0 ? adAccounts : Prisma.JsonNull,
        },
        update: {
          descriptiveName: bmData.name || null,
          timeZone: bmData.timezone_id.toString() || null,
          adAccounts: adAccounts.length > 0 ? adAccounts : Prisma.JsonNull,
          updatedAt: new Date(),
        },
      });

      this.logger.log(
        `Business Manager info and ${adAccounts.length} ad accounts saved successfully for Business Manager ID: ${businessManagerId}`,
      );
      return {
        message:
          'Business Manager info and ad accounts fetched and saved successfully',
        businessManagerInfo: {
          businessManagerId,
          descriptiveName: bmData.name,
          timeZone: bmData.timezone_id.toString(),
          adAccounts,
        },
      };
    } catch (error) {
      this.logger.error(
        'Failed to fetch or save Business Manager info or ad accounts',
        error.response?.data || error,
      );
      throw new InternalServerErrorException(
        `Failed to fetch or save Business Manager info or ad accounts: ${error.message || error}`,
      );
    }
  }

  async disconnectBusinessManager(userId: string) {
    // Verify user existence and role
    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
    });
    if (!user) {
      this.logger.error(`User with ID ${userId} not found`);
      throw new UnauthorizedException('User not found');
    }
    if (user.role !== 'ADMIN') {
      this.logger.warn(
        `User ${userId} attempted to disconnect Business Manager without ADMIN role`,
      );
      throw new ForbiddenException(
        'Only admins can disconnect Business Manager accounts',
      );
    }

    // Get organization
    const org = await this.prisma.organization.findUnique({
      where: { id: 'single-org' },
    });
    if (!org) {
      this.logger.error('Organization not found for id: single-org');
      throw new InternalServerErrorException('Organization not found');
    }

    // Find the Meta marketing platform
    const platform = await this.prisma.marketingPlatform.findFirst({
      where: { orgId: org.id, platform_name: 'Meta' },
    });
    if (!platform) {
      this.logger.error('Meta marketing platform not found');
      throw new InternalServerErrorException(
        'Meta marketing platform not found',
      );
    }

    // Get stored Meta credentials
    const creds = await this.getMetaCredentials();
    const businessManagerId = creds.businessManagerId;

    // Start a transaction to delete MetaAccount and PlatformCredentials
    try {
      await this.prisma.$transaction([
        // Delete Business Manager info from MetaAccount table
        this.prisma.metaAccount.deleteMany({
          where: {
            orgId: org.id,
            businessManagerId,
          },
        }),
        // Delete Meta credentials from PlatformCredentials table
        this.prisma.platformCredentials.deleteMany({
          where: {
            platform_id: platform.platform_id,
            type: 'AUTH',
            user_id: null,
          },
        }),
      ]);

      this.logger.log(
        `Business Manager (ID: ${businessManagerId}) and associated credentials disconnected successfully`,
      );
      return {
        message: 'Business Manager and credentials disconnected successfully',
      };
    } catch (error) {
      this.logger.error('Failed to disconnect Business Manager', error);
      throw new InternalServerErrorException(
        `Failed to disconnect Business Manager: ${error.message || error}`,
      );
    }
  }

  async getBusinessManagerInfo(userId: string) {
    // Verify user existence and role
    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
    });
    if (!user) {
      this.logger.error(`User with ID ${userId} not found`);
      throw new UnauthorizedException('User not found');
    }
    

    // Get organization
    const org = await this.prisma.organization.findUnique({
      where: { id: 'single-org' },
    });
    if (!org) {
      this.logger.error('Organization not found for id: single-org');
      throw new InternalServerErrorException('Organization not found');
    }

    // Get stored Meta credentials
    const creds = await this.getMetaCredentials();
    const businessManagerId = creds.businessManagerId;

    // Fetch Business Manager info from MetaAccount table
    const bmAccount = await this.prisma.metaAccount.findFirst({
      where: {
        orgId: org.id,
        businessManagerId,
      },
    });

    if (!bmAccount) {
      this.logger.log(
        `No Business Manager account found for organization ${org.id} and Business Manager ID ${businessManagerId}`,
      );
      return {
        message: 'No Business Manager account found',
        businessManagerInfo: null,
      };
    }

    this.logger.log(
      `Business Manager info retrieved successfully for Business Manager ID: ${businessManagerId}`,
    );
    return {
      message: 'Business Manager info retrieved successfully',
      businessManagerInfo: {
        businessManagerId: bmAccount.businessManagerId,
        descriptiveName: bmAccount.descriptiveName,
        currencyCode: bmAccount.currencyCode,
        timeZone: bmAccount.timeZone,
        adAccounts: bmAccount.adAccounts,
      },
    };
  }

async getValidAccessToken(
  clientId: string,
  clientSecret: string,
  accessToken: string,
  platformId: string,
): Promise<string> {
  this.logger.log(`Checking access token for platform_id=${platformId}`);
  const platformCreds = await this.prisma.platformCredentials.findFirst({
    where: { type: 'AUTH', platform_id: platformId, user_id: null },
  });

  if (
    platformCreds?.access_token &&
    platformCreds?.expires_at &&
    new Date(platformCreds.expires_at) > new Date()
  ) {
    this.logger.log(`Using existing valid access token: ${platformCreds.access_token.substring(0, 20)}...`);
    return platformCreds.access_token;
  }

  this.logger.log('Access token missing or expired, attempting to exchange for long-lived token...');
  try {
    const response = await axios.get<any>(
      `https://graph.facebook.com/v23.0/oauth/access_token`,
      {
        params: {
          grant_type: 'fb_exchange_token',
          client_id: clientId,
          client_secret: clientSecret,
          fb_exchange_token: accessToken,
        },
      },
    );
    const { access_token, expires_in } = response.data;
    const expiresAt = expires_in ? new Date(Date.now() + expires_in * 1000) : new Date(Date.now() + 3600 * 1000);
    await this.prisma.platformCredentials.update({
      where: { credential_id: platformCreds?.credential_id },
      data: { access_token, expires_at: expiresAt },
    });
    this.logger.log(`Exchanged long-lived access token: ${access_token.substring(0, 20)}..., expires_at=${expiresAt.toISOString()}`);
    return access_token;
  } catch (error) {
    if (platformCreds?.access_token) {
      this.logger.warn('Long-lived token exchange failed, using short-lived token');
      return platformCreds.access_token; // Fallback to short-lived token
    }
    this.logger.error('Failed to exchange access token', error.response?.data || error);
    throw new InternalServerErrorException('Failed to obtain valid access token');
  }
}
}
