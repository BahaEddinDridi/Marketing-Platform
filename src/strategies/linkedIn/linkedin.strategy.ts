import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, Profile } from 'passport-linkedin-oauth2';
import { LinkedInService } from 'src/auth/linkedIn/linkedIn.service';
import { LinkedInAuthConfigService } from 'src/middlewares/linkedIn/linkedin-auth-config.service';
import { PrismaService } from 'src/prisma/prisma.service';
import axios from 'axios';

interface LinkedInUserInfo {
  sub: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  picture?: string;
  locale?: string;
  email?: string;
  email_verified?: boolean;
}

@Injectable()
export class LinkedInStrategy extends PassportStrategy(Strategy, 'linkedin') {
  private readonly logger = new Logger(LinkedInStrategy.name);

  constructor(
    private readonly linkedInService: LinkedInService,
    private readonly config: LinkedInAuthConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      clientID: config.clientID,
      clientSecret: config.clientSecret,
      callbackURL: 'http://localhost:5000/auth/linkedin/callback',
      scope: ['profile', 'email', 'openid'],
      passReqToCallback: true,
    });
  }

  async userProfile(accessToken: string, done: Function) {
    try {
      const response = await axios.get<LinkedInUserInfo>(
        'https://api.linkedin.com/v2/userinfo',
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        },
      );

      const profileData = response.data;
      if (!profileData.email) {
        this.logger.error('No email found in LinkedIn profile');
        return done(new Error('No email found in LinkedIn profile'), null);
      }

      const profile: Profile = {
        provider: 'linkedin',
        id: profileData.sub,
        displayName: profileData.name || '',
        name: {
          // Add the required 'name' property
          givenName: profileData.given_name || '',
          familyName: profileData.family_name || '',
        },
        emails: [{ value: profileData.email }],
        photos: [
          {
            // Add the required 'photos' property
            value: profileData.picture || '',
          },
        ],
        _json: {
          given_name: profileData.given_name || '',
          family_name: profileData.family_name || '',
          picture: profileData.picture || '',
          locale: profileData.locale || '',
          email_verified: profileData.email_verified || false,
        },
        _raw: JSON.stringify(profileData), // Add the required '_raw' property
      };
      done(null, profile);
    } catch (error: any) {
      this.logger.error(`Failed to fetch user profile: ${error.message}`);
      done(new Error('Failed to fetch user profile'), null);
    }
  }

  async validate(
    req: any,
    accessToken: string,
    refreshToken: string,
    profile: Profile,
    done: Function,
  ) {
    const user = req.user;

    const { id, displayName, emails, _json } = profile;
    const email = emails?.[0]?.value;
    if (!email) {
      this.logger.error('No email found in LinkedIn profile');
      return done(new Error('No email found'), null);
    }

    const firstName = _json.given_name || displayName?.split(' ')[0] || '';
    const lastName = _json.family_name || displayName?.split(' ')[1] || '';
    const jobTitle = '';
    const profileUrl = _json.picture || '';
    const expiresIn = 3600;
    const scopes = ['profile', 'email', 'openid'];

    try {
      const userId = req.session.linkedinUserId;
      console.log('User ID from session:', req.session);
      if (!userId) {
        this.logger.error('No user ID found in session');
        return done(
          new UnauthorizedException('No authenticated user found'),
          null,
        );
      }
      const userData = await this.linkedInService.validateLinkedInUser(
        userId,
        id,
        email,
        firstName,
        lastName,
        jobTitle,
        accessToken,
        refreshToken,
        expiresIn,
        scopes,
        profileUrl,
      );
      this.logger.log(
        `LinkedInStrategy validate success: ${JSON.stringify(userData)}`,
      );
      delete req.session.linkedinUserId;
      return done(null, userData.user);
    } catch (error: any) {
      this.logger.error(
        `LinkedInStrategy validate error: ${error.message}`,
        error.stack,
      );
      return done(error, null);
    }
  }
}
