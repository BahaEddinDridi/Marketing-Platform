import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { AuthService } from 'src/auth/auth.service';
import axios from 'axios';

interface GraphEmailResponse {
  value: {
    id: string;
    from: { emailAddress: { address: string; name: string } };
    subject: string;
    bodyPreview: string;
    receivedDateTime: string;
  }[];
  '@odata.deltaLink'?: string;
  '@odata.nextLink'?: string;
}

@Injectable()
export class LeadService {
  private readonly logger = new Logger(LeadService.name);

  constructor(
    private prisma: PrismaService,
    private readonly authService: AuthService,
  ) {}

  async findAll() {
    return this.prisma.lead.findMany();
  }

  async findOne(lead_id: string) {
    return this.prisma.lead.findUnique({ where: { lead_id } });
  }

  async remove(lead_id: string) {
    return this.prisma.lead.delete({ where: { lead_id } });
  }

  private isPotentialLead(email: GraphEmailResponse['value'][0]): boolean {
    const senderEmail = email.from.emailAddress.address.toLowerCase();
    const subject = email.subject.toLowerCase();
    const preview = email.bodyPreview.toLowerCase();

    const internalDomains = ['@yourcompany.com'];
    const leadKeywords = ['inquiry', 'interested', 'quote', 'sales', 'meeting'];

    return (
      !internalDomains.some((domain) => senderEmail.endsWith(domain)) &&
      (leadKeywords.some((kw) => subject.includes(kw)) ||
        leadKeywords.some((kw) => preview.includes(kw)))
    );
  }

  async fetchAndStoreLeads(userId: string) {
    const scopes = ['mail.read', 'offline_access'];
    const platformName = 'Microsoft';

    const platform = await this.prisma.marketingPlatform.findFirst({
      where: { user_id: userId, platform_name: platformName },
      include: { credentials: true },
    });

    if (!platform) {
      this.logger.log('No platform found');
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
      const user = await this.prisma.user.findUnique({
        where: { user_id: userId },
      });
      if (!user) {
        throw new Error('User not found');
      }
      const foldersToSync = [
        { name: 'Inbox', id: 'inbox' },
        { name: 'Junk', id: 'junkemail' },
      ];

      let allEmails: GraphEmailResponse['value'] = [];

      for (const folder of foldersToSync) {
        const syncState = await this.prisma.syncState.findUnique({
          where: {
            user_id_folderId_unique: { user_id: userId, folderId: folder.id },
          },
        });

        let url =
          syncState?.deltaLink ||
          `https://graph.microsoft.com/v1.0/me/mailFolders/${folder.id}/messages/delta`;
        const params = syncState?.deltaLink
          ? {}
          : {
              $top: 50,
              $select: 'id,subject,from,receivedDateTime,bodyPreview',
              $filter: `receivedDateTime ge ${new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()}`,
            };

        const response = await axios.get<GraphEmailResponse>(url, {
          headers: { Authorization: `Bearer ${token}` },
          params,
        });

        this.logger.log(
          `Graph API response (${folder.name}):`,
          JSON.stringify(response.data),
        );
        allEmails = allEmails.concat(response.data.value);
        this.logger.log(
          `Fetched ${response.data.value.length} emails from ${folder.name}`,
        );

        if (response.data['@odata.deltaLink']) {
          await this.prisma.syncState.upsert({
            where: {
              user_id_folderId_unique: { user_id: userId, folderId: folder.id },
            },
            update: {
              deltaLink: response.data['@odata.deltaLink'],
              lastSyncedAt: new Date(),
            },
            create: {
              user_id: userId,
              platform: platformName,
              folderId: folder.id,
              deltaLink: response.data['@odata.deltaLink'],
            },
          });
          this.logger.log(
            `Updated sync state for ${folder.name} with deltaLink`,
          );
        }
      }

      this.logger.log(`Total fetched emails: ${allEmails.length}`);
      const potentialLeads = allEmails.filter((email) =>
        this.isPotentialLead(email),
      );
      for (const email of potentialLeads) {
        const leadData = {
            source_platform: platformName,
            name: email.from.emailAddress.name || 'Unknown',
            email: email.from.emailAddress.address,
            phone: null,
            company: null,
            job_title: null,
            status: 'NEW' as const,
            created_at: new Date(email.receivedDateTime),
        };

        const existingLead = await this.prisma.lead.findUnique({
            where: {
                user_id_email_source_platform_unique: {
                    user_id: userId,
                    email: leadData.email,
                    source_platform: leadData.source_platform,
                },
            },
        });

        if (existingLead) {
            await this.prisma.lead.update({
                where: {
                    user_id_email_source_platform_unique: {
                        user_id: userId,
                        email: leadData.email,
                        source_platform: leadData.source_platform,
                    },
                },
                data: { ...leadData },
            });
        } else {
            await this.prisma.lead.create({
                data: {
                    ...leadData,
                    user: { connect: { user_id: userId } },
                },
            });
        }
    }

      this.logger.log(`Stored ${potentialLeads.length} leads`);

      return {
        needsAuth: false,
        message: 'Sync Successful',
      };
    } catch (error) {
      this.logger.error(
        'Error fetching/storing leads:',
        error.message,
        error.response?.data,
      );
      return { needsAuth: true, authUrl: '/auth/microsoft/leads' };
    }
  }

  async fetchLeadsByUserId(userId: string) {
    this.logger.log(`Fetching leads for userId: ${userId}`);

    try {
      const leads = await this.prisma.lead.findMany({
        where: { user_id: userId },
        orderBy: { created_at: 'desc' },
      });

      this.logger.log(`Fetched ${leads.length} leads for userId: ${userId}`);

      return {
        leads: leads.map((lead) => ({
          leadId: lead.lead_id,
          sourcePlatform: lead.source_platform,
          name: lead.name,
          email: lead.email,
          phone: lead.phone,
          company: lead.company,
          jobTitle: lead.job_title,
          status: lead.status,
          createdAt: lead.created_at.toISOString(),
        })),
      };
    } catch (error) {
      this.logger.error('Error fetching leads:', error.message);
      throw new Error('Failed to fetch leads');
    }
  }
  async updateLeadStatus(leadId: string, status) {
    this.logger.log(`Updating lead ${leadId} to status: ${status}`);
    return this.prisma.lead.update({
      where: { lead_id: leadId },
      data: { status },
    });
  }
}
