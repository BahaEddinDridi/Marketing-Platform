import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, Profile } from 'passport-microsoft';
import { ConfigService } from '@nestjs/config';
import { AuthService } from 'src/auth/auth.service';

@Injectable()
export class MicrosoftStrategy extends PassportStrategy(Strategy, 'microsoft') {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {
    super({
      clientID: configService.get('MICROSOFT_CLIENT_ID'),
      clientSecret: configService.get('MICROSOFT_CLIENT_SECRET'),
      callbackURL: configService.get('MICROSOFT_REDIRECT_URI'),
      scope: ['openid', 'profile', 'email', 'User.Read', 'Mail.Read', 'offline_access'],
      tenant: 'common',
    });
  }

  async validate(accessToken: string, refreshToken: string, profile: Profile, done: Function) {
    const { id, displayName, emails, _json } = profile;
    const email = emails?.[0]?.value || _json.mail;
    if (!email) return done(new Error('No email found'), null);

    const firstName = _json.givenName || displayName?.split(' ')[0] || '';
    const lastName = _json.surname || displayName?.split(' ')[1] || '';
    const jobTitle = _json.jobTitle || '';
    const phoneNumber = _json.mobilePhone || '';
    const expiresIn = _json.expires_in || 3600;
    const scopes = ['openid', 'profile', 'email', 'User.Read', 'Mail.Read', 'offline_access'];

    try {
      const userData = await this.authService.validateMicrosoftUser(
        id,
        email,
        firstName,
        lastName,
        jobTitle,
        phoneNumber,
        refreshToken,
        accessToken,
        expiresIn,
        scopes,
      );
      return done(null, userData);
    } catch (error) {
      return done(error, null);
    }
  }
}