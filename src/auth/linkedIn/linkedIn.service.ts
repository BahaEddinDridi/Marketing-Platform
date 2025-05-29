import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { PrismaService } from 'src/prisma/prisma.service';
import { v4 as uuidv4 } from 'uuid';
import { Prisma, CampaignStatus, ObjectiveType } from '@prisma/client';

const mapToPrismaEnum = <T extends Record<string, string>>(
  value: string,
  enumObject: T,
  defaultValue: T[keyof T] | null,
): T[keyof T] | null => {
  return Object.values(enumObject).includes(value as T[keyof T])
    ? (value as T[keyof T])
    : defaultValue;
};

interface LinkedInTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  scope?: string;
}

interface LinkedInTokenResponse {
  access_token: string;
  expires_in: number;
}

interface LinkedInMediaResponse {
  id: string;
  status: string;
  owner: string;
  downloadUrl?: string;
  downloadUrlExpiresAt?: number;
}

interface LinkedInAdAccountUser {
  role: string; // e.g., "CAMPAIGN_MANAGER", "ACCOUNT_BILLING_ADMIN"
  account: string; // e.g., "urn:li:sponsoredAccount:512263772"
  user: string;
  changeAuditStamps: {
    created: { actor: string; time: number };
    lastModified: { actor: string; time: number };
  };
}

interface LinkedInAdAccountsResponse {
  elements: LinkedInAdAccountUser[];
  paging?: {
    count: number;
    start: number;
    links: { type: string; rel: string; href: string }[];
  };
}

interface LinkedInCampaignGroup {
  id: string;
  name: string;
  urn: string;
  status: string;
  runSchedule?: {
    start: number;
    end?: number;
  };
  test: boolean;
  changeAuditStamps: {
    created: {
      actor: string;
      time: number;
    };
    lastModified: {
      actor: string;
      time: number;
    };
  };
  totalBudget?: {
    currencyCode: string;
    amount: string;
  };
  servingStatuses: string[];
  backfilled: boolean;
  account: string;
  objectiveType?: string;
}

interface LinkedInCampaignGroupsResponse {
  elements: LinkedInCampaignGroup[];
  paging?: {
    count: number;
    start: number;
    links: { type: string; rel: string; href: string }[];
  };
  metadata?: Record<string, any>;
}

interface LinkedInOrganizationResponse {
  id: string;
}

@Injectable()
export class LinkedInService {
  private readonly logger = new Logger(LinkedInService.name);

  private readonly linkedInAuthUrl =
    'https://www.linkedin.com/oauth/v2/authorization';

  constructor(
    private prisma: PrismaService,
    private configService: ConfigService,
  ) {}

