import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as bcrypt from 'bcryptjs';
import { JwtService } from '@nestjs/jwt';
import { RegisterDto } from './dto/register.dto';

@Injectable()
export class AuthService {
  constructor(private prisma: PrismaService, private jwtService: JwtService) {}

  async register(registerDto: RegisterDto) {
    const { firstname, lastname, email, password } = registerDto;
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await this.prisma.user.create({
      data: {
        firstname,
        lastname,
        email,
        password: hashedPassword,
        role: 'user',
      },
    });

    return { message: 'User registered successfully', user };
  }
}
