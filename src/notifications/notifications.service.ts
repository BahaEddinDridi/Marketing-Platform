import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { NotificationPreference } from '@prisma/client';
import { NotificationsGateway } from 'src/middlewares/notifications.gateway';
import { PrismaService } from 'src/prisma/prisma.service';

// src/types/notification.interface.ts
export interface Notification {
  id: string;
  userId: string;
  title: string;
  message: string;
  type: string;
  actionUrl?: string | null;
  isCritical: boolean;
  meta?: any; // Prisma Json type, can be refined if specific structure is known
  seen: boolean;
  createdAt: Date;
  readAt?: Date | null;
}

@Injectable()
export class NotificationsService {
    private readonly logger = new Logger(NotificationsService.name);
  
  constructor(
    private prisma: PrismaService,
    private socketGateway: NotificationsGateway,
  ) {}

  async notifyUsersOfOrg(
    orgId: string,
    preferenceKey: keyof NotificationPreference,
    data: {
      title: string;
      message: string;
      type?: string;
      actionUrl?: string;
      isCritical?: boolean;
      meta?: any;
    },
  ) {
    const users = await this.prisma.user.findMany({
      where: {
        orgId: orgId,
        notificationPreference: {
          [preferenceKey]: true,
        },
      },
      include: {
        notificationPreference: true,
      },
    });

    for (const user of users) {
      const notification = await this.prisma.notification.create({
        data: {
          userId: user.user_id,
          title: data.title,
          message: data.message,
          type: data.type || 'info',
          actionUrl: data.actionUrl,
          isCritical: data.isCritical || false,
          meta: data.meta,
        },
      });

      this.socketGateway.sendNotification(user.user_id, notification);
    }
  }

  async createNotification(data: any) {
    return await this.prisma.notification.create({
      data: {
        userId: data.userId,
        title: data.title,
        message: data.message,
        type: data.type,
        actionUrl: data.actionUrl,
        isCritical: data.isCritical ?? false,
        meta: data.meta ?? {},
        seen: false,
      },
    });
  }

  async markAsSeen(id: string) {
    const notif = await this.prisma.notification.findUnique({ where: { id } });

    if (!notif) throw new NotFoundException('Notification not found');

    return this.prisma.notification.update({
      where: { id },
      data: {
        seen: true,
        readAt: new Date(),
      },
    });
  }

  async getUserNotifications(userId: string) {
    return this.prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getUserNotificationDropdown(
    userId: string,
    options: {
      seen?: boolean; // Filter by seen/unseen status
      limit?: number; // Limit number of notifications
      since?: Date; // Filter notifications since a specific date
    } = {},
  ): Promise<Notification[]> {
    // Validate userId
    const userExists = await this.prisma.user.findUnique({
      where: { user_id: userId },
    });
    if (!userExists) {
      throw new NotFoundException('User not found');
    }

    // Build query conditions
    const where: any = { userId };
    if (options.seen !== undefined) {
      where.seen = options.seen;
    }
    if (options.since) {
      where.createdAt = { gte: options.since };
    }

    const notifications = await this.prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: options.limit ?? 50, // Default limit to 50
      select: {
        id: true,
        userId: true,
        title: true,
        message: true,
        type: true,
        actionUrl: true,
        isCritical: true,
        meta: true,
        seen: true,
        createdAt: true,
        readAt: true,
      },
    });

    if (!notifications.length) {
      throw new NotFoundException('No notifications found for this user');
    }

    return notifications;
  }
}
