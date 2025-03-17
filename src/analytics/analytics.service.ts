import { Injectable } from '@nestjs/common';
import { CreateAnalyticsDto } from './dto/create-analytics.dto';
import { UpdateAnalyticsDto } from './dto/update-analytics.dto';
import { PrismaService } from 'src/prisma/prisma.service';

@Injectable()
export class AnalyticsService {
  constructor(private prisma: PrismaService) {}

  async create(createAnalyticsDto: CreateAnalyticsDto) {
    return this.prisma.campaignPerformance.create({ data: createAnalyticsDto });
  }

  async findAll() {
    return this.prisma.campaignPerformance.findMany();
  }

  async findOne(id: string) {
    return this.prisma.campaignPerformance.findUnique({ where: { performance_id: id } });
  }

  async update(id: string, updateAnalyticsDto: UpdateAnalyticsDto) {
    return this.prisma.campaignPerformance.update({
      where: { performance_id: id },
      data: updateAnalyticsDto,
    });
  }

  async remove(id: string) {
    return this.prisma.campaignPerformance.delete({ where: { performance_id: id } });
  }
}
