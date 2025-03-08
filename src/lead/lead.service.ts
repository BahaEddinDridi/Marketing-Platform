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

  async findOne(id: number) {
    return this.prisma.lead.findUnique({ where: { id } });
  }

  async update(id: number, updateLeadDto: UpdateLeadDto) {
    return this.prisma.lead.update({ where: { id }, data: updateLeadDto });
  }

  async remove(id: number) {
    return this.prisma.lead.delete({ where: { id } });
  }
}
