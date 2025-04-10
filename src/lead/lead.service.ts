import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { AuthService } from 'src/auth/auth.service';
import axios from 'axios';
import { Cron, CronExpression } from '@nestjs/schedule';
import * as schedule from 'node-schedule';

interface GraphEmailResponse {
  value: {
    id: string;
    from: { emailAddress: { address: string; name: string } };
    subject: string;
    body?: { content: string; contentType: string }; // Optional body
    bodyPreview?: string;
    hasAttachments: boolean;
    receivedDateTime: string;
  }[];
  '@odata.deltaLink'?: string;
  '@odata.nextLink'?: string;
}

@Injectable()
export class LeadService {
  private readonly logger = new Logger(LeadService.name);
  private readonly cronMap = {
    EVERY_10_SECONDS: '*/10 * * * * *', // Every 10 seconds (for testing)
    EVERY_30_MINUTES: '*/30 * * * *',   // Every 30 minutes
    EVERY_HOUR: '0 * * * *',            // Every hour
    EVERY_DAY: '0 0 * * *',             // Every day at midnight
  };
  private jobs = new Map<string, schedule.Job>();
  constructor(
    private prisma: PrismaService,
    private readonly authService: AuthService,
  ) {
    this.startDynamicSync();
  }

  async findAll() {
    return this.prisma.lead.findMany();
  }

  async findOne(lead_id: string) {
    return this.prisma.lead.findUnique({ where: { lead_id } });
  }

  async remove(lead_id: string) {
    return this.prisma.lead.delete({ where: { lead_id } });
  }

  private async isPotentialLead(
    email: GraphEmailResponse['value'][0],
    orgId: string,
  ): Promise<boolean> {
    const leadConfig = await this.prisma.leadConfiguration.findUnique({
      where: { orgId },
      select: { filters: true },
    });

    if (!leadConfig) {
      this.logger.warn(`No lead config for org ${orgId}, using defaults`);
      return this.defaultIsPotentialLead(email); 
    }

    const subject = email.subject.toLowerCase();
    const preview = email.body?.content.toLowerCase();
    const leadKeywords = leadConfig.filters;

    return (
      leadKeywords.some((kw) => subject.includes(kw)) ||
      leadKeywords.some((kw) => preview?.includes(kw))
    );
  }

  private defaultIsPotentialLead(email: GraphEmailResponse['value'][0]): boolean {
    const subject = email.subject.toLowerCase();
    const preview = email.body?.content.toLowerCase();
    const defaultKeywords = ['inquiry', 'interested', 'quote', 'sales', 'meeting'];

    return (
      defaultKeywords.some((kw) => subject.includes(kw)) ||
      defaultKeywords.some((kw) => preview?.includes(kw))
    );
  }

