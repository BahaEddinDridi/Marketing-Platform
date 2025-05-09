import { Module } from '@nestjs/common';
import { AutoReplyService } from './auto-reply.service';
import { AutoReplyController } from './auto-reply.controller';
import { PrismaModule } from 'src/prisma/prisma.module';
import { AuthModule } from 'src/auth/auth.module';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [PrismaModule, AuthModule, ConfigModule],
  controllers: [AutoReplyController],
  providers: [AutoReplyService],
})
export class AutoReplyModule {}
