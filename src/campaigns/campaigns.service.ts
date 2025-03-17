import { Injectable } from '@nestjs/common';
import { CreateCampaignDto } from './dto/create-campaign.dto';
import { UpdateCampaignDto } from './dto/update-campaign.dto';
import { PrismaService } from 'src/prisma/prisma.service';

@Injectable()
export class CampaignsService {
  constructor(private prisma: PrismaService) {}

  async create(createCampaignDto: CreateCampaignDto) {
    return this.prisma.campaign.create({ data: createCampaignDto });
  }

  async findAll() {
    return this.prisma.campaign.findMany();
  }

  async findOne(id: string) {
    return this.prisma.campaign.findUnique({
      where: { campaign_id: id },
      include: { performances: true },
    });
  }
  async update(id: string, updateCampaignDto: UpdateCampaignDto) {
    return this.prisma.campaign.update({
      where: { campaign_id: id },
      data: updateCampaignDto,
    });
  }

  async remove(id: string) {
    return this.prisma.campaign.delete({ where: { campaign_id: id } });
  }
}
