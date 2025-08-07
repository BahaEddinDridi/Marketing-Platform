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
import { GoogleAdsApi } from 'google-ads-api';
import axios from 'axios';
import * as qs from 'querystring';
import { Prisma } from '@prisma/client';
import { decrypt, encrypt } from 'src/middlewares/crypto.helper';

@Injectable()
export class GoogleService {
  private readonly logger = new Logger(GoogleService.name);

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
  ) {}

  async saveGoogleCredentials(
    userId: string,
    creds: {
      clientId: string;
      clientSecret: string;
      developerToken: string;
      customerAccountId: string;
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
        `User ${userId} attempted to save Google credentials without ADMIN role`,
      );
      throw new ForbiddenException('Only admins can save Google credentials');
    }

    // Update organization with Google credentials
    await this.prisma.organization.update({
      where: { id: 'single-org' },
      data: {
        googleCreds: {
          clientId: encrypt(creds.clientId),
          clientSecret: encrypt(creds.clientSecret),
          developerToken: encrypt(creds.developerToken),
          customerAccountId: encrypt(creds.customerAccountId),
        },
      },
    });

    this.logger.log(
      'Google credentials saved successfully for organization single-org',
    );
    return { message: 'Google credentials saved successfully' };
  }

  async getGoogleCredentials() {
    // Fetch organization with Google credentials
    const org = await this.prisma.organization.findUnique({
      where: { id: 'single-org' },
      select: { googleCreds: true },
    });

    // Check if organization or credentials exist
    if (!org || !org.googleCreds) {
      this.logger.error(
        'Google credentials not found in database for organization single-org',
      );
      throw new InternalServerErrorException(
        'Google credentials not found in database',
      );
    }

    // Extract and validate credentials
    const { clientId, clientSecret, developerToken, customerAccountId } =
      org.googleCreds as {
        clientId: string;
        clientSecret: string;
        developerToken: string;
        customerAccountId: string;
      };

    if (!clientId || !clientSecret || !developerToken || !customerAccountId) {
      this.logger.error('Invalid Google credentials in database');
      throw new InternalServerErrorException(
        'Invalid Google credentials in database',
      );
    }

    return {
      clientId: decrypt(clientId),
      clientSecret: decrypt(clientSecret),
      developerToken: decrypt(developerToken),
      customerAccountId: decrypt(customerAccountId),
    };
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
      throw new ForbiddenException('Only admins can test Google connection');
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
      where: { orgId: org.id, platform_name: 'Google' },
    });
    if (!platform) {
      platform = await this.prisma.marketingPlatform.create({
        data: {
          orgId: org.id,
          platform_name: 'Google',
        },
      });
    }

    const platformCreds = await this.prisma.platformCredentials.findFirst({
      where: {
        platform_id: platform.platform_id,
        type: 'AUTH',
        user_id: '',
      },
    });
    if (!platformCreds || !platformCreds.refresh_token) {
      this.logger.warn('No valid Google platform credentials found');
      throw new BadRequestException(
        'Authentication required: No valid refresh token found. Please authenticate with Google.',
      );
    }

    // Get stored Google credentials
    const creds = await this.getGoogleCredentials();

    // Initialize Google Ads API client
    const client = new GoogleAdsApi({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      developer_token: creds.developerToken,
    });

    // Initialize customer with stored refresh token and customer ID
    const customer = client.Customer({
      customer_id: creds.customerAccountId,
      refresh_token: platformCreds.refresh_token,
    });

    try {
      // Simple GAQL query to fetch basic customer info
      const response = await customer.query(`
        SELECT customer.id, customer.descriptive_name FROM customer LIMIT 1
      `);

      const results: any[] = [];
      for await (const row of response) {
        results.push(row);
      }

      if (results.length === 0) {
        this.logger.error('No customer data returned from Google Ads API');
        throw new BadRequestException('No customer data returned');
      }

      this.logger.log('Google Ads API test connection successful');
      return {
        message: 'Google Ads API connection successful',
        customer: results[0],
      };
    } catch (error) {
      this.logger.error('Google Ads API test connection failed', error);
      throw new InternalServerErrorException(
        `Google Ads API connection failed: ${error.message || error}`,
      );
    }
  }

  async generateAuthUrl(): Promise<{ url: string }> {
    const { clientId } = await this.getGoogleCredentials();

    const redirectUri = this.configService.get('GOOGLE_CALLBACK_URL');
    const scope = 'https://www.googleapis.com/auth/adwords';

    const query = qs.stringify({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      access_type: 'offline',
      scope,
      prompt: 'consent',
    });

    return {
      url: `https://accounts.google.com/o/oauth2/v2/auth?${query}`,
    };
  }

  async handleAuthCode(code: string) {
    const { clientId, clientSecret } = await this.getGoogleCredentials();
    const redirectUri = this.configService.get('GOOGLE_CALLBACK_URL');

    try {
      const response = await axios.post(
        'https://oauth2.googleapis.com/token',
        qs.stringify({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        }),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        },
      );

      const { access_token, refresh_token, expires_in } = response.data as any;
      if (!refresh_token) {
        throw new BadRequestException(
          'No refresh_token received. Consent prompt may have been skipped.',
        );
      }

      // 1. Get the organization
      const org = await this.prisma.organization.findUnique({
        where: { id: 'single-org' },
      });
      if (!org) {
        this.logger.error(`Organization not found for id: single-org`);
        throw new Error('Organization not found');
      }

      // 2. Find or create the "Google" marketing platform
      let platform = await this.prisma.marketingPlatform.findFirst({
        where: {
          orgId: org.id,
          platform_name: 'Google',
        },
      });

      if (!platform) {
        platform = await this.prisma.marketingPlatform.create({
          data: {
            orgId: org.id,
            platform_name: 'Google',
          },
        });
      }

      // 3. Upsert the platformCredentials of type "AUTH" and user_id = null
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
            refresh_token,
            expires_at: new Date(Date.now() + expires_in * 1000),
          },
        });
      } else {
        await this.prisma.platformCredentials.create({
          data: {
            platform_id: platform.platform_id,
            user_id: null,
            type: 'AUTH',
            access_token,
            refresh_token,
            expires_at: new Date(Date.now() + expires_in * 1000),
            scopes: [], // Make sure to include required fields
          },
        });
      }

      return { refresh_token, access_token, expires_in };
    } catch (error) {
      this.logger.error(
        'OAuth token exchange failed',
        error.response?.data || error,
      );
      throw new InternalServerErrorException('OAuth token exchange failed');
    }
  }

  async connectAndFetchMCCInfo(userId: string) {
    // Verify user existence and role
    this.logger.log('we are here');
    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
    });
    if (!user) {
      this.logger.error(`User with ID ${userId} not found`);
      throw new UnauthorizedException('User not found');
    }
    if (user.role !== 'ADMIN') {
      this.logger.warn(
        `User ${userId} attempted to connect MCC without ADMIN role`,
      );
      throw new ForbiddenException('Only admins can connect MCC accounts');
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
    const platform = await this.prisma.marketingPlatform.findFirst({
      where: { orgId: org.id, platform_name: 'Google' },
    });
    if (!platform) {
      this.logger.error('Google marketing platform not found');
      throw new InternalServerErrorException(
        'Google marketing platform not found',
      );
    }

    const platformCreds = await this.prisma.platformCredentials.findFirst({
      where: {
        platform_id: platform.platform_id,
        type: 'AUTH',
        user_id: null,
      },
    });
    if (!platformCreds || !platformCreds.refresh_token) {
      this.logger.warn('No valid Google platform credentials found');
      throw new BadRequestException(
        'Authentication required: No valid refresh token found. Please authenticate with Google.',
      );
    }

    // Get stored Google credentials
    const creds = await this.getGoogleCredentials();

    // Initialize Google Ads API client
    const client = new GoogleAdsApi({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      developer_token: creds.developerToken,
    });

    // Initialize customer with refresh token and customer ID
    const customer = client.Customer({
      customer_id: creds.customerAccountId,
      refresh_token: platformCreds.refresh_token,
    });

    try {
      // Fetch MCC info using GAQL query
      const mccResponse = await customer.query(`
      SELECT 
        customer.id,
        customer.descriptive_name,
        customer.currency_code,
        customer.time_zone
      FROM customer 
      WHERE customer.manager = TRUE
      LIMIT 1
    `);

      const mccResults: any[] = [];
      for await (const row of mccResponse) {
        mccResults.push(row);
      }

      if (mccResults.length === 0) {
        this.logger.error('No MCC account data returned from Google Ads API');
        throw new BadRequestException('No MCC account data returned');
      }

      const mccData = mccResults[0].customer;

      // Fetch client accounts using GAQL query
      const clientResponse = await customer.query(`
      SELECT 
        customer_client.client_customer,
        customer_client.level,
        customer_client.manager,
        customer_client.descriptive_name,
        customer_client.currency_code,
        customer_client.time_zone,
        customer_client.id
      FROM customer_client 
      WHERE customer_client.level <= 1
    `);

      const clientAccounts: any[] = [];
      for await (const row of clientResponse) {
        const client = row.customer_client;
        // Only include non-manager accounts (i.e., client accounts, not the MCC itself)
        if (client && !client.manager && client.level === 1) {
          clientAccounts.push({
            resourceName: client.resource_name,
            clientCustomer: client.client_customer,
            level: client.level?.toString(),
            manager: client.manager,
            descriptiveName: client.descriptive_name || null,
            currencyCode: client.currency_code || null,
            timeZone: client.time_zone || null,
            id: client.id?.toString(),
          });
        }
      }

      // Save or update MCC info and client accounts in GoogleAccount table
      const mccId = mccData.id.toString().replace(/-/g, ''); // Normalize MCC ID (e.g., "1234567890")
      await this.prisma.googleAccount.upsert({
        where: {
          orgId_mccId: {
            orgId: org.id,
            mccId,
          },
        },
        create: {
          orgId: org.id,
          platformId: platform.platform_id,
          mccId,
          descriptiveName: mccData.descriptive_name || null,
          currencyCode: mccData.currency_code || null,
          timeZone: mccData.time_zone || null,
          clientAccounts:
            clientAccounts.length > 0 ? clientAccounts : Prisma.JsonNull,
        },
        update: {
          descriptiveName: mccData.descriptive_name || null,
          currencyCode: mccData.currency_code || null,
          timeZone: mccData.time_zone || null,
          clientAccounts:
            clientAccounts.length > 0 ? clientAccounts : Prisma.JsonNull,
          updatedAt: new Date(),
        },
      });

      this.logger.log(
        `MCC info and ${clientAccounts.length} client accounts saved successfully for MCC ID: ${mccId}`,
      );
      return {
        message: 'MCC info and client accounts fetched and saved successfully',
        mccInfo: {
          mccId,
          descriptiveName: mccData.descriptive_name,
          currencyCode: mccData.currency_code,
          timeZone: mccData.time_zone,
          clientAccounts,
        },
      };
    } catch (error) {
      this.logger.error(
        'Failed to fetch or save MCC info or client accounts',
        error,
      );
      throw new InternalServerErrorException(
        `Failed to fetch or save MCC info or client accounts: ${error.message || error}`,
      );
    }
  }

  async disconnectMCC(userId: string) {
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
        `User ${userId} attempted to disconnect MCC without ADMIN role`,
      );
      throw new ForbiddenException('Only admins can disconnect MCC accounts');
    }

    // Get organization
    const org = await this.prisma.organization.findUnique({
      where: { id: 'single-org' },
    });
    if (!org) {
      this.logger.error('Organization not found for id: single-org');
      throw new InternalServerErrorException('Organization not found');
    }

    // Find the Google marketing platform
    const platform = await this.prisma.marketingPlatform.findFirst({
      where: { orgId: org.id, platform_name: 'Google' },
    });
    if (!platform) {
      this.logger.error('Google marketing platform not found');
      throw new InternalServerErrorException(
        'Google marketing platform not found',
      );
    }

    // Get stored Google credentials to retrieve customerAccountId
    const creds = await this.getGoogleCredentials();
    const mccId = creds.customerAccountId; // Use customerAccountId as mccId

    // Start a transaction to delete GoogleAccount and PlatformCredentials
    try {
      await this.prisma.$transaction([
        // Delete MCC info from GoogleAccount table
        this.prisma.googleAccount.deleteMany({
          where: {
            orgId: org.id,
            mccId,
          },
        }),
        // Delete Google credentials from PlatformCredentials table
        this.prisma.platformCredentials?.deleteMany({
          where: {
            platform_id: platform.platform_id,
            type: 'AUTH',
            user_id: null,
          },
        }),
      ]);

      this.logger.log(
        `MCC account (ID: ${mccId}) and associated credentials disconnected successfully`,
      );
      return {
        message: 'MCC account and credentials disconnected successfully',
      };
    } catch (error) {
      this.logger.error('Failed to disconnect MCC account', error);
      throw new InternalServerErrorException(
        `Failed to disconnect MCC account: ${error.message || error}`,
      );
    }
  }

  async getMCCInfo(userId: string) {
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

    // Get stored Google credentials to retrieve customerAccountId
    const creds = await this.getGoogleCredentials();
    const mccId = creds.customerAccountId;

    // Fetch MCC info from GoogleAccount table
    const mccAccount = await this.prisma.googleAccount.findUnique({
      where: {
        orgId_mccId: {
          orgId: org.id,
          mccId,
        },
      },
    });

    if (!mccAccount) {
      this.logger.log(
        `No MCC account found for organization ${org.id} and MCC ID ${mccId}`,
      );
      return {
        message: 'No MCC account found',
        mccInfo: null,
      };
    }

    this.logger.log(`MCC info retrieved successfully for MCC ID: ${mccId}`);
    return {
      message: 'MCC info retrieved successfully',
      mccInfo: {
        id: mccAccount.id,
        mccId: mccAccount.mccId,
        descriptiveName: mccAccount.descriptiveName,
        currencyCode: mccAccount.currencyCode,
        timeZone: mccAccount.timeZone,
        clientAccounts: mccAccount.clientAccounts,
      },
    };
  }

  async getValidAccessToken(
    clientId: string,
    clientSecret: string,
    refreshToken: string,
    platformId: string,
  ): Promise<string> {
    this.logger.log(`Checking access token for platform_id=${platformId}`);

    // Fetch credentials
    const platformCreds = await this.prisma.platformCredentials.findFirst({
      where: {
        type: 'AUTH',
        platform_id: platformId,
        user_id: null, // Explicitly match user_id: null
      },
    });

    if (
      platformCreds?.access_token &&
      platformCreds?.expires_at &&
      new Date(platformCreds.expires_at) > new Date()
    ) {
      this.logger.log(
        `Using existing valid access token: ${platformCreds.access_token.substring(0, 20)}...`,
      );
      return platformCreds.access_token;
    }

    this.logger.log('Access token missing or expired, refreshing...');

    // Refresh the access token
    try {
      const response = await axios.post<{
        access_token: string;
        expires_in: number;
      }>(
        'https://oauth2.googleapis.com/token',
        qs.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
        }),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        },
      );

      const { access_token, expires_in } = response.data;
      const expiresAt = new Date(Date.now() + expires_in * 1000);

      this.logger.log(
        `Refreshed access token: ${access_token.substring(0, 20)}..., expires_at=${expiresAt.toISOString()}`,
      );

      // Update the database with new access token and expiration
      if (!platformCreds) {
        this.logger.error(
          'Platform credentials not found for updating access token',
        );
        throw new InternalServerErrorException(
          'Platform credentials not found',
        );
      }
      await this.prisma.platformCredentials.update({
        where: { credential_id: platformCreds.credential_id },
        data: {
          access_token,
          expires_at: expiresAt,
        },
      });

      return access_token;
    } catch (error: any) {
      this.logger.error('Failed to refresh access token', {
        error: error.message,
        details: JSON.stringify(error.response?.data || {}),
      });
      throw new InternalServerErrorException('Failed to refresh access token');
    }
  }
}