  async saveLinkedInCredentials(
    userId: string,
    creds: { clientId: string; clientSecret: string },
  ) {
    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
    });
    if (!user) throw new UnauthorizedException('User not found');
    if (user.role !== 'ADMIN')
      throw new ForbiddenException('Only admins can save LinkedIn credentials');

    await this.prisma.organization.update({
      where: { id: 'single-org' },
      data: {
        linkedInCreds: {
          clientId: creds.clientId,
          clientSecret: creds.clientSecret,
        },
      },
    });

    return { message: 'LinkedIn credentials saved successfully' };
  }

  async testLinkedInConnection(userId: string, session: any) {
    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
    });
    if (!user) throw new UnauthorizedException('User not found');
    if (user.role !== 'ADMIN')
      throw new ForbiddenException('Only admins can test LinkedIn credentials');

    const org = await this.prisma.organization.findUnique({
      where: { id: 'single-org' },
      select: { linkedInCreds: true },
    });
    if (!org || !org.linkedInCreds) {
      throw new Error('No LinkedIn credentials found');
    }

    const { clientId } = org.linkedInCreds as any;

    const redirectUri = this.configService.get<string>(
      'LINKEDIN_REDIRECT_TEST_URI',
    );
    if (!redirectUri) {
      throw new InternalServerErrorException(
        'LINKEDIN_REDIRECT_TEST_URI is not defined in environment variables',
      );
    }

    try {
      const state = uuidv4();
      session.linkedinState = state;

      const authUrl = new URL(this.linkedInAuthUrl);
      authUrl.searchParams.append('response_type', 'code');
      authUrl.searchParams.append('client_id', clientId);
      authUrl.searchParams.append('redirect_uri', redirectUri);
      authUrl.searchParams.append('scope', 'profile');
      authUrl.searchParams.append('state', state);

      return {
        message: 'Initiate LinkedIn connection test',
        authUrl: authUrl.toString(),
      };
    } catch (error: any) {
      throw new Error('Failed to initiate LinkedIn connection test');
    }
  }

  async handleLinkedInCallback(code: string, state: string, session: any) {
    if (!session.linkedinState || state !== session.linkedinState) {
      throw new BadRequestException('Invalid state parameter');
    }

    const org = await this.prisma.organization.findUnique({
      where: { id: 'single-org' },
      select: { linkedInCreds: true },
    });
    if (!org || !org.linkedInCreds) {
      throw new Error('No LinkedIn credentials found');
    }

    const { clientId, clientSecret } = org.linkedInCreds as any;

    const redirectUri = this.configService.get<string>(
      'LINKEDIN_REDIRECT_TEST_URI',
    );
    if (!redirectUri) {
      throw new InternalServerErrorException(
        'LINKEDIN_REDIRECT_TEST_URI is not defined in environment variables',
      );
    }

    try {
      const response = await axios.post<LinkedInTokenResponse>(
        'https://www.linkedin.com/oauth/v2/accessToken',
        new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: clientId,
          client_secret: clientSecret,
        }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      );

      const { access_token } = response.data;
      delete session.linkedinState; // Clean up session
      return { message: 'Connection successful', accessToken: access_token };
    } catch (error: any) {
      throw new Error('Failed to complete LinkedIn connection test');
    }
  }

  async getLinkedInCredentials() {
    const org = await this.prisma.organization.findUnique({
      where: { id: 'single-org' },
      select: { linkedInCreds: true },
    });

    if (!org || !org.linkedInCreds) {
      throw new InternalServerErrorException(
        'LinkedIn credentials not found in database',
      );
    }

    const { clientId, clientSecret } = org.linkedInCreds as {
      clientId: string;
      clientSecret: string;
    };

    if (!clientId || !clientSecret) {
      throw new InternalServerErrorException(
        'Invalid LinkedIn credentials in database',
      );
    }

    return { clientId, clientSecret };
  }

  async validateLinkedInUser(
    userId: string,
    linkedInId: string,
    email: string,
    firstName: string,
    lastName: string,
    jobTitle: string,
    accessToken: string,
    refreshToken: string,
    expiresIn: number,
    scopes: string[],
    profileUrl: string,
  ) {
    try {
      const result = await this.prisma.$transaction(async (prisma) => {
        const user = await prisma.user.findUnique({
          where: { user_id: userId },
        });
        if (!user) {
          throw new UnauthorizedException('User not found');
        }

        let org = await prisma.organization.findUnique({
          where: { id: 'single-org' },
        });
        if (!org) {
          org = await prisma.organization.create({
            data: { id: 'single-org', name: 'ERP Organization' },
          });
        }

        // Check LinkedInPreferences
        const preferences = await prisma.linkedInPreferences.findUnique({
          where: { orgId: 'single-org' },
        });
        if (!preferences?.signInMethod) {
          throw new ForbiddenException(
            'LinkedIn profile connection is disabled',
          );
        }

        // Upsert LinkedInProfile
        await prisma.linkedInProfile.upsert({
          where: { userId },
          update: {
            linkedInId,
            email,
            firstName,
            lastName,
            jobTitle,
            profileUrl,
            updatedAt: new Date(),
          },
          create: {
            userId,
            linkedInId,
            email,
            firstName,
            lastName,
            jobTitle,
            profileUrl,
          },
        });

        // Create or update MarketingPlatform for LinkedIn
        let platform = await prisma.marketingPlatform.findFirst({
          where: { orgId: 'single-org', platform_name: 'LinkedIn' },
        });
        if (!platform) {
          platform = await prisma.marketingPlatform.create({
            data: {
              platform_name: 'LinkedIn',
              orgId: 'single-org',
              sync_status: 'CONNECTED',
            },
          });
        }

        // Upsert PlatformCredentials
        await prisma.platformCredentials.upsert({
          where: {
            platform_id_user_id_type: {
              platform_id: platform.platform_id,
              user_id: userId,
              type: 'AUTH',
            },
          },
          create: {
            platform_id: platform.platform_id,
            user_id: userId,
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
      return { user };
    } catch (error: any) {
      throw new Error(`Failed to validate LinkedIn user: ${error.message}`);
    }
  }

  async connectLinkedIn(userId: string, session: any) {
    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
    });
    if (!user) throw new UnauthorizedException('User not found');

    const org = await this.prisma.organization.findUnique({
      where: { id: 'single-org' },
    });
    if (!org) throw new Error('Single organization not found');

    const preferences = await this.prisma.linkedInPreferences.findUnique({
      where: { orgId: 'single-org' },
    });
    if (!preferences?.signInMethod) {
      throw new ForbiddenException('LinkedIn profile connection is disabled');
    }
    session.linkedinUserId = userId;
    return { url: 'http://localhost:5000/auth/linkedin' };
  }

  async disconnectLinkedIn(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
    });
    if (!user) throw new UnauthorizedException('User not found');

    const platform = await this.prisma.marketingPlatform.findFirst({
      where: { orgId: 'single-org', platform_name: 'LinkedIn' },
    });
    if (!platform) throw new Error('LinkedIn platform not found');

    await this.prisma.$transaction(async (prisma) => {
      await prisma.platformCredentials.deleteMany({
        where: {
          platform_id: platform.platform_id,
          user_id: userId,
          type: 'AUTH',
        },
      });
      await prisma.linkedInProfile.deleteMany({
        where: { userId },
      });
    });

    return {
      message: 'LinkedIn profile disconnected successfully',
    };
  }

  async updateLinkedInPreferences(userId: string, signInMethod: boolean) {
    this.logger.log(`Updating LinkedIn preferences for user ${userId}`);
    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
    });
    if (!user) throw new UnauthorizedException('User not found');
    if (user.role !== 'ADMIN') {
      throw new ForbiddenException(
        'Only admins can update LinkedIn preferences',
      );
    }

    const org = await this.prisma.organization.findUnique({
      where: { id: 'single-org' },
    });
    if (!org) throw new Error('Single organization not found');

    const preferences = await this.prisma.linkedInPreferences.upsert({
      where: { orgId: 'single-org' },
      update: {
        signInMethod,
        updated_at: new Date(),
      },
      create: {
        orgId: 'single-org',
        signInMethod,
      },
    });

    this.logger.log(
      `LinkedIn preferences updated: signInMethod=${signInMethod}`,
    );
    return {
      message: 'LinkedIn preferences updated successfully',
      preferences,
    };
  }

  async getStoredLinkedInProfile(userId: string) {
    try {
      const user = await this.prisma.user.findUnique({
        where: { user_id: userId },
        select: {
          linkedInProfile: true,
          email: true,
        },
      });

      if (!user) {
        throw new UnauthorizedException('User not found');
      }

      return user.linkedInProfile || null;
    } catch (error: any) {
      throw new InternalServerErrorException(
        'Failed to fetch LinkedIn profile data',
      );
    }
  }

  async validateLinkedInPage(
    userId: string,
    pageId: string,
    name: string,
    vanityName: string,
    logoUrn: string,
    email: string,
    accessToken: string,
    refreshToken: string,
    expiresIn: number,
    scopes: string[],
    websiteURL: string,
    description: string,
    logo: any,
    coverPhotoUrn: any,
    staffCount: string,
    specialties: string[],
    address: any,
  ) {
    try {
      return await this.prisma.$transaction(async (prisma) => {
        const user = await prisma.user.findUnique({
          where: { user_id: userId },
        });
        if (!user) {
          throw new UnauthorizedException('User not found');
        }
        if (user.role !== 'ADMIN') {
          throw new ForbiddenException('User is not an admin');
        }

        let org = await prisma.organization.findUnique({
          where: { id: 'single-org' },
        });
        if (!org) {
          org = await prisma.organization.create({
            data: { id: 'single-org', name: 'ERP Organization' },
          });
        }

        const preferences = await prisma.linkedInPreferences.findUnique({
          where: { orgId: 'single-org' },
        });
        if (!preferences?.signInMethod) {
          throw new ForbiddenException('LinkedIn page connection is disabled');
        }

        const isValidUrn = (urn: string) =>
          urn && urn.startsWith('urn:li:digitalmediaAsset:');
        let logoUrl: string | null = null;
        let coverPhotoUrl: string | null = null;

        if (isValidUrn(logoUrn)) {
          logoUrl = await this.resolveMediaUrl(logoUrn, accessToken);
        } else {
        }

        if (isValidUrn(coverPhotoUrn)) {
          coverPhotoUrl = await this.resolveMediaUrl(
            coverPhotoUrn,
            accessToken,
          );
        } else {
          this.logger.warn(
            `Invalid or missing cover photo URN: ${coverPhotoUrn}`,
          );
        }
        const page = await prisma.linkedInPage.upsert({
          where: { pageId },
          update: {
            name,
            vanityName: vanityName || null,
            logoUrl: logoUrl || null,
            email: email,
            websiteURL: websiteURL || null,
            description: description || null,
            logo: logo || null,
            coverPhoto: coverPhotoUrl || null,
            staffCount: staffCount || null,
            specialties: specialties || [],
            address: address || null,
            updatedAt: new Date(),
          },
          create: {
            organizationId: 'single-org',
            pageId,
            name,
            vanityName,
            logoUrl,
            email,
            websiteURL,
            description,
            logo,
            coverPhoto: coverPhotoUrl || null,
            staffCount,
            specialties,
            address,
          },
        });

        let platform = await prisma.marketingPlatform.findFirst({
          where: { orgId: 'single-org', platform_name: 'LinkedIn' },
        });
        if (!platform) {
          platform = await prisma.marketingPlatform.create({
            data: {
              platform_name: 'LinkedIn',
              orgId: 'single-org',
              sync_status: 'CONNECTED',
            },
          });
        }

        const existingCredentials = await prisma.platformCredentials.findFirst({
          where: {
            platform_id: platform.platform_id,
            user_id: null,
            type: 'AUTH',
          },
        });

        if (existingCredentials) {
          await prisma.platformCredentials.update({
            where: { credential_id: existingCredentials.credential_id },
            data: {
              access_token: accessToken,
              refresh_token: refreshToken || null,
              scopes,
              expires_at: new Date(Date.now() + expiresIn * 1000),
            },
          });
        } else {
          await prisma.platformCredentials.create({
            data: {
              platform_id: platform.platform_id,
              user_id: null,
              type: 'AUTH',
              access_token: accessToken,
              refresh_token: refreshToken || null,
              scopes,
              expires_at: new Date(Date.now() + expiresIn * 1000),
            },
          });
        }
        return {
          pageId,
          name,
          vanityName,
          logoUrl,
          email,
          websiteURL,
          description,
          logo,
          coverPhotoUrl,
          staffCount,
          specialties,
          address,
        };
      });
    } catch (error: any) {
      throw new Error(`Failed to validate LinkedIn page: ${error.message}`);
    }
  }

  async connectLinkedInPage(userId: string, session: any) {
    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
    });
    if (!user) throw new UnauthorizedException('User not found');
    if (user.role !== 'ADMIN')
      throw new ForbiddenException('User is not an admin');

    const org = await this.prisma.organization.findUnique({
      where: { id: 'single-org' },
    });
    if (!org) throw new Error('Single organization not found');

    const preferences = await this.prisma.linkedInPreferences.findUnique({
      where: { orgId: 'single-org' },
    });
    if (!preferences?.signInMethod) {
      throw new ForbiddenException('LinkedIn page connection is disabled');
    }

    session.linkedinPageUserId = userId;

    return { url: 'http://localhost:5000/auth/linkedin-page' };
  }

  async disconnectLinkedInPage(userId: string, pageId: string, session: any) {
    this.logger.log(`Disconnecting LinkedIn page ${pageId} for user ${userId}`);
    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
    });
    if (!user) throw new UnauthorizedException('User not found');
    if (user.role !== 'ADMIN')
      throw new ForbiddenException('User is not an admin');

    const platform = await this.prisma.marketingPlatform.findFirst({
      where: { orgId: 'single-org', platform_name: 'LinkedIn' },
    });
    if (!platform) throw new Error('LinkedIn platform not found');

    const page = await this.prisma.linkedInPage.findUnique({
      where: { pageId },
    });
    if (!page) throw new Error('LinkedIn page not found');

    await this.prisma.$transaction(async (prisma) => {
      await prisma.platformCredentials.deleteMany({
        where: {
          platform_id: platform.platform_id,
          user_id: null,
          type: 'AUTH',
        },
      });
      await prisma.linkedInPage.delete({
        where: { pageId },
      });
    });

    if (session && typeof session.destroy === 'function') {
      await new Promise((resolve, reject) => {
        session.destroy((err: any) => {
          if (err) reject(err);
          else resolve(null);
        });
      });
      this.logger.log(`Session destroyed for page ${pageId}`);
    } else {
      this.logger.warn('Session destroy not available or session is undefined');
    }

    this.logger.log(`LinkedIn page disconnected: ${pageId}`);

    return {
      message: 'LinkedIn page disconnected successfully',
    };
  }

  async getStoredLinkedInPages() {
    try {
      const pages = await this.prisma.linkedInPage.findMany({
        where: { organizationId: 'single-org' },
        select: {
          pageId: true,
          name: true,
          vanityName: true,
          logoUrl: true,
          email: true,
          websiteURL: true,
          description: true,
          logo: true,
          coverPhoto: true,
          staffCount: true,
          specialties: true,
          address: true,
          adAccounts: {
            select: {
              id: true,
              accountUrn: true,
              role: true,
              campaignGroups: {
                select: {
                  id: true,
                  name: true,
                  urn: true,
                },
              },
              createdAt: true,
              updatedAt: true,
            },
          },
          createdAt: true,
          updatedAt: true,
        },
      });

      return pages.map((page) => ({
        pageId: String(page.pageId),
        name: page.name,
        vanityName: page.vanityName || '',
        logoUrl: page.logoUrl || '',
        email: page.email || '',
        websiteURL: page.websiteURL || '',
        description: page.description || '',
        logo: page.logo || null,
        coverPhoto: page.coverPhoto || null,
        staffCount: page.staffCount || '',
        specialties: page.specialties || [],
        address: page.address || null,
        adAccounts: page.adAccounts.map((adAccount) => ({
          id: adAccount.id, // LinkedIn ID
          accountUrn: adAccount.accountUrn,
          role: adAccount.role,
          campaignGroups: adAccount.campaignGroups.map((group) => ({
            id: group.id,
            name: group.name,
            urn: group.urn || null,
          })),
          createdAt: adAccount.createdAt,
          updatedAt: adAccount.updatedAt,
        })),
        createdAt: page.createdAt,
        updatedAt: page.updatedAt,
      }));
    } catch (error: any) {
      throw new Error(`Failed to fetch LinkedIn pages: ${error.message}`);
    }
  }

  async fetchLinkedInAdAccounts(
    pageId: string,
    accessToken: string,
  ): Promise<any> {
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'LinkedIn-Version': '202411',
      'X-RestLi-Protocol-Version': '2.0.0',
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    try {
      const linkedInPage = await this.prisma.linkedInPage.findUnique({
        where: { pageId },
      });
      if (!linkedInPage) {
        throw new Error('LinkedIn page not found');
      }

      const adAccountsUrl = 'https://api.linkedin.com/rest/adAccountUsers';
      const params = {
        q: 'authenticatedUser',
      };

      const urlWithParams = new URL(adAccountsUrl);
      Object.entries(params).forEach(([key, value]) => {
        urlWithParams.searchParams.append(key, value as string);
      });
      this.logger.log(`Fetching ad accounts: ${urlWithParams.toString()}`);

      const adAccountsResponse = await axios.get<LinkedInAdAccountsResponse>(
        adAccountsUrl,
        {
          headers,
          params,
        },
      );

      this.logger.log(
        `Fetched ad accounts response: ${JSON.stringify(adAccountsResponse.data, null, 2)}`,
      );

      const adAccounts: { id: string; role: string }[] = [];
      for (const element of adAccountsResponse.data.elements || []) {
        const accountUrn = element.account;
        const accountIdMatch = accountUrn.match(
          /urn:li:sponsoredAccount:(\d+)/,
        );
        if (!accountIdMatch) {
          this.logger.warn(`Invalid account URN: ${accountUrn}`);
          continue;
        }
        const accountId = accountIdMatch[1];

        adAccounts.push({
          id: accountId,
          role: element.role,
        });

        // Upsert AdAccount
        await this.prisma.adAccount.upsert({
          where: {
            organizationId_id: {
              organizationId: linkedInPage.organizationId,
              id: accountId,
            },
          },
          update: {
            role: element.role,
            userUrn: element.user,
            accountUrn: element.account,
            changeAuditStamps: element.changeAuditStamps,
            updatedAt: new Date(),
          },
          create: {
            id: accountId,
            organizationId: linkedInPage.organizationId,
            linkedInPageId: linkedInPage.id,
            accountUrn: element.account,
            role: element.role,
            userUrn: element.user,
            changeAuditStamps: element.changeAuditStamps,
          },
        });
      }

      // Log the mapped ad accounts
      this.logger.log(
        `Mapped ad accounts: ${JSON.stringify(adAccounts, null, 2)}`,
      );

      const campaignGroupsByAdAccount: {
        adAccountId: string;
        groups: { id: string; name: string; urn: string }[];
      }[] = [];

      for (const adAccount of adAccounts) {
        if (!adAccount.id) {
          this.logger.warn(
            `Skipping campaign groups fetch for invalid ad account: ${JSON.stringify(adAccount)}`,
          );
          campaignGroupsByAdAccount.push({
            adAccountId: adAccount.id || 'missing_id',
            groups: [],
          });
          continue;
        }
        this.logger.log(
          'Fetching campaign groups for ad account:',
          adAccount.id,
        );
        try {
          const campaignGroupsUrl = `https://api.linkedin.com/rest/adAccounts/${adAccount.id}/adCampaignGroups`;
          const campaignGroupsParams = {
            q: 'search',
          };

          const campaignGroupsResponse =
            await axios.get<LinkedInCampaignGroupsResponse>(campaignGroupsUrl, {
              headers,
              params: campaignGroupsParams,
            });

          const campaignGroups = (
            campaignGroupsResponse.data.elements || []
          ).map((group) => ({
            id: group.id.toString(),
            urn: `urn:li:sponsoredCampaignGroup:${group.id}`,
            name: group.name || 'Unnamed Campaign Group',
            status: mapToPrismaEnum(
              group.status,
              CampaignStatus,
              CampaignStatus.DRAFT,
            ) as CampaignStatus,
            runSchedule: group.runSchedule || null,
            test: group.test,
            changeAuditStamps: group.changeAuditStamps,
            totalBudget: group.totalBudget || null,
            servingStatuses: group.servingStatuses || [],
            backfilled: group.backfilled,
            accountUrn: group.account,
            objectiveType: group.objectiveType
              ? mapToPrismaEnum(group.objectiveType, ObjectiveType, null)
              : null,
          }));

          // Fetch the AdAccount to associate campaign groups
          const adAccountRecord = await this.prisma.adAccount.findFirst({
            where: { id: adAccount.id },
          });

          if (!adAccountRecord) {
            this.logger.warn(
              `AdAccount not found for accountId: ${adAccount.id}`,
            );
            campaignGroupsByAdAccount.push({
              adAccountId: adAccount.id,
              groups: [],
            });
            continue;
          }

          // Upsert CampaignGroups
          for (const group of campaignGroups) {
            await this.prisma.campaignGroup.upsert({
              where: { id: group.id }, // Use string id
              update: {
                adAccountId: adAccountRecord.id,
                name: group.name,
                status: group.status,
                runSchedule: group.runSchedule
                  ? group.runSchedule
                  : Prisma.JsonNull,
                test: group.test,
                changeAuditStamps: group.changeAuditStamps,
                totalBudget: group.totalBudget
                  ? group.totalBudget
                  : Prisma.JsonNull,
                servingStatuses: group.servingStatuses,
                backfilled: group.backfilled,
                accountUrn: group.accountUrn,
                objectiveType: group.objectiveType,
                urn: group.urn,
                updatedAt: new Date(),
              },
              create: {
                id: group.id, // Use string id
                adAccountId: adAccountRecord.id,
                name: group.name,
                urn: group.urn,
                status: group.status,
                runSchedule: group.runSchedule
                  ? group.runSchedule
                  : Prisma.JsonNull,
                test: group.test,
                changeAuditStamps: group.changeAuditStamps,
                totalBudget: group.totalBudget
                  ? group.totalBudget
                  : Prisma.JsonNull,
                servingStatuses: group.servingStatuses,
                backfilled: group.backfilled,
                accountUrn: group.accountUrn,
                objectiveType: group.objectiveType,
              },
            });
          }
          campaignGroupsByAdAccount.push({
            adAccountId: adAccount.id,
            groups: campaignGroups.map((group) => ({
              id: group.id,
              name: group.name,
              urn: group.urn,
            })),
          });

          this.logger.log(
            `Fetched ${campaignGroups.length} campaign groups for ad account ${adAccount.id}`,
          );
        } catch (groupError: any) {
          this.logger.warn(
            `Failed to fetch campaign groups for ad account ${adAccount.id}: ${groupError.message}`,
          );
          campaignGroupsByAdAccount.push({
            adAccountId: adAccount.id,
            groups: [],
          });
        }
      }

      this.logger.log(
        `Saved ${adAccounts.length} ad accounts and ${campaignGroupsByAdAccount.reduce(
          (sum, acc) => sum + acc.groups.length,
          0,
        )} campaign groups for page ${pageId}`,
      );

      return { adAccounts, campaignGroups: campaignGroupsByAdAccount };
    } catch (error: any) {
      if (error.response) {
        this.logger.error(
          `LinkedIn API Error: ${error.response.status} - ${JSON.stringify(error.response.data)}`,
        );
        this.logger.error(
          `Request Config: ${JSON.stringify({
            url: error.config?.url,
            method: error.config?.method,
            params: error.config?.params,
            headers: error.config?.headers,
          })}`,
        );
      } else {
        this.logger.error(
          `Unexpected Error: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      throw new Error('Failed to fetch ad accounts');
    }
  }

  async selectLinkedInPage(userId: string, pageId: string, session: any) {
    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
    });
    if (!user) throw new UnauthorizedException('User not found');
    if (user.role !== 'ADMIN')
      throw new ForbiddenException('User is not an admin');

    const orgProfiles = session.orgProfiles || [];
    if (!orgProfiles.some((p: any) => p.id === pageId)) {
      throw new Error('Selected page not found');
    }

    session.selectedPageId = pageId;

    const profile = orgProfiles.find((p: any) => p.id === pageId);
    if (!profile) {
      throw new Error('Selected page profile not found');
    }

    try {
      const pageData = await this.validateLinkedInPage(
        userId,
        profile.id,
        profile._json.name || profile.displayName,
        profile._json.vanityName || '',
        profile._json.logo?.cropped || '',
        profile.emails?.[0]?.value || '',
        session.accessToken,
        session.refreshToken || '',
        session.expiresIn || 5184000,
        [
          'rw_organization_admin',
          'r_organization_admin',
          'w_organization_social',
          'rw_ads',
          'r_ads',
          'r_ads_reporting',
          'profile',
          'email',
          'openid',
        ],
        profile._json.websiteURL || '',
        profile._json.description || '',
        profile._json.logo || null,
        profile._json.coverPhoto?.cropped || '',
        profile._json.staffCount || '',
        profile._json.specialties || [],
        profile._json.address || null,
      );

      try {
        const { adAccounts, campaignGroups } =
          await this.fetchLinkedInAdAccounts(pageId, session.accessToken);
        this.logger.log(
          `Fetched ${adAccounts.length} ad accounts and ${campaignGroups.reduce(
            (sum: number, acc: any) => sum + acc.groups.length,
            0,
          )} campaign groups for page ${pageId}`,
        );
      } catch (error: any) {
        this.logger.error(
          `Failed to fetch/save ad accounts for page ${pageId}: ${error.message}`,
        );
      }

      session.orgProfiles = null;
      session.selectedPageId = null;
      session.accessToken = null;
      session.refreshToken = null;
      session.linkedinPageUserId = null;

      return { success: true, pageData };
    } catch (error: any) {
      throw new Error(`Failed to validate page: ${error.message}`);
    }
  }

  async resolveMediaUrl(
    urn: string,
    accessToken: string,
  ): Promise<string | null> {
    try {
      // Convert digitalmediaAsset URN to image URN
      const imageUrn = urn.replace('digitalmediaAsset', 'image');
      const encodedUrn = encodeURIComponent(imageUrn);
      const url = `https://api.linkedin.com/rest/images/${encodedUrn}`;

      this.logger.log(`Resolving media URN: ${urn} with URL: ${url}`);

      const response = await axios.get<LinkedInMediaResponse>(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'LinkedIn-Version': '202411', // Latest version as of 2025
          'X-RestLi-Protocol-Version': '2.0.0',
          'Content-Type': 'application/json',
        },
      });

      const downloadUrl = response.data.downloadUrl;
      if (!downloadUrl) {
        this.logger.warn(`No downloadUrl found for URN ${urn}`);
        return null;
      }

      this.logger.log(`Resolved media URN ${urn}: ${downloadUrl}`);
      return downloadUrl;
    } catch (error: any) {
      const status = error.response?.status;
      const errorData = error.response?.data;

      if (status === 403) {
        this.logger.error(
          `Permission denied for URN ${urn}. Check access token permissions (rw_ads, w_organization_social).`,
          { status, data: errorData },
        );
      } else if (status === 429) {
        this.logger.error(`Rate limit exceeded for URN ${urn}.`, {
          status,
          data: errorData,
        });
      } else if (status === 404) {
        this.logger.error(`Invalid or non-existent URN ${urn}.`, {
          status,
          data: errorData,
        });
      } else {
        this.logger.error(
          `Failed to resolve media URN ${urn}: ${error.message}`,
          { status, data: errorData },
        );
      }

      return null;
    }
  }

  async refreshAccessToken(): Promise<LinkedInTokenResponse> {
    const org = await this.prisma.organization.findUnique({
      where: { id: 'single-org' },
    });
    if (!org) {
      this.logger.error(`Organization not found for id: single-org`);
      throw new Error('Organization not found');
    }

    let platform = await this.prisma.marketingPlatform.findFirst({
      where: { orgId: org.id, platform_name: 'LinkedIn' },
    });
    const credentials = await this.prisma.platformCredentials.findFirst({
      where: {
        platform_id: platform?.platform_id,
        type: 'AUTH',
        user_id: null,
      },
    });
    if (!credentials || !credentials.refresh_token) {
      this.logger.error('No refresh token found for platform');
      throw new InternalServerErrorException('No refresh token available');
    }

    const { clientId, clientSecret } = await this.getLinkedInCredentials();
    try {
      const response = await axios.post<LinkedInTokenResponse>(
        'https://www.linkedin.com/oauth/v2/accessToken',
        new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: credentials.refresh_token,
          client_id: clientId,
          client_secret: clientSecret,
        }).toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        },
      );

      const { access_token, expires_in, refresh_token } = response.data;
      this.logger.log(
        `Access token refreshed for platform ${platform?.platform_id}`,
      );

      // Update credentials
      await this.prisma.platformCredentials.update({
        where: { credential_id: credentials.credential_id },
        data: {
          access_token,
          refresh_token: refresh_token || credentials.refresh_token,
          expires_at: new Date(Date.now() + expires_in * 1000),
        },
      });

      return response.data;
    } catch (error: any) {
      this.logger.error(`Failed to refresh access token: ${error.message}`);
      if (
        error.response?.status === 400 &&
        error.response.data?.error === 'invalid_request'
      ) {
        this.logger.error(
          'Refresh token invalid, expired, or revoked. Reauthorization required.',
        );
        throw new UnauthorizedException(
          'Refresh token invalid. Please reauthorize.',
        );
      }
      throw new InternalServerErrorException('Failed to refresh access token');
    }
  }

  async getValidAccessToken(): Promise<string> {
    const org = await this.prisma.organization.findUnique({
      where: { id: 'single-org' },
    });
    if (!org) {
      this.logger.error(`Organization not found for id: single-org`);
      throw new Error('Organization not found');
    }

    let platform = await this.prisma.marketingPlatform.findFirst({
      where: { orgId: org.id, platform_name: 'LinkedIn' },
    });
    const credentials = await this.prisma.platformCredentials.findFirst({
      where: {
        platform_id: platform?.platform_id,
        type: 'AUTH',
        user_id: null,
      },
    });
    if (!credentials) {
      this.logger.error('No credentials found for platform');
      throw new InternalServerErrorException('No credentials found');
    }
    if (!credentials.access_token) {
      this.logger.error('Access token missing for platform');
      throw new InternalServerErrorException('Access token missing');
    }

    const now = new Date();
    if (credentials.expires_at && credentials.expires_at > now) {
      this.logger.log(
        `Using existing access token for platform ${platform?.platform_id}`,
      );
      return credentials.access_token;
    }
    this.logger.log(
      `Access token expired for platform ${platform?.platform_id}, refreshing`,
    );
    const { access_token } = await this.refreshAccessToken();
    return access_token;
  }
}
