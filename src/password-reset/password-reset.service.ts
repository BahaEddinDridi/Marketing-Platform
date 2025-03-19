import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JwtService } from '@nestjs/jwt';
import * as nodemailer from 'nodemailer';
import * as bcrypt from 'bcrypt';

@Injectable()
export class PasswordResetService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
  ) {}

  async sendResetLink(email: string) {
    // Find user
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) {
      throw new BadRequestException('User not found');
    }

    // Generate JWT token
    const token = this.jwtService.sign(
      { userId: user.user_id },
      { secret: process.env.JWT_SECRET, expiresIn: '1h' },
    );

    // Store token in database
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); 
    await this.prisma.passwordResetToken.create({
      data: {
        token,
        user_id: user.user_id,
        expiresAt,
      },
    });

    // Send email
    const transporter = nodemailer.createTransport({
      service: 'Gmail',
      auth: {
        user: process.env.EMAIL_USER, 
        pass: process.env.EMAIL_PASS, 
      },
    });

    const resetLink = `http://localhost:3000/reset-password?token=${token}`; 
    const htmlTemplate = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Password Reset Request</title>
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
            <p>We received a request to reset your password. Click the button below to create a new password:</p>
            <a href="${resetLink}" class="button">Reset Your Password</a>
            <p>This link will expire in 1 hour. If you didn’t request this, please ignore this email.</p>
          </div>
          <div class="footer">
            <p>&copy; 2025 Marketing Dashboard. All rights reserved.</p>
          </div>
        </div>
      </body>
      </html>
    `;
    await transporter.sendMail({
      from: '"Marketing" <${process.env.EMAIL_USER}>',
      to: email,
      subject: 'Password Reset Request',
      html: htmlTemplate,
    });

    return { message: 'Reset link sent successfully' };
  }

  async resetPassword(token: string, newPassword: string) {
    const resetToken = await this.prisma.passwordResetToken.findUnique({
      where: { token },
    });
    if (!resetToken || resetToken.expiresAt < new Date()) {
      throw new BadRequestException('Invalid or expired token');
    }

    const payload = this.jwtService.verify(token, { secret: process.env.JWT_SECRET });
    if (!payload.userId) {
      throw new BadRequestException('Invalid token');
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await this.prisma.user.update({
      where: { user_id: resetToken.user_id },
      data: { password: hashedPassword },
    });

    await this.prisma.passwordResetToken.delete({ where: { id: resetToken.id } });

    return { message: 'Password reset successfully' };
  }
}