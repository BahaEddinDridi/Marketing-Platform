import { Controller, Post, Get, Patch, Param, Body, Query } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { Notification } from './notifications.service';
@Controller('notifications')
export class NotificationsController {
  constructor(private service: NotificationsService) {}

  @Post()
  create(@Body() body: any) {
    return this.service.createNotification(body);
  }

  @Patch(':id/seen')
  markAsSeen(@Param('id') id: string) {
    return this.service.markAsSeen(id);
  }

  @Get('user/:userId')
  getUserNotifications(@Param('userId') userId: string) {
    return this.service.getUserNotifications(userId);
  }

  @Get('user/:userId/dropdown')
  async getUserNotificationDropdown(
    @Param('userId') userId: string,
    @Query('seen') seen?: string,
    @Query('limit') limit?: string,
    @Query('since') since?: string,
  ): Promise<Notification[]> {
    const options: {
      seen?: boolean;
      limit?: number;
      since?: Date;
    } = {};

    if (seen !== undefined) {
      options.seen = seen === 'true';
    }
    if (limit) {
      const parsedLimit = parseInt(limit, 10);
      if (!isNaN(parsedLimit)) {
        options.limit = parsedLimit;
      }
    }
    if (since) {
      const parsedDate = new Date(since);
      if (!isNaN(parsedDate.getTime())) {
        options.since = parsedDate;
      }
    }

    return this.service.getUserNotificationDropdown(userId, options);
  }
}
