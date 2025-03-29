import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, Profile } from 'passport-microsoft';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

interface GraphUserResponse {
  displayName: string;
  mail: string;
  userPrincipalName: string;
}

@Injectable()
export class MicrosoftTestStrategy extends PassportStrategy(Strategy, 'microsoft-test') {
  constructor(private readonly configService: ConfigService) {
    super({
      clientID: configService.get('MICROSOFT_CLIENT_ID'),
      clientSecret: configService.get('MICROSOFT_CLIENT_SECRET'),
      callbackURL: 'http://localhost:5000/auth/microsoft/test/callback',
      scope: ['User.Read'], // Minimal scope
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
    console.log('MicrosoftTestStrategy: Validating', { accessToken });

    try {
      const response = await axios.get<GraphUserResponse>(
        'https://graph.microsoft.com/v1.0/me',
        {
          headers: { Authorization: `Bearer ${accessToken}` },
        },
      );
      const userInfo = response.data;
      console.log('MicrosoftTestStrategy: User info fetched:', userInfo);

      const user = {
        microsoftId: profile.id,
        email: profile.emails?.[0]?.value || profile._json.mail || null,
        userInfo,
      };
      return done(null, user);
    } catch (error) {
      console.error('MicrosoftTestStrategy: Error fetching user info:', error.message, error.response?.data);
      return done(null, { error: error.message }); // Pass error in user object
    }
  }
}