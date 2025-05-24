import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-linkedin-oauth2';
import { LinkedInService } from 'src/auth/linkedIn/linkedIn.service';
import { LinkedInAuthConfigService } from 'src/middlewares/linkedIn/linkedin-auth-config.service';
import { PrismaService } from 'src/prisma/prisma.service';
import axios from 'axios';

interface LinkedInUserInfo {
  email: string;
  sub: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
  locale?: string;
  email_verified?: boolean;
}

interface LinkedInOrgAcl {
  organization: string; // URN like urn:li:organization:123456
  role: string; // e.g., ADMINISTRATOR, CONTENT_ADMIN, etc.
}

interface LinkedInOrgResponse {
  elements: LinkedInOrgAcl[];
}

interface LinkedInPageInfo {
  id: number;
  localizedName: string;
  vanityName?: string;
  website?: {
    localized: { en_US: string };
    preferredLocale: { country: string; language: string };
  };
  description?: {
    localized: { en_US: string };
    preferredLocale: { country: string; language: string };
  };
  logoV2?: {
    cropped: string;
    original: string;
    cropInfo: { x: number; width: number; y: number; height: number };
  };
  coverPhotoV2?: {
    cropped: string;
    original: string;
    cropInfo: { x: number; width: number; y: number; height: number };
  };
  staffCountRange?: string;
  localizedSpecialties?: string[];
  locations?: Array<{
    locationType: string;
    address: { country: string; city: string };
    geoLocation: string;
    streetAddressFieldState: string;
  }>;
}

@Injectable()
export class LinkedInPageStrategy extends PassportStrategy(
  Strategy,
  'linkedin-page',
) {
  private readonly logger = new Logger(LinkedInPageStrategy.name);

  constructor(
    private readonly linkedInService: LinkedInService,
    private readonly config: LinkedInAuthConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      clientID: config.clientID,
      clientSecret: config.clientSecret,
      callbackURL: 'http://localhost:5000/auth/linkedin-page/callback',
      scope: [
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
      passReqToCallback: true,
    });
  }

  async userProfile(accessToken: string, done: Function) {
    try {
      // Log access token for debugging
      this.logger.log(`Access token: ${accessToken}`);

      // Fetch user profile for context
      const userResponse = await axios.get<LinkedInUserInfo>(
        'https://api.linkedin.com/v2/userinfo',
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        },
      );

      const userData = userResponse.data;
      if (!userData.email) {
        this.logger.error('No email found in LinkedIn user profile');
        return done(new Error('No email found in LinkedIn user profile'), null);
      }

      // Fetch organizations the user can manage
      const orgResponse = await axios.get<LinkedInOrgResponse>(
        'https://api.linkedin.com/v2/organizationAcls?q=roleAssignee',
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'LinkedIn-Version': '202408',
          },
        },
      );

      this.logger.log(`Org ACLs response: ${JSON.stringify(orgResponse.data)}`);

      const orgAcls = orgResponse.data.elements || [];
      if (!orgAcls.length) {
        this.logger.error('No LinkedIn pages found for user');
        return done(new Error('No LinkedIn pages found'), null);
      }

      const orgProfiles = await Promise.all(
        orgAcls.map(async (acl) => {
          const orgUrn = acl.organization;
          const orgId = orgUrn.split(':').pop();

          const orgDetailsResponse = await axios.get<LinkedInPageInfo>(
            `https://api.linkedin.com/v2/organizations/${orgId}`,
            {
              headers: {
                Authorization: `Bearer ${accessToken}`,
                'LinkedIn-Version': '202411',
              },
            },
          );

          const pageData = orgDetailsResponse.data;
          return {
            provider: 'linkedin-page',
            id: String(pageData.id),
            displayName: pageData.localizedName || '',
            emails: [{ value: userData.email }],
            photos: [{ value: pageData.logoV2?.cropped || '' }],
            _json: {
              pageId: String(pageData.id),
              name: pageData.localizedName,
              vanityName: pageData.vanityName || '',
              logoUrl: pageData.logoV2?.cropped || '',
              userEmail: userData.email,
              websiteURL: pageData.website?.localized?.en_US || '',
              description: pageData.description?.localized?.en_US || '',
              logo: pageData.logoV2 || null,
              coverPhoto: pageData.coverPhotoV2 || null,
              staffCount: pageData.staffCountRange || '',
              specialties: pageData.localizedSpecialties || [],
              address: pageData.locations?.[0]
                ? {
                    country: pageData.locations[0].address.country,
                    city: pageData.locations[0].address.city,
                    geoLocation: pageData.locations[0].geoLocation,
                    streetAddressFieldState:
                      pageData.locations[0].streetAddressFieldState,
                  }
                : null,
            },
            _raw: JSON.stringify(pageData),
          };
        }),
      );

      done(null, { orgProfiles, accessToken });
    } catch (error: any) {
      this.logger.error(
        `Failed to fetch page profile: ${error.message}`,
        error.response?.data,
      );
      done(new Error('Failed to fetch page profile'), null);
    }
  }

  async validate(
    req: any,
    accessToken: string,
    refreshToken: string,
    profile: any,
    done: Function,
  ) {
    const userId = req.session.linkedinPageUserId;
    if (!userId) {
      this.logger.error('No user ID found in session');
      return done(
        new UnauthorizedException('No authenticated user found'),
        null,
      );
    }

    // Store profile data in session
    const expiresIn = profile.expires_in || 5184000;
    req.session.orgProfiles = profile.orgProfiles;
    req.session.accessToken = accessToken;
    req.session.refreshToken = refreshToken;
    req.session.expiresIn = expiresIn;
    this.logger.log('Stored orgProfiles in session:', req.session.orgProfiles);

    return done(null, { redirect: '/select-page' });
  }
}
