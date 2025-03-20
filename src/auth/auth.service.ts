import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as bcrypt from 'bcryptjs';
import { JwtService } from '@nestjs/jwt';
import { RegisterDto } from './dto/register.dto';
import { ConfigService } from '@nestjs/config';
import { LoginDto } from './dto/login.dto';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

  async register(registerDto: RegisterDto) {
    const { firstName, lastName, email, password } = registerDto;
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await this.prisma.user.create({
      data: {
        firstName,
        lastName,
        email,
        password: hashedPassword,
        role: 'USER',
      },
    });
    return { message: 'User registered successfully', user };
  }

  async signIn(loginDto: LoginDto) {
    const { email, password } = loginDto;
    const user = await this.prisma.user.findUnique({ where: { email } });

    if (!user) throw new UnauthorizedException('Invalid credentials');

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid)
      throw new UnauthorizedException('Invalid credentials');

    const tokens = await this.generateTokens(user.user_id, user.email);
    await this.saveRefreshToken(user.user_id, tokens.refreshToken);

    return {
      message: 'Login successful',
      user: {
        user_id: user.user_id,
        email: user.email,
      },
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
  }

  async generateTokens(userId: string, email: string) {
    const accessToken = this.jwtService.sign(
      { sub: userId, email },
      {
        secret: process.env.JWT_SECRET,
        expiresIn: '15m',
      },
    );

    const refreshToken = this.jwtService.sign(
      { sub: userId },
      {
        secret: process.env.JWT_REFRESH_SECRET,
        expiresIn: '7d',
      },
    );

    return { accessToken, refreshToken };
  }

  async saveRefreshToken(userId: string, refreshToken: string) {
    const hashedToken = await bcrypt.hash(refreshToken, 10);
    await this.prisma.user.update({
      where: { user_id: userId },
      data: { refreshToken: hashedToken },
    });
  }

  async refreshToken(userId: string, refreshToken: string) {
    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
    });

    if (!user || !user.refreshToken)
      throw new UnauthorizedException('Unauthorized');

    const isValid = await bcrypt.compare(refreshToken, user.refreshToken);
    if (!isValid) throw new UnauthorizedException('Unauthorized');

    const tokens = await this.generateTokens(user.user_id, user.email);
    await this.saveRefreshToken(user.user_id, tokens.refreshToken);

    return tokens;
  }

  async logout(userId: string) {
    try {
      await this.prisma.user.update({
        where: { user_id: userId },
        data: { refreshToken: null },
      });
    } catch (error) {
      throw new Error('Failed to logout user');
    }
  }

  async validateGoogleUser(googleId: string, email: string, firstName: string) {
    let user = await this.prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      user = await this.prisma.user.create({
        data: {
          googleId,
          email,
          firstName,
          lastName: '',
          password: '',
          role: 'USER',
        },
      });
    }

    return this.generateTokens(user.user_id, user.email);
  }
}
