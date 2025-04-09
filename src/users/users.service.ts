import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { UpdateUserDto } from './dto/update-user.dto';
import * as bcrypt from 'bcryptjs';
import { v2 as cloudinary } from 'cloudinary';

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
        profileImage: true,
        allowPersonalEmailSync: true,
      },
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async updateUser(
    userId: string,
    requesterId: string,
    updateData: UpdateUserDto,
    file?: Express.Multer.File,
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
    let imageUrl: string | undefined;
    if (file) {
      const uploadResult = await new Promise<any>((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          {
            folder: 'user_profiles',
            public_id: `${userId}_${Date.now()}`,
            resource_type: 'image',
          },
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          },
        );
        stream.end(file.buffer);
      });
      imageUrl = uploadResult.secure_url;
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
        profileImage: imageUrl || user.profileImage,
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
      profileImage: updatedUser.profileImage,
    };
  }

  async deleteUser(userId: string, requesterId: string, password: string) {
    if (userId !== requesterId) {
      throw new UnauthorizedException('You can only delete your own account');
    }

    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
      select: { 
        user_id: true,
        password: true 
      }
    });
  
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Incorrect password');
    }
    
    await this.prisma.user.delete({
      where: { user_id: userId },
    });

    return { message: 'Account deleted successfully' };
  }


  async getProfileCompletionPercentage(userId: string): Promise<number> {
    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
      select: {
        firstName: true,
        lastName: true,
        phoneNumber: true,
        street: true,
        city: true,
        state: true,
        zipCode: true,
        country: true,
        birthdate: true,
        occupation: true,
        profileImage: true,
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const fields = [
      user.firstName,
      user.lastName,
      user.phoneNumber,
      user.street,
      user.city,
      user.state,
      user.country,
      user.birthdate,
      user.occupation,
    ];

    const totalFields = fields.length;
    const filledFields = fields.filter((field) => {
      return field !== null && field !== undefined && field !== '';
    }).length;

    const completionPercentage = (filledFields / totalFields) * 100;
    return Math.round(completionPercentage);
  }

  async updateAllowPersonalEmailSync(
    userId: string,
    requesterId: string,
    allowSync: boolean,
  ) {
    const requester = await this.prisma.user.findUnique({
      where: { user_id: requesterId },
      select: { role: true },
    });
  
    if (!requester) {
      throw new UnauthorizedException('Requester not found');
    }
  
    const isSelf = userId === requesterId;
    const isAdmin = requester.role === 'ADMIN';
  
    if (!isSelf && !isAdmin) {
      throw new UnauthorizedException('Not authorized to update this setting');
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
        allowPersonalEmailSync: allowSync,
        updated_at: new Date(),
      },
    });
  
    return {
      user_id: updatedUser.user_id,
      allowPersonalEmailSync: updatedUser.allowPersonalEmailSync,
    };
  }
  
}