  async fetchAndStoreLeads(orgId: string) {
    const scopes = [
      'openid',
      'profile',
      'email',
      'User.Read',
      'Mail.Read',
      'offline_access',
    ];
    const platformName = 'Microsoft';
  
    const platform = await this.prisma.marketingPlatform.findFirst({
      where: { orgId, platform_name: platformName },
      include: { credentials: true },
    });
  
    if (!platform) {
      this.logger.log('No platform found—time to get connected');
      return {
        needsAuth: true,
        authUrl: 'http://localhost:5000/auth/microsoft',
      };
    }
  
    const creds = platform.credentials.find((cred) =>
      scopes.every((scope) => cred.scopes.includes(scope)),
    );
  
    if (!creds) {
      this.logger.log('Missing creds—let’s fix that glow-up!');
      return {
        needsAuth: true,
        authUrl: 'http://localhost:5000/auth/microsoft',
      };
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
  
      const members = await this.prisma.user.findMany({
        where: {
          orgId: orgId,
          allowPersonalEmailSync: true,
        },
        select: { user_id: true, email: true },
      });
  
      const mailboxes = [
        { email: sharedMailbox, assignedToId: null, label: 'Shared Mailbox' },
        ...members.map((member) => ({
          email: member.email,
          assignedToId: member.user_id,
          label: `${member.email}’s Inbox`,
        })),
      ];
  
      const leadConfig = await this.prisma.leadConfiguration.findUnique({
        where: { orgId },
      });
      const foldersToSync = leadConfig?.folders
        ? Object.entries(leadConfig.folders).map(([id, name]) => ({ id, name }))
        : [
            { name: 'Inbox', id: 'inbox' },
            { name: 'Junk', id: 'junkemail' },
          ];
  
      let allEmails: GraphEmailResponse['value'] = [];
  
      for (const mailbox of mailboxes) {
        this.logger.log(`Fetching leads from ${mailbox.label}—let’s snag those gems!`);
  
        for (const folder of foldersToSync) {
          const syncState = await this.prisma.syncState.findUnique({
            where: {
              orgId_folderId_unique: { orgId: `${orgId}_${mailbox.email}`, folderId: folder.id },
            },
          });
  
          let url =
            syncState?.deltaLink ||
            `https://graph.microsoft.com/v1.0/users/${mailbox.email}/mailFolders/${folder.id}/messages/delta`;
          const params = syncState?.deltaLink
            ? {}
            : {
                $top: 50,
                $select: 'id,subject,from,receivedDateTime,body,bodyPreview',
                $filter: `receivedDateTime ge ${new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()}`,
              };
  
          try {
            const response = await axios.get<GraphEmailResponse>(url, {
              headers: { Authorization: `Bearer ${token}` },
              params,
            });
  
            this.logger.log(
              `Graph API response (${mailbox.label} - ${folder.name}):`,
              JSON.stringify(response.data),
            );
            if (response.data.value.length > 0) {
              this.logger.log(
                `First email sample (${mailbox.label} - ${folder.name}):`,
                JSON.stringify(response.data.value[0]),
              );
            }
  
            allEmails = allEmails.concat(response.data.value);
            this.logger.log(
              `Fetched ${response.data.value.length} emails from ${mailbox.label} - ${folder.name}`,
            );
  
            if (response.data['@odata.deltaLink']) {
              await this.prisma.syncState.upsert({
                where: {
                  orgId_folderId_unique: { orgId: `${orgId}_${mailbox.email}`, folderId: folder.id },
                },
                update: {
                  deltaLink: response.data['@odata.deltaLink'],
                  lastSyncedAt: new Date(),
                },
                create: {
                  orgId: `${orgId}_${mailbox.email}`,
                  platform: platformName,
                  folderId: folder.id,
                  deltaLink: response.data['@odata.deltaLink'],
                },
              });
              this.logger.log(
                `Updated sync state for ${mailbox.label} - ${folder.name}—sync’s looking fab!`,
              );
            }
          } catch (folderError) {
            this.logger.error(
              `Oops, ${mailbox.label} - ${folder.name} flopped:`,
              folderError.message,
            );
            continue; 
          }
        }
      }
  
      this.logger.log(`Total fetched emails: ${allEmails.length}`);
      const potentialLeads = (
        await Promise.all(allEmails.map((email) => this.isPotentialLead(email, orgId)))
      )
        .map((isLead, index) => (isLead ? allEmails[index] : null))
        .filter((email): email is GraphEmailResponse['value'][0] => email !== null);
        
        
      for (const email of potentialLeads) {
        const senderEmail = email.from.emailAddress.address;
        const mailbox = mailboxes.find((m) => m.email === senderEmail) || mailboxes[0];
        const leadData = {
          orgId,
          source_platform: platformName,
          assignedToId: mailbox.assignedToId, 
          name: email.from.emailAddress.name || 'Unknown',
          email: senderEmail,
          phone: null,
          company: null,
          job_title: null,
          status: 'NEW' as const,
          created_at: new Date(email.receivedDateTime),
        };
  
        const emailData = {
          subject: email.subject || 'No Subject',
          body: email.body?.content || email.bodyPreview || '',
          hasAttachments: email.hasAttachments || false,
          receivedDateTime: new Date(email.receivedDateTime),
          emailId: email.id,
          senderName: email.from.emailAddress.name || null,
          senderEmail: senderEmail,
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
          await this.prisma.leadEmail.upsert({
            where: { leadId: existingLead.lead_id },
            update: emailData,
            create: {
              ...emailData,
              leadId: existingLead.lead_id,
            },
          });
          this.logger.log(`Updated lead for ${leadData.email}`);
        } else {
          const newLead = await this.prisma.lead.create({ data: leadData });
          await this.prisma.leadEmail.create({
            data: {
              ...emailData,
              leadId: newLead.lead_id,
            },
          });
          this.logger.log(
            `New lead from ${mailbox.label} assigned to ${mailbox.assignedToId || 'Shared'}`,
          );
        }
      }
  
      this.logger.log(`Stored ${potentialLeads.length} potential leads`);
  
      return {
        needsAuth: false,
        message: 'Sync Successful',
      };
    } catch (error) {
      this.logger.error(
        'Sync crashed the party:',
        error.message,
        error.response?.data,
      );
      return {
        needsAuth: true,
        authUrl: 'http://localhost:5000/auth/microsoft',
      };
    }
  }

