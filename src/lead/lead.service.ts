import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateLeadDto } from './dto/create-lead.dto';
import { UpdateLeadDto } from './dto/update-lead.dto';
import { AuthService } from 'src/auth/auth.service';

interface GraphEmailResponse {
  value: {
    id: string;
    from: { emailAddress: { address: string; name: string } };
    subject: string;
    bodyPreview: string;
    receivedDateTime: string;
    inReplyTo?: string;
  }[];
}

@Injectable()
export class LeadService {
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
    console.log('Test');
    console.log('LeadService: Starting for userId:', userId);
    const scopes = ['mail.read', 'offline_access'];

    const platform = await this.prisma.marketingPlatform.findFirst({
      where: { user_id: userId, platform_name: 'Microsoft' },
      include: { credentials: true },
    });
    console.log('LeadService: Platform:', platform);

    if (!platform) {
      console.log('LeadService: No platform');
      return { needsAuth: true, authUrl: '/auth/microsoft/leads' };
    }

    const creds = platform.credentials.find((cred) =>
      scopes.every((scope) => cred.scopes.includes(scope)),
    );
    console.log('LeadService: Credentials:', creds);

    if (!creds) {
      console.log('LeadService: No creds');
      return { needsAuth: true, authUrl: '/auth/microsoft/leads' };
    }

    try {
      const token = await this.authService.getMicrosoftToken(userId, scopes);
      console.log('LeadService: Token:', token);

      const response = await axios.get<GraphEmailResponse>(
        'https://graph.microsoft.com/v1.0/me/mailFolders/Inbox/messages',
        {
          headers: { Authorization: `Bearer ${token}` },
          params: {
            $top: 50,
            $select: 'from,subject,bodyPreview,receivedDateTime,inReplyTo',
          },
        },
      );
      console.log('LeadService: Graph response:', response.data);
      const result = { needsAuth: false, emails: [] };
      console.log('LeadService: Returning:', result);
      return result;
    } catch (error) {
      console.error(
        'LeadService: Error:',
        error.message,
        error.response?.status,
        error.response?.data,
      );
      throw error;
    }
  }
}
