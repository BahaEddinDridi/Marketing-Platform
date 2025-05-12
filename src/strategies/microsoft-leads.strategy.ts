import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, Profile } from 'passport-microsoft';
import { AuthService } from '../auth/auth.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { MicrosoftOAuthConfig } from './microsoft-auth-config.service';

@Injectable()
export class MicrosoftLeadsStrategy extends PassportStrategy(
  Strategy,
  'microsoft-leads',
) {
  constructor(
    private readonly authService: AuthService,
    private readonly config: MicrosoftOAuthConfig,
    private readonly prisma: PrismaService,
  ) {
    super({
      clientID: config.clientID,
      clientSecret: config.clientSecret,
      callbackURL: 'http://localhost:5000/auth/microsoft/leads/callback',
      scope: ['mail.read', 'mail.send', 'user.read', 'offline_access'],
      tenant: config.tenantID || 'common',
      authorizationURL: `https://login.microsoftonline.com/${config.tenantID}/oauth2/v2.0/authorize`,
      tokenURL: `https://login.microsoftonline.com/${config.tenantID}/oauth2/v2.0/token`,
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
        console.error(
          'MicrosoftLeadsStrategy: done callback is not a function',
          done,
        );
        throw new Error('Invalid Passport callback');
      }

      const { id, emails, _json } = profile;
      const email = emails?.[0]?.value || _json?.mail || _json?.email || null;
      if (!email) {
        console.error(
          'MicrosoftLeadsStrategy: No email found in profile',
          profile,
        );
        return done(new Error('No email provided by Microsoft'), null);
      }

      const expiresIn = _json?.expires_in || 3600;
      const scopes = ['mail.read', 'mail.send', 'user.read', 'offline_access'];

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
