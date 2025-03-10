import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateLeadDto } from './dto/create-lead.dto';
import { UpdateLeadDto } from './dto/update-lead.dto';


@Injectable()
export class LeadService {
  constructor(private prisma: PrismaService) {}

  async create(createLeadDto: CreateLeadDto) {
    return this.prisma.lead.create({ data: createLeadDto });
  }

  async findAll() {
    return this.prisma.lead.findMany();
  }

  async findOne(lead_id : string) {
    return this.prisma.lead.findUnique({ where: { lead_id  } });
  }

  async update(lead_id : string, updateLeadDto: UpdateLeadDto) {
    return this.prisma.lead.update({ where: { lead_id  }, data: updateLeadDto });
  }

  async remove(lead_id: string) {
    return this.prisma.lead.delete({ where: { lead_id  } });
  }
}
