import { Injectable, NotFoundException } from '@nestjs/common';
import { NotificationPreference } from '@prisma/client';
import { NotificationsGateway } from 'src/middlewares/notifications.gateway';
import { PrismaService } from 'src/prisma/prisma.service';

@Injectable()
export class NotificationsService {
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
}
