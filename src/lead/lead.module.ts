import { Module } from '@nestjs/common';
import { LeadService } from './lead.service';
import { LeadController } from './lead.controller';
import { PrismaModule } from 'src/prisma/prisma.module';
import { AuthModule } from 'src/auth/auth.module'; 
import { ConfigModule } from '@nestjs/config';
import { NotificationsModule } from 'src/notifications/notifications.module';

@Module({
  imports: [
    PrismaModule,
    AuthModule,  
    ConfigModule,
    NotificationsModule
  ],
  controllers: [LeadController],
  providers: [LeadService],
  exports: [LeadService],
})
export class LeadModule {}