import {
  BadRequestException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { UpdateUserDto } from './dto/update-user.dto';
import * as bcrypt from 'bcryptjs';
import { v2 as cloudinary } from 'cloudinary';
import { Status } from '@prisma/client';
import * as nodemailer from 'nodemailer';

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
        password: true,
      },
    });

    if (!user || !user.password)
      throw new UnauthorizedException('Invalid credentials');

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Incorrect password');
    }

    await this.prisma.user.delete({
      where: { user_id: userId },
    });

    return { message: 'Account deleted successfully' };
  }

  async activateDeactivateUser(
    requesterId: string,
    userId: string,
    status: Status,
  ) {
    console.log(`User ${userId} status changed to ${status} by ${requesterId}`);
    const requester = await this.prisma.user.findUnique({
      where: { user_id: requesterId },
      select: { role: true },
    });

    if (!requester) {
      throw new NotFoundException('Requester not found');
    }

    if (requester.role !== 'ADMIN') {
      throw new UnauthorizedException(
        'Only admins can activate or deactivate users',
      );
    }

    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
      select: { user_id: true, email: true, status: true },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (user.status === status) {
      throw new BadRequestException(`User is already ${status}`);
    }

    const updatedUser = await this.prisma.user.update({
      where: { user_id: userId },
      data: {
        status,
        refreshToken: status === 'SUSPENDED' ? null : undefined, // Clear refresh token if suspended
        updated_at: new Date(),
      },
    });

    // Send email notification
    const transporter = nodemailer.createTransport({
      service: 'Gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    const statusText = status === 'ACTIVE' ? 'activated' : 'deactivated';
    const htmlTemplate = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Account Status Update</title>
        <style>
          body { font-family: Arial, sans-serif; background-color: #f4f4f4; margin: 0; padding: 0; }
          .container { max-width: 600px; margin: 20px auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 5px rgba(0,0,0,0.1); }
          .header { background-color: #1e40af; color: white; text-align: center; padding: 20px; }
          .content { padding: 20px; color: #333; }
          .footer { text-align: center; padding: 10px; font-size: 12px; color: #666; background-color: #f4f4f4; }
          @media (max-width: 600px) { .container { width: 100% !important; margin: 0; border-radius: 0; } .content { padding: 10px; } }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Marketing Dashboard</h1>
          </div>
          <div class="content">
            <p>Hello,</p>
            <p>Your account has been ${statusText}.</p>
            <p>${
              status === 'ACTIVE'
                ? 'You can now log in to the Marketing Dashboard.'
                : 'You have been logged out and can no longer access the Marketing Dashboard. Contact your administrator for assistance.'
            }</p>
          </div>
          <div class="footer">
            <p>&copy; 2025 Marketing Dashboard. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    await transporter.sendMail({
      from: `"Marketing" <${process.env.EMAIL_USER}>`,
      to: user.email,
      subject: `Account ${statusText.charAt(0).toUpperCase() + statusText.slice(1)}`,
      html: htmlTemplate,
    });

    return {
      user_id: updatedUser.user_id,
      status: updatedUser.status,
      message: `User ${statusText} successfully`,
    };
  }

  async usersInvite(requesterId: string, emails: string[]) {
    // Validate requester is admin
    const requester = await this.prisma.user.findUnique({
      where: { user_id: requesterId },
      select: { role: true },
    });

    if (!requester) {
      throw new NotFoundException('Requester not found');
    }

    if (requester.role !== 'ADMIN') {
      throw new UnauthorizedException('Only admins can invite users');
    }

    // Validate email array
    if (!emails || !Array.isArray(emails) || emails.length === 0) {
      throw new BadRequestException('A non-empty array of emails is required');
    }
    // Send invitation emails
    const transporter = nodemailer.createTransport({
      service: 'Gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    const signUpUrl = 'http://localhost:3000/signup'; // Replace with your actual sign-up URL
    const htmlTemplate = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Invitation to Join Marketing Dashboard</title>
        <style>
          body { font-family: Arial, sans-serif; background-color: #f4f4f4; margin: 0; padding: 0; }
          .container { max-width: 600px; margin: 20px auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 5px rgba(0,0,0,0.1); }
          .header { background-color: #1e40af; color: white; text-align: center; padding: 20px; }
          .content { padding: 20px; color: #333; }
          .button { display: inline-block; padding: 10px 20px; background-color: #1e40af; color: white; text-decoration: none; border-radius: 5px; font-size: 16px; margin-top: 20px; }
          .button:hover { background-color: #1d4ed8; }
          .footer { text-align: center; padding: 10px; font-size: 12px; color: #666; background-color: #f4f4f4; }
          @media (max-width: 600px) { .container { width: 100% !important; margin: 0; border-radius: 0; } .content { padding: 10px; } }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Marketing Dashboard</h1>
          </div>
          <div class="content">
            <p>Hello,</p>
            <p>You have been invited to join the Marketing Dashboard. Click the button below to sign up and get started:</p>
            <a href="${signUpUrl}" class="button">Join Now</a>
            <p>If you have any questions, please contact your administrator.</p>
          </div>
          <div class="footer">
            <p>&copy; 2025 Marketing Dashboard. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;

    // Send emails to all invitees
    const sendEmailPromises = emails.map((email) =>
      transporter.sendMail({
        from: `"Marketing" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: 'Invitation to Join Marketing Dashboard',
        html: htmlTemplate,
      }),
    );

    await Promise.all(sendEmailPromises);

    return {
      message: `Invitations sent successfully to ${emails.length} user(s)`,
      invitedEmails: emails,
    };
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
  async getNotificationPreferences(userId: string) {
    const preferences = await this.prisma.notificationPreference.findUnique({
      where: { userId },
    });

    if (!preferences) {
      throw new NotFoundException('Notification preferences not found');
    }

    return preferences;
  }

  async updateNotificationPreferences(
    userId: string,
    requesterId: string,
    preferences: {
      receiveNewLead?: boolean;
      receiveCampaignLaunched?: boolean;
      receiveCampaignPaused?: boolean;
      receiveCampaignFailed?: boolean;
      receivePerformanceAlert?: boolean;
      receiveBudgetAlert?: boolean;
      receiveSyncSuccess?: boolean;
      receiveSyncFailure?: boolean;
    },
  ) {
    if (userId !== requesterId) {
      throw new UnauthorizedException(
        'You can only update your own notification preferences',
      );
    }
    const updatedPreferences = await this.prisma.notificationPreference.upsert({
      where: { userId },
      update: preferences,
      create: {
        userId,
        ...preferences,
      },
    });
    return updatedPreferences;
  }
}
