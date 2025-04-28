import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-linkedin-oauth2';
import { ConfigService } from '@nestjs/config';
import { AuthService } from 'src/auth/auth.service';

@Injectable()
export class LinkedInStrategy extends PassportStrategy(Strategy, 'linkedin') {
  private readonly logger = new Logger(LinkedInStrategy.name);

  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {
    super({
      clientID: configService.get('LINKEDIN_CLIENT_ID'),
      clientSecret: configService.get('LINKEDIN_CLIENT_SECRET'),
      callbackURL: configService.get('LINKEDIN_REDIRECT_URI'),
      scope: ['openid', 'profile', 'email', 'w_member_social'],
      state: true,
    });
  }

  async validate(
    req: any,
    accessToken: string,
    refreshToken: string,
    profile: any,
    done: Function,
  ) {
    this.logger.log(`Validating LinkedIn user: ${profile.emails?.[0]?.value || profile.id}`);

    try {
      const linkedinId = profile.id;
      const email = profile.emails?.[0]?.value || '';
      const scopes = profile.scopes || ['openid', 'profile', 'email'];
      const expiresIn = profile.expires_in || 60 * 60 * 24 * 60;

      let stateObj: { type: 'page' | 'user'; userId?: string };
      try {
        stateObj = JSON.parse(req.query.state);
      } catch (error) {
        this.logger.error(`Invalid state parameter: ${req.query.state}`);
        return done(new UnauthorizedException('Invalid state parameter'), null);
      }

      const isOrgPage = !!profile._json?.organizationalTarget || !!profile._json?.localizedName;
      const userId = isOrgPage ? null : (stateObj.userId ?? null); 
      this.logger.log(`Validating LinkedIn userId: ${userId}`);
      this.logger.log(`Validating LinkedIn stateObj: ${stateObj}`);

      if (!userId && !isOrgPage) {
        this.logger.error('No user ID provided for user LinkedIn connection');
        return done(new UnauthorizedException('User ID required'), null);
      }

      await this.authService.updateLinkedInCredentials(
        linkedinId,
        isOrgPage ? profile._json?.localizedName || 'Innoway Solutions' : email,
        accessToken,
        refreshToken || null,
        expiresIn,
        scopes,
        'AUTH',
        userId,
      );

      const result = {
        linkedinId,
        email,
        userId,
        isOrgPage,
      };

      this.logger.log(`LinkedIn ${isOrgPage ? 'page' : 'user'} validated: ${linkedinId}`);
      return done(null, result);
    } catch (error) {
      this.logger.error(
        `LinkedIn validation failed: ${error.message}`,
        error.stack,
      );
      return done(error, null);
    }
  }
}