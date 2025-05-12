import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';

@Injectable()
export class EmailTemplateService {
  constructor(private readonly prisma: PrismaService) {}

  async getTemplates(orgId: string) {
    return this.prisma.emailTemplate.findMany({
      where: { orgId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createTemplate(orgId: string, data: {
    name: string;
    subject: string;
    body: string;
    isActive?: boolean;
  }) {
    return this.prisma.emailTemplate.create({
      data: {
        orgId,
        ...data,
        isActive: data.isActive ?? true,
      },
    });
  }

  async updateTemplate(id: string, data: {
    name?: string;
    subject?: string;
    body?: string;
    isActive?: boolean;
  }) {
    return this.prisma.emailTemplate.update({
      where: { id },
      data,
    });
  }

  async deleteTemplate(id: string) {
    return this.prisma.emailTemplate.delete({ where: { id } });
  }

  async getActiveTemplate(orgId: string) {
    return this.prisma.emailTemplate.findFirst({
      where: { orgId, isActive: true },
    });
  }

  async getTemplateById(orgId: string, id: string) {
    return this.prisma.emailTemplate.findUnique({
      where: { 
        id,
        orgId 
      },
    });
  }
}