  async updateLeadConfig(
    orgId: string,
    data: {
      filters?: string[];
      folders?: Record<string, string>;
      syncInterval?: string;
    },
  ) {
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      include: { leadConfig: true },
    });
    if (!org) throw new HttpException('Organization not found', HttpStatus.NOT_FOUND);

    let updatedLeadConfig;

    if (!org.leadConfig) {
      // Create new config if none exists
      updatedLeadConfig = await this.prisma.leadConfiguration.create({
        data: {
          orgId,
          filters: data.filters || ['inquiry', 'interested', 'quote', 'sales', 'meeting'],
          folders: data.folders || { inbox: 'Inbox', junkemail: 'Junk' },
          syncInterval: data.syncInterval || 'EVERY_HOUR',
        },
      });
      // Schedule the sync for the new config
      await this.scheduleOrgSync(orgId, updatedLeadConfig.syncInterval);
    } else {
      // Update existing config and reschedule only if syncInterval changes
      const previousSyncInterval = org.leadConfig.syncInterval;
      updatedLeadConfig = await this.prisma.leadConfiguration.update({
        where: { orgId },
        data: {
          filters: data.filters !== undefined ? data.filters : undefined,
          folders: data.folders !== undefined ? data.folders : undefined,
          syncInterval: data.syncInterval !== undefined ? data.syncInterval : undefined,
        },
      });

      // Restart the sync if syncInterval was provided and changed
      if (data.syncInterval && data.syncInterval !== previousSyncInterval) {
        await this.scheduleOrgSync(orgId, updatedLeadConfig.syncInterval);
      }
    }

    return updatedLeadConfig;
  }
  
  private async startDynamicSync() {
    this.logger.log('Starting dynamic sync for organizations');

    try {
      const organizations = await this.prisma.organization.findMany({
        select: {
          id: true,
          leadConfig: {
            select: { syncInterval: true },
          },
        },
      });
      this.logger.log(`Found ${organizations.length} organizations to sync`);
      for (const org of organizations) {
        await this.scheduleOrgSync(org.id, org.leadConfig?.syncInterval);
      }
    } catch (error) {
      this.logger.error(
        'Error starting dynamic sync:',
        error.message,
        error.stack,
      );
    }
  }

  async scheduleOrgSync(orgId: string, syncInterval?: string) {
    const existingJob = this.jobs.get(orgId);
    if (existingJob) {
      existingJob.cancel();
      this.logger.log(`Cancelled old sync job for org ${orgId}`);
    }

    const interval = syncInterval || 'EVERY_HOUR';
    const cronExpression = this.cronMap[interval] || this.cronMap.EVERY_HOUR;

    this.logger.log(`Scheduling org ${orgId} with ${interval} (${cronExpression})`);

    const job = schedule.scheduleJob(cronExpression, async () => {
      this.logger.log(`Syncing leads for org ${orgId}`);
      const result = await this.fetchAndStoreLeads(orgId);
      if (result.needsAuth) {
        this.logger.warn(`Org ${orgId} needs to re-authenticate`);
      } else {
        this.logger.log(`Org ${orgId}`);
      }
    });

    this.jobs.set(orgId, job);
  }

  async fetchLeadsByUserId(orgId: string) {
    this.logger.log(`Fetching leads for userId: ${orgId}`);

    try {
      const leads = await this.prisma.lead.findMany({
        where: { orgId },
        orderBy: { created_at: 'desc' },
        include: { leadEmail: true },
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
          emailData: lead.leadEmail
            ? {
                subject: lead.leadEmail.subject,
                body: lead.leadEmail.body,
                hasAttachments: lead.leadEmail.hasAttachments,
                receivedDateTime: lead.leadEmail.receivedDateTime.toISOString(),
                emailId: lead.leadEmail.emailId,
                senderName: lead.leadEmail.senderName,
                senderEmail: lead.leadEmail.senderEmail,
              }
            : null,
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
  async updateLead(
    leadId: string,
    data: {
      name?: string;
      phone?: string | null;
      company?: string | null;
      jobTitle?: string | null;
    },
  ) {
    this.logger.log(
      `Updating lead ${leadId} with data: ${JSON.stringify(data)}`,
    );

    try {
      const updatedLead = await this.prisma.lead.update({
        where: { lead_id: leadId },
        data: {
          name: data.name,
          phone: data.phone,
          company: data.company,
          job_title: data.jobTitle,
        },
        include: { leadEmail: true },
      });

      this.logger.log(`Lead ${leadId} updated successfully`);
      return {
        leadId: updatedLead.lead_id,
        sourcePlatform: updatedLead.source_platform,
        name: updatedLead.name,
        email: updatedLead.email,
        phone: updatedLead.phone,
        company: updatedLead.company,
        jobTitle: updatedLead.job_title,
        status: updatedLead.status,
        createdAt: updatedLead.created_at.toISOString(),
        emailData: updatedLead.leadEmail
          ? {
              subject: updatedLead.leadEmail.subject,
              body: updatedLead.leadEmail.body,
              hasAttachments: updatedLead.leadEmail.hasAttachments,
              receivedDateTime:
                updatedLead.leadEmail.receivedDateTime.toISOString(),
              emailId: updatedLead.leadEmail.emailId,
              senderName: updatedLead.leadEmail.senderName,
              senderEmail: updatedLead.leadEmail.senderEmail,
            }
          : null,
      };
    } catch (error) {
      this.logger.error(`Error updating lead ${leadId}:`, error.message);
      throw new Error('Failed to update lead');
    }
  }
}
