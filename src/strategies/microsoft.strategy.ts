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
      scope: ['user.read', 'mail.read'], 
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
    const { id, displayName, emails } = profile;
    const email = emails?.[0]?.value || profile._json.mail || null; 
    const expiresIn = req.authInfo?.expires_in || 3600; 

    const userData = await this.authService.validateMicrosoftUser(
      id,
      email,
      displayName,
      refreshToken,
      accessToken,
      expiresIn,
    );

    return done(null, {
      user: userData.user,
      tokens: userData.tokens,
      microsoftAccessToken: accessToken,
      microsoftRefreshToken: refreshToken,
      expiresIn, 
    });
  }
}