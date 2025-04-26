import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, Profile } from 'passport-microsoft';
import { ConfigService } from '@nestjs/config';
import { AuthService } from 'src/auth/auth.service';
import { PrismaService } from 'src/prisma/prisma.service';

@Injectable()
export class MicrosoftStrategy extends PassportStrategy(Strategy, 'microsoft') {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      clientID: configService.get('MICROSOFT_CLIENT_ID'),
      clientSecret: configService.get('MICROSOFT_CLIENT_SECRET'),
      callbackURL: configService.get('MICROSOFT_REDIRECT_URI'),
      scope: ['openid', 'profile', 'email', 'User.Read', 'offline_access'],
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
    const scopes = ['openid', 'profile', 'email', 'User.Read', 'offline_access'];

    const org = await this.prisma.organization.findUnique({
      where: { id: 'single-org' },
    });

    if (org) {
      // Organization exists, check preferences
      const preferences = await this.prisma.microsoftPreferences.findUnique({
        where: { orgId: 'single-org' },
      });
      if (!preferences?.signInMethod) {
        const user = await this.prisma.user.findUnique({ where: { microsoftId: id } });
        if (!user || user.role !== 'ADMIN') {
          console.log(`Microsoft sign-in disabled for non-admin user: ${email}`);
          return done(new UnauthorizedException('Microsoft Sign-in Method is disabled'), null);
        }
      }
    } else {
      // No organization exists, allow sign-in to create it
      console.log(`No organization found, allowing first Microsoft sign-in for ${email}`);
    }
    
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