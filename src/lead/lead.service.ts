import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateLeadDto } from './dto/create-lead.dto';
import { UpdateLeadDto } from './dto/update-lead.dto';
import { AuthService } from 'src/auth/auth.service';
import axios from 'axios';

interface GraphEmailResponse {
  value: {
    id: string;
    from: { emailAddress: { address: string; name: string } };
    subject: string;
    bodyPreview: string;
    receivedDateTime: string;
    isRead: boolean;
    ccRecipients: { emailAddress: { address: string; name: string } }[];
    bccRecipients: { emailAddress: { address: string; name: string } }[];
    hasAttachments: boolean;
    inReplyTo?: string; 
  }[];
}


@Injectable()
export class LeadService {
  private readonly logger = new Logger(LeadService.name);

  constructor(
    private prisma: PrismaService,
    private readonly authService: AuthService,
  ) {}

  async create(createLeadDto: CreateLeadDto) {
    return this.prisma.lead.create({ data: createLeadDto });
  }

  async findAll() {
    return this.prisma.lead.findMany();
  }

  async findOne(lead_id: string) {
    return this.prisma.lead.findUnique({ where: { lead_id } });
  }

  async update(lead_id: string, updateLeadDto: UpdateLeadDto) {
    return this.prisma.lead.update({ where: { lead_id }, data: updateLeadDto });
  }

  async remove(lead_id: string) {
    return this.prisma.lead.delete({ where: { lead_id } });
  }

  async fetchEmails(userId: string) {
    const scopes = ['mail.read', 'offline_access'];

    const platform = await this.prisma.marketingPlatform.findFirst({
      where: { user_id: userId, platform_name: 'Microsoft' },
      include: { credentials: true },
    });
    if (!platform) {
      return { needsAuth: true, authUrl: '/auth/microsoft/leads' };
    }

    const creds = platform.credentials.find((cred) =>
      scopes.every((scope) => cred.scopes.includes(scope)),
    );
    if (!creds) {
      return { needsAuth: true, authUrl: '/auth/microsoft/leads' };
    }
    try {
      const token = await this.authService.getMicrosoftToken(userId, scopes);

      const response = await axios.get<GraphEmailResponse>(
        'https://graph.microsoft.com/v1.0/me/messages',
        {
          headers: { Authorization: `Bearer ${token}` },
          params: {
            $top: 50,
            $select: 'subject,from,receivedDateTime,bodyPreview,isRead,ccRecipients,bccRecipients,hasAttachments',
          },
        },
      );
      const emails = response.data.value;
      return {
        needsAuth: false,
        emails: emails.map((email) => ({
          subject: email.subject,
          from: email.from.emailAddress.name, 
          fromEmail: email.from.emailAddress.address, 
          receivedAt: email.receivedDateTime,
          preview: email.bodyPreview,
          isRead: email.isRead, 
          ccRecipients: email.ccRecipients, 
          bccRecipients: email.bccRecipients, 
          hasAttachments: email.hasAttachments, 
        })),
      };
    } catch (error) {
      this.logger.error(
        'Error fetching emails:',
        error.message,
        error.response?.data,
      );
      return { needsAuth: true, authUrl: '/auth/microsoft/leads' };
    }
  }
}
