import { Controller, Post, Get, Patch, Param, Body } from '@nestjs/common';
import { NotificationsService } from './notifications.service';

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
}
