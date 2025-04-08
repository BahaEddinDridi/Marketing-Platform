import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { AuthService } from 'src/auth/auth.service';
import axios from 'axios';
import { Cron, CronExpression } from '@nestjs/schedule';

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
    const subject = email.subject.toLowerCase();
    const preview = email.bodyPreview.toLowerCase();

    const leadKeywords = ['inquiry', 'interested', 'quote', 'sales', 'meeting'];

    return (
      (leadKeywords.some((kw) => subject.includes(kw)) ||
        leadKeywords.some((kw) => preview.includes(kw)))
    );
  }

  async fetchAndStoreLeads(orgId: string) {
    const scopes = ['openid', 'profile', 'email', 'User.Read', 'Mail.Read', 'offline_access'];
    const platformName = 'Microsoft';

    const platform = await this.prisma.marketingPlatform.findFirst({
      where: { orgId, platform_name: platformName },
      include: { credentials: true },
    });

    if (!platform) {
      this.logger.log('No platform found');
      return { needsAuth: true, authUrl: 'http://localhost:5000/auth/microsoft' };
    }

    const creds = platform.credentials.find((cred) =>
      scopes.every((scope) => cred.scopes.includes(scope)),
    );

    if (!creds) {
      return { needsAuth: true, authUrl: 'http://localhost:5000/auth/microsoft' };
    }

    try {
      const token = await this.authService.getMicrosoftToken(orgId, scopes);
      const org = await this.prisma.organization.findUnique({
        where: { id: orgId },
        select: { sharedMailbox: true },
      });
      if (!org || !org.sharedMailbox) {
        this.logger.error(`No shared mailbox found for orgId: ${orgId}`);
        throw new Error('Shared mailbox not configured for this organization');
      }
      const sharedMailbox = org.sharedMailbox;
      this.logger.log(`Fetching emails from shared mailbox: ${sharedMailbox}`);

      const foldersToSync = [
        { name: 'Inbox', id: 'inbox' },
        { name: 'Junk', id: 'junkemail' },
      ];

      let allEmails: GraphEmailResponse['value'] = [];

      for (const folder of foldersToSync) {
        const syncState = await this.prisma.syncState.findUnique({
          where: {
            orgId_folderId_unique: { orgId: orgId, folderId: folder.id },
          },
        });

        let url =
          syncState?.deltaLink ||
          `https://graph.microsoft.com/v1.0/users/${sharedMailbox}/mailFolders/${folder.id}/messages/delta`;
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
        this.logger.log(
          `allEmails`,
          allEmails,
        );
        allEmails = allEmails.concat(response.data.value);
        this.logger.log(
          `Fetched ${response.data.value.length} emails from ${folder.name}`,
        );

        if (response.data['@odata.deltaLink']) {
          await this.prisma.syncState.upsert({
            where: {
              orgId_folderId_unique: { orgId: orgId, folderId: folder.id },
            },
            update: {
              deltaLink: response.data['@odata.deltaLink'],
              lastSyncedAt: new Date(),
            },
            create: {
              orgId: orgId,
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
          orgId,
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
            org_id_email_source_platform_unique: {
              orgId,
              email: leadData.email,
              source_platform: leadData.source_platform,
            },
          },
        });

        if (existingLead) {
          await this.prisma.lead.update({
            where: { lead_id: existingLead.lead_id },
            data: leadData,
          });
        } else {
          await this.prisma.lead.create({ data: leadData });
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
      return { needsAuth: true, authUrl: 'http://localhost:5000/auth/microsoft' };
    }
  }

  @Cron(CronExpression.EVERY_HOUR)
  async syncLeadsForAllOrganizations() {
    this.logger.log('Starting hourly lead sync for all organizations');

    try {
      const organizations = await this.prisma.organization.findMany({
        select: { id: true },
      });
      this.logger.log(`Found ${organizations.length} organizations to sync`);

      for (const org of organizations) {
        this.logger.log(`Syncing leads for orgId: ${org.id}`);
        const result = await this.fetchAndStoreLeads(org.id);
        if (result.needsAuth) {
          this.logger.warn(`Org ${org.id} needs re-authentication`);
        } else {
          this.logger.log(`Sync completed for orgId: ${org.id} - ${result.message}`);
        }
      }
    } catch (error) {
      this.logger.error('Error in hourly lead sync:', error.message, error.stack);
    }
  }
  
  async fetchLeadsByUserId(orgId: string) {
    this.logger.log(`Fetching leads for userId: ${orgId}`);

    try {
      const leads = await this.prisma.lead.findMany({
        where: { orgId },
        orderBy: { created_at: 'desc' },
      });

      this.logger.log(`Fetched ${leads.length} leads for userId: ${orgId}`);

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
