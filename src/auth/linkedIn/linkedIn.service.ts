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

    this.logger.log(`Saved LinkedIn credentials for org single-org`);
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
    this.logger.log(
      `Testing LinkedIn connection for org single-org with clientId: ${clientId}`,
    );

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

      this.logger.log(
        `LinkedIn connection test initiated: Redirect to ${authUrl.toString()}`,
      );
      return {
        message: 'Initiate LinkedIn connection test',
        authUrl: authUrl.toString(),
      };
    } catch (error: any) {
      this.logger.error(`LinkedIn connection test failed: ${error.message}`);
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
      this.logger.log(`LinkedIn connection test successful: Token acquired`);
      delete session.linkedinState; // Clean up session
      return { message: 'Connection successful', accessToken: access_token };
    } catch (error: any) {
      this.logger.error(`LinkedIn token exchange failed: ${error.message}`);
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
    this.logger.log(`Validating LinkedIn user: ${email}`);

    try {
      const result = await this.prisma.$transaction(async (prisma) => {
        const user = await prisma.user.findUnique({
          where: { user_id: userId },
        });
        if (!user) {
          this.logger.error(`User not found: ${userId}`);
          throw new UnauthorizedException('User not found');
        }

        let org = await prisma.organization.findUnique({
          where: { id: 'single-org' },
        });
        if (!org) {
          this.logger.log('Creating new organization: single-org');
          org = await prisma.organization.create({
            data: { id: 'single-org', name: 'ERP Organization' },
          });
        }

        // Check LinkedInPreferences
        const preferences = await prisma.linkedInPreferences.findUnique({
          where: { orgId: 'single-org' },
        });
        if (!preferences?.signInMethod) {
          this.logger.error('LinkedIn profile connection is disabled');
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
      this.logger.log(`LinkedIn profile connected for user: ${user.email}`);
      return { user };
    } catch (error: any) {
      this.logger.error(
        `LinkedIn validation failed: ${error.message}`,
        error.stack,
      );
      throw new Error(`Failed to validate LinkedIn user: ${error.message}`);
    }
  }

  async connectLinkedIn(userId: string, session: any) {
    this.logger.log(`Connecting LinkedIn for user ${userId}`);
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
      this.logger.error('LinkedIn profile connection is disabled');
      throw new ForbiddenException('LinkedIn profile connection is disabled');
    }
    session.linkedinUserId = userId;
    this.logger.log(`Set session.linkedinUserId: ${userId}`);
    this.logger.log(`LinkedIn profile connection initiated for user ${userId}`);
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

    this.logger.log(`LinkedIn profile disconnected for user ${userId}`);
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
    this.logger.log(`Fetching stored LinkedIn profile for user ${userId}`);

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
      this.logger.error(
        `Failed to fetch stored LinkedIn profile: ${error.message}`,
      );
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
    this.logger.log(`Validating LinkedIn page: ${pageId}`);

    try {
      return await this.prisma.$transaction(async (prisma) => {
        const user = await prisma.user.findUnique({
          where: { user_id: userId },
        });
        if (!user) {
          this.logger.error(`User not found: ${userId}`);
          throw new UnauthorizedException('User not found');
        }
        if (user.role !== 'ADMIN') {
          this.logger.error('User is not an admin');
          throw new ForbiddenException('User is not an admin');
        }

        let org = await prisma.organization.findUnique({
          where: { id: 'single-org' },
        });
        if (!org) {
          this.logger.log('Creating new organization: single-org');
          org = await prisma.organization.create({
            data: { id: 'single-org', name: 'ERP Organization' },
          });
        }

        const preferences = await prisma.linkedInPreferences.findUnique({
          where: { orgId: 'single-org' },
        });
        if (!preferences?.signInMethod) {
          this.logger.error('LinkedIn page connection is disabled');
          throw new ForbiddenException('LinkedIn page connection is disabled');
        }

        const isValidUrn = (urn: string) =>
          urn && urn.startsWith('urn:li:digitalmediaAsset:');
        let logoUrl: string | null = null;
        let coverPhotoUrl: string | null = null;

        if (isValidUrn(logoUrn)) {
          logoUrl = await this.resolveMediaUrl(logoUrn, accessToken);
          this.logger.log(
            `Resolved logoUrl for URN ${logoUrn}: ${logoUrl || 'null'}`,
          );
        } else {
          this.logger.warn(`Invalid or missing logo URN: ${logoUrn}`);
        }

        if (isValidUrn(coverPhotoUrn)) {
          coverPhotoUrl = await this.resolveMediaUrl(
            coverPhotoUrn,
            accessToken,
          );
          this.logger.log(
            `Resolved coverPhotoUrl for URN ${coverPhotoUrn}: ${coverPhotoUrl || 'null'}`,
          );
        } else {
          this.logger.warn(
            `Invalid or missing cover photo URN: ${coverPhotoUrn}`,
          );
        }

        this.logger.log(`Input data for page ${pageId}:`, {
          name,
          vanityName,
          logoUrn,
          logoUrl,
          email,
          websiteURL,
          description,
          logo,
          coverPhotoUrn,
          coverPhotoUrl,
          staffCount,
          specialties,
          address,
        });
        // Upsert LinkedInPage
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
        this.logger.log(`LinkedIn page saved successfully: ${pageId}`, page);
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
      this.logger.error(
        `LinkedIn page validation failed: ${error.message}`,
        error.stack,
      );
      throw new Error(`Failed to validate LinkedIn page: ${error.message}`);
    }
  }

  async connectLinkedInPage(userId: string, session: any) {
    this.logger.log(`Connecting LinkedIn page for user ${userId}`);
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
      this.logger.error('LinkedIn page connection is disabled');
      throw new ForbiddenException('LinkedIn page connection is disabled');
    }

    session.linkedinPageUserId = userId;
    this.logger.log(`Set session.linkedinPageUserId: ${userId}`);
    this.logger.log(`LinkedIn page connection initiated for user ${userId}`);
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

    // Clear all session data
    session.linkedinPageUserId = null;
    session.orgProfiles = null;
    session.selectedPageId = null;
    session.accessToken = null;
    session.refreshToken = null;
    this.logger.log(
      `LinkedIn page disconnected and session cleared: ${pageId}`,
    );

    return {
      message: 'LinkedIn page disconnected successfully',
    };
  }

  async getStoredLinkedInPages() {
    this.logger.log(`Fetching stored LinkedIn pages for org single-org`);
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
        createdAt: page.createdAt,
        updatedAt: page.updatedAt,
      }));
    } catch (error: any) {
      this.logger.error(`Failed to fetch LinkedIn pages: ${error.message}`);
      throw new Error('Failed to fetch LinkedIn pages');
    }
  }

  async selectLinkedInPage(userId: string, pageId: string, session: any) {
    this.logger.log(`Selecting LinkedIn page ${pageId} for user ${userId}`);
    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
    });
    if (!user) throw new UnauthorizedException('User not found');
    if (user.role !== 'ADMIN')
      throw new ForbiddenException('User is not an admin');

    const orgProfiles = session.orgProfiles || [];
    if (!orgProfiles.some((p: any) => p.id === pageId)) {
      this.logger.error(`Selected page not found: ${pageId}`);
      throw new Error('Selected page not found');
    }

    session.selectedPageId = pageId;
    this.logger.log(`Set session.selectedPageId: ${pageId}`);

    // Find the selected profile
    const profile = orgProfiles.find((p: any) => p.id === pageId);
    if (!profile) {
      this.logger.error(`Profile not found for pageId: ${pageId}`);
      throw new Error('Selected page profile not found');
    }

    // Call validateLinkedInPage
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
        3600,
        [
          'rw_organization_admin',
          'r_organization_admin',
          'w_organization_social',
          'rw_ads',
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

      // Clear session to prevent stale data
      session.orgProfiles = null;
      session.selectedPageId = null;
      session.accessToken = null;
      session.refreshToken = null;
      session.linkedinPageUserId = null;
      this.logger.log(
        `Page validated and session cleared for pageId: ${pageId}`,
      );

      return { success: true, pageData };
    } catch (error: any) {
      this.logger.error(`Failed to validate page ${pageId}: ${error.message}`);
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
}
