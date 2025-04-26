import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, Profile } from 'passport-microsoft';
import { ConfigService } from '@nestjs/config';
import { AuthService } from '../auth/auth.service'; // Adjust path

@Injectable()
export class MicrosoftLeadsStrategy extends PassportStrategy(Strategy, 'microsoft-leads') {
  constructor(
    private readonly configService: ConfigService,
    private readonly authService: AuthService,
  ) {
    super({
      clientID: configService.get('MICROSOFT_CLIENT_ID'),
      clientSecret: configService.get('MICROSOFT_CLIENT_SECRET'),
      callbackURL: configService.get('MICROSOFT_LEADS_REDIRECT_URI'),
      scope: ['mail.read', 'user.read', 'offline_access'],
      tenant: 'common',
      authorizationURL: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
      tokenURL: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    });
  }

  async validate(
    accessToken: string,
    refreshToken: string,
    profile: Profile,
    done: Function,
  ) {
    try {
      if (!done || typeof done !== 'function') {
        console.error('MicrosoftLeadsStrategy: done callback is not a function', done);
        throw new Error('Invalid Passport callback');
      }

      const { id, emails, _json } = profile;
      const email = emails?.[0]?.value || _json?.mail || _json?.email || null;
      if (!email) {
        console.error('MicrosoftLeadsStrategy: No email found in profile', profile);
        return done(new Error('No email provided by Microsoft'), null);
      }

      const expiresIn = _json?.expires_in || 3600;
      const scopes = ['mail.read', 'user.read', 'offline_access'];

      await this.authService.updateMicrosoftCredentials(
        id,
        email,
        accessToken,
        refreshToken || null,
        expiresIn,
        scopes,
        'LEADS',
      );

      return done(null, { microsoftId: id, email });
    } catch (error) {
      console.error('MicrosoftLeadsStrategy validate error:', error);
      return done(error, null);
    }
  }
}