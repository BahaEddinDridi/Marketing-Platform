import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { UpdateUserDto } from './dto/update-user.dto';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async getUserProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
      select: {
        user_id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        phoneNumber: true,
        birthdate: true,
        occupation: true,
        street: true,
        city: true,
        state: true,
        zipCode: true,
        country: true,
      },
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async updateUser(
    userId: string,
    requesterId: string,
    updateData: UpdateUserDto,
  ) {
     if (userId !== requesterId) {
       throw new UnauthorizedException('You can only update your own profile');
     }

    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const updatedUser = await this.prisma.user.update({
      where: { user_id: userId },
      data: {
        firstName: updateData.firstName,
        lastName: updateData.lastName,
        phoneNumber: updateData.phoneNumber,
        street: updateData.street,
        city: updateData.city,
        state: updateData.state,
        zipCode: updateData.zipCode,
        country: updateData.country,
        birthdate: updateData.birthdate
          ? new Date(updateData.birthdate)
          : undefined,
        occupation: updateData.occupation,
        updated_at: new Date(),
      },
    });

    return {
      user_id: updatedUser.user_id,
      firstName: updatedUser.firstName,
      lastName: updatedUser.lastName,
      email: updatedUser.email,
      phoneNumber: updatedUser.phoneNumber,
      street: updatedUser.street,
      city: updatedUser.city,
      state: updatedUser.state,
      zipCode: updatedUser.zipCode,
      country: updatedUser.country,
      birthdate: updatedUser.birthdate,
      occupation: updatedUser.occupation,
    };
  }

  async deleteUser(userId: string, requesterId: string) {
    if (userId !== requesterId) {
      throw new UnauthorizedException('You can only delete your own account');
    }

    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    await this.prisma.user.delete({
      where: { user_id: userId },
    });

    return { message: 'Account deleted successfully' };
  }
}
