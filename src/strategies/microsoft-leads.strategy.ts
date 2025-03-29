import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, Profile } from 'passport-microsoft';
import { ConfigService } from '@nestjs/config';
import { AuthService } from 'src/auth/auth.service';

@Injectable()
export class MicrosoftLeadsStrategy extends PassportStrategy(Strategy, 'microsoft-leads') {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {
    super({
      clientID: configService.get('MICROSOFT_CLIENT_ID'),
      clientSecret: configService.get('MICROSOFT_CLIENT_SECRET'),
      callbackURL: configService.get('MICROSOFT_LEADS_REDIRECT_URI'),
      scope: ['mail.read', 'offline_access'],
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
    const { id, emails, _json } = profile;
    const email = emails?.[0]?.value || _json.mail || null;
    const expiresIn = req.authInfo?.expires_in || 3600;
    const scopes = ['mail.read', 'offline_access'];
    const userId = req.user?.user_id || id;
    console.log("userId", userId)
    // Update PlatformCredentials only—no app auth
    await this.authService.updateMicrosoftCredentials(id, email, refreshToken, accessToken, expiresIn, scopes);

    // Return user from existing session (JWT), not new tokens
    const user = req.user || { microsoftId: id, email };
    return done(null, user);
  }
}