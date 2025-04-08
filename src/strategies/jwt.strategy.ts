import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors([
        (req) => {
          const token = req?.cookies?.accessToken;
          return token;
        },
      ]),
      secretOrKey: configService.get<string>('JWT_SECRET'),
      ignoreExpiration: false, // Ensure token expiration is checked
    });
  }

  async validate(payload: { sub: string; email: string; orgId: string }) {
    const user = await this.prisma.user.findUnique({
      where: { user_id: payload.sub },
    });
    if (!user) {
      throw new Error('User not found');
    }
    // Return user_id, email, and orgId to match AuthenticatedRequest
    return { user_id: user.user_id, email: user.email, orgId: user.orgId };
  }
}