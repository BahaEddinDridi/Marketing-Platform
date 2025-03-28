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
      scope: ['user.read', 'offline_access'], 
      tenant: 'common',
      passReqToCallback: true, 
    });
  }

  async validate(
    req: any,
    accessToken: string,
    refreshToken: string,
    profile: Profile,
    done: Function,
  ) {
    const { id, displayName, emails, _json } = profile;
    const email = emails?.[0]?.value || profile._json.mail || null; 
    const firstName = _json.givenName || displayName?.split(' ')[0] || null;
    const lastName = _json.surname || displayName?.split(' ')[1] || null;
    const jobTitle = _json.jobTitle || null;
    const phoneNumber = _json.mobilePhone || null;
    const expiresIn = req.authInfo?.expires_in || 3600; 
    const scopes = ['user.read', 'offline_access'];
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

    return done(null, {
      user: userData.user,
      tokens: userData.tokens,
    });
  }
}