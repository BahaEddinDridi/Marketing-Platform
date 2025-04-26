import { ForbiddenException, HttpException, HttpStatus, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { AuthService } from 'src/auth/auth.service';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as schedule from 'node-schedule';
import { v2 as cloudinary } from 'cloudinary';
import { Readable } from 'stream';

interface GraphEmailResponse {
  value: {
    id: string;
    from: { emailAddress: { address: string; name: string } };
    subject: string;
    body?: { content: string; contentType: string };
    bodyPreview?: string;
    hasAttachments: boolean;
    receivedDateTime: string;
    attachments?: { id: string; name: string; contentBytes: string; contentType: string }[];
  }[];
  '@odata.deltaLink'?: string;
  '@odata.nextLink'?: string;
}

interface AttachmentResponse {
  value: { id: string; name: string; contentBytes: string; contentType: string }[];
}

interface Mailbox {
  email: string;
  assignedToId: string | null;
  label: string;
}

interface Folder {
  id: string;
  name: string;
}

@Injectable()
export class LeadService {
  private readonly logger = new Logger(LeadService.name);
  private readonly cronMap = {
    EVERY_10_SECONDS: '*/10 * * * * *',
    EVERY_30_MINUTES: '*/30 * * * *',
    EVERY_HOUR: '0 * * * *',
    EVERY_DAY: '0 0 * * *',
  };
  private jobs = new Map<string, schedule.Job>();
  private readonly platformName = 'Microsoft';
  private readonly scopes = ['mail.read', 'user.read', 'offline_access'];

  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {
    cloudinary.config({
      cloud_name: this.configService.get('CLOUDINARY_CLOUD_NAME'),
      api_key: this.configService.get('CLOUDINARY_API_KEY'),
      api_secret: this.configService.get('CLOUDINARY_API_SECRET'),
    });
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

  private async validateSyncSettings(orgId: string) {
    const preferences = await this.prisma.microsoftPreferences.findUnique({
      where: { orgId },
      select: { leadSyncEnabled: true },
    });
    if (!preferences?.leadSyncEnabled) {
      this.logger.log(`Lead syncing disabled for org ${orgId}`);
      return { valid: false, response: { needsAuth: false, message: 'Lead syncing is disabled' } };
    }

    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { sharedMailbox: true },
    });
    if (!org?.sharedMailbox) {
      this.logger.error(`No shared mailbox configured for orgId: ${orgId}`);
      throw new Error('Shared mailbox not configured');
    }

    return { valid: true, sharedMailbox: org.sharedMailbox };
  }

  private async getPlatformCredentials(orgId: string) {
    const platform = await this.prisma.marketingPlatform.findFirst({
      where: { orgId, platform_name: this.platformName },
    });
  
    if (!platform) {
      this.logger.error(`Microsoft platform not found for org ${orgId}`);
      return {
        needsAuth: true,
        authUrl: 'http://localhost:5000/auth/microsoft/leads',
      };
    }
  
    const creds = await this.prisma.platformCredentials.findFirst({
      where: {
        platform_id: platform.platform_id,
        user_id: null,
        type: 'LEADS',
      },
    });
  
    if (!creds) {
      this.logger.error(`No LEADS credentials found for org ${orgId}`);
      return {
        needsAuth: true,
        authUrl: 'http://localhost:5000/auth/microsoft/leads',
      };
    }
  
    return { creds, needsAuth: false };
  }

  private async getMailboxes(orgId: string, sharedMailbox: string): Promise<Mailbox[]> {
    const members = await this.prisma.user.findMany({
      where: { orgId, allowPersonalEmailSync: true },
      select: { user_id: true, email: true },
    });

    return [
      { email: sharedMailbox, assignedToId: null, label: 'Shared Mailbox' },
      ...members.map((member) => ({
        email: member.email,
        assignedToId: member.user_id,
        label: `${member.email}’s Inbox`,
      })),
    ];
  }

  private async getFolders(orgId: string, token: string, mailboxEmail: string): Promise<Folder[]> {
    const leadConfig = await this.prisma.leadConfiguration.findUnique({
      where: { orgId },
    });
  
    if (leadConfig?.folders) {
      return Object.entries(leadConfig.folders).map(([id, name]) => ({ id, name }));
    }
  
    try {
      const response = await axios.get<{ value: { id: string; displayName: string; wellKnownName?: string }[] }>(
        `https://graph.microsoft.com/v1.0/users/${mailboxEmail}/mailFolders`,
        {
          headers: { Authorization: `Bearer ${token}` },
          params: { $top: 50 },
        },
      );
  
      const folders = response.data.value
        .filter((folder) => 
          folder.wellKnownName?.toLowerCase() === 'inbox' || 
          folder.wellKnownName?.toLowerCase() === 'junkemail' ||
          folder.displayName.toLowerCase().includes('inbox') ||
          folder.displayName.toLowerCase().includes('junk')
        )
        .map((folder) => ({
          id: folder.id,
          name: folder.displayName,
        }));
  
      this.logger.log(`Fetched folders for ${mailboxEmail}: ${folders.map(f => `${f.name} (${f.id})`).join(', ')}`);
  
      if (folders.length === 0) {
        this.logger.warn(`No matching folders found for ${mailboxEmail}, using defaults`);
        return [
          { name: 'Inbox', id: 'inbox' },
          { name: 'Junk', id: 'junkemail' },
        ];
      }
  
      // Update leadConfiguration with fetched folders
      await this.prisma.leadConfiguration.upsert({
        where: { orgId },
        update: {
          folders: Object.fromEntries(folders.map(f => [f.id, f.name])),
        },
        create: {
          orgId,
          filters: ['inquiry', 'interested', 'quote', 'sales', 'meeting'],
          folders: Object.fromEntries(folders.map(f => [f.id, f.name])),
          syncInterval: 'EVERY_HOUR',
        },
      });
  
      return folders;
    } catch (error) {
      this.logger.error(`Failed to fetch folders for ${mailboxEmail}: ${error.message}`, error.response?.data);
      return [
        { name: 'Inbox', id: 'inbox' },
        { name: 'Junk', id: 'junkemail' },
      ];
    }
  }
  private async fetchEmails(
    orgId: string,
    mailboxes: Mailbox[],
    token: string,
  ): Promise<GraphEmailResponse['value']> {
    let allEmails: GraphEmailResponse['value'] = [];

    for (const mailbox of mailboxes) {
      this.logger.log(`Fetching leads from ${mailbox.label}`);

      const folders = await this.getFolders(orgId, token, mailbox.email);


      for (const folder of folders) {
        const syncState = await this.prisma.syncState.findUnique({
          where: {
            orgId_mailboxEmail_folderId_unique: {
              orgId,
              mailboxEmail: mailbox.email,
              folderId: folder.id,
            },
          },
        });

        let url =
          syncState?.deltaLink ||
          `https://graph.microsoft.com/v1.0/users/${mailbox.email}/mailFolders/${folder.id}/messages/delta`;
        const params = syncState?.deltaLink
          ? {}
          : {
              $top: 100,
              $select: 'id,subject,from,receivedDateTime,body,bodyPreview,hasAttachments',
              $filter: `receivedDateTime ge ${new Date(
                Date.now() - 30 * 24 * 60 * 60 * 1000,
              ).toISOString()}`,
            };

        try {
          this.logger.log(`Fetching emails from ${url} with params: ${JSON.stringify(params)}`);
          const response = await axios.get<GraphEmailResponse>(url, {
            headers: { Authorization: `Bearer ${token}` },
            params,
          });

          this.logger.log(
            `Fetched ${response.data.value.length} emails from ${mailbox.label} - ${folder.name}`,
          );

          const emailsWithAttachments = response.data.value.filter(
            (email) => email.hasAttachments,
          );
          for (const email of emailsWithAttachments) {
            try {
              const attachmentResponse = await axios.get<AttachmentResponse>(
                `https://graph.microsoft.com/v1.0/users/${mailbox.email}/messages/${email.id}/attachments`,
                { headers: { Authorization: `Bearer ${token}` } },
              );
              email.attachments = attachmentResponse.data.value.map((att) => ({
                id: att.id,
                name: att.name,
                contentBytes: att.contentBytes,
                contentType: att.contentType,
              }));
            } catch (attachmentError) {
              this.logger.error(
                `Failed to fetch attachments for email ${email.id} in ${mailbox.label}: ${attachmentError.message}`,
              );
              email.attachments = [];
            }
          }

          allEmails = allEmails.concat(response.data.value);

          if (response.data['@odata.deltaLink']) {
            await this.prisma.syncState.upsert({
              where: {
                orgId_mailboxEmail_folderId_unique: {
                  orgId,
                  mailboxEmail: mailbox.email,
                  folderId: folder.id,
                },
              },
              update: {
                deltaLink: response.data['@odata.deltaLink'],
                lastSyncedAt: new Date(),
              },
              create: {
                orgId,
                platform: this.platformName,
                mailboxEmail: mailbox.email,
                folderId: folder.id,
                deltaLink: response.data['@odata.deltaLink'],
              },
            });
            this.logger.log(
              `Updated sync state for ${mailbox.label} - ${folder.name}`,
            );
          }
        } catch (folderError) {
          this.logger.error(
            `${mailbox.label} - ${folder.name} failed: ${folderError.message}`,
          );
          continue;
        }
      }
    }

    this.logger.log(`Total fetched emails: ${allEmails.length}`);
    return allEmails;
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

  private async uploadToCloudinary(
    fileName: string,
    content: string,
    contentType: string,
  ): Promise<string> {
    try {
      const buffer = Buffer.from(content, 'base64');
      const stream = Readable.from(buffer);
      const result = await new Promise<string>((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          {
            resource_type: 'auto',
            public_id: `leads/attachments/${fileName}`,
            format: contentType.split('/')[1] || 'bin',
          },
          (error, result) => {
            if (error) reject(error);
            else resolve(result!.secure_url);
          },
        );
        stream.pipe(uploadStream);
      });
      this.logger.log(`Uploaded attachment ${fileName} to Cloudinary`);
      return result;
    } catch (error) {
      this.logger.error(`Failed to upload ${fileName} to Cloudinary: ${error.message}`);
      throw error;
    }
  }

  private async storeLeads(
    orgId: string,
    emails: GraphEmailResponse['value'],
    mailboxes: Mailbox[],
  ) {
    const potentialLeads = (
      await Promise.all(emails.map((email) => this.isPotentialLead(email, orgId)))
    )
      .map((isLead, index) => (isLead ? emails[index] : null))
      .filter((email): email is GraphEmailResponse['value'][0] => email !== null);

    for (const email of potentialLeads) {
      const senderEmail = email.from.emailAddress.address;
      const mailbox = mailboxes.find((m) => m.email === senderEmail) || mailboxes[0];
      const leadData = {
        orgId,
        source_platform: this.platformName,
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

      const existingLeadEmail = await this.prisma.leadEmail.findUnique({
        where: { emailId: emailData.emailId },
      });
  
      if (existingLeadEmail) {
        this.logger.log(`Skipping duplicate email ${emailData.emailId} for lead ${senderEmail}`);
        continue;
      }

      const existingLead = await this.prisma.lead.findUnique({
        where: {
          org_id_email_source_platform_unique: {
            orgId,
            email: leadData.email,
            source_platform: leadData.source_platform,
          },
        },
      });

      let leadId: string;
      if (existingLead) {
        await this.prisma.lead.update({
          where: { lead_id: existingLead.lead_id },
          data: leadData,
        });
        leadId = existingLead.lead_id;
      } else {
        const newLead = await this.prisma.lead.create({ data: leadData });
        leadId = newLead.lead_id;
      }

      const leadEmail = await this.prisma.leadEmail.create({
        data: {
          ...emailData,
          leadId,
        },
      });

      if (email.hasAttachments && email.attachments?.length) {
        for (const attachment of email.attachments) {
          try {
            const cloudinaryUrl = await this.uploadToCloudinary(
              attachment.name,
              attachment.contentBytes,
              attachment.contentType,
            );
            await this.prisma.leadAttachment.create({
              data: {
                leadEmailId: leadEmail.id,
                fileName: attachment.name,
                cloudinaryUrl,
              },
            });
            this.logger.log(`Stored attachment ${attachment.name} for lead email ${leadEmail.id}`);
          } catch (attachmentError) {
            this.logger.error(
              `Failed to process attachment ${attachment.name} for lead email ${leadEmail.id}: ${attachmentError.message}`,
            );
            continue;
          }
        }
      }

      this.logger.log(
        existingLead
          ? `Updated lead for ${leadData.email} with new email ${emailData.emailId}`
          : `New lead from ${mailbox.label} assigned to ${mailbox.assignedToId || 'Shared'} with email ${emailData.emailId}`,
      );
    }

    this.logger.log(`Stored ${potentialLeads.length} potential lead emails`);
  }

  async fetchAndStoreLeads(orgId: string) {
    try {
      const syncValidation = await this.validateSyncSettings(orgId);
      if (!syncValidation.valid) return syncValidation.response;

      const credResult = await this.getPlatformCredentials(orgId);
      if (credResult.needsAuth) return credResult;

      const { creds } = credResult;

      const token = await this.authService.getMicrosoftToken(orgId, this.scopes);

      const mailboxes = await this.getMailboxes(orgId, syncValidation.sharedMailbox!);

      const emails = await this.fetchEmails(orgId, mailboxes, token);

      await this.storeLeads(orgId, emails, mailboxes);

      return { needsAuth: false, message: 'Sync Successful' };
    } catch (error) {
      this.logger.error('Sync failed: ', error.message, error.response?.data);
      return {
        needsAuth: true,
        authUrl: 'http://localhost:5000/auth/microsoft/leads',
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
      updatedLeadConfig = await this.prisma.leadConfiguration.create({
        data: {
          orgId,
          filters: data.filters || ['inquiry', 'interested', 'quote', 'sales', 'meeting'],
          folders: data.folders || { inbox: 'Inbox', junkemail: 'Junk' },
          syncInterval: data.syncInterval || 'EVERY_HOUR',
        },
      });
      await this.scheduleOrgSync(orgId, updatedLeadConfig.syncInterval);
    } else {
      const previousSyncInterval = org.leadConfig.syncInterval;
      updatedLeadConfig = await this.prisma.leadConfiguration.update({
        where: { orgId },
        data: {
          filters: data.filters !== undefined ? data.filters : undefined,
          folders: data.folders !== undefined ? data.folders : undefined,
          syncInterval: data.syncInterval !== undefined ? data.syncInterval : undefined,
        },
      });

      if (data.syncInterval && data.syncInterval !== previousSyncInterval) {
        await this.scheduleOrgSync(orgId, updatedLeadConfig.syncInterval);
      }
    }

    return updatedLeadConfig;
  }

  async setupLeadSync(
    orgId: string,
    userId: string,
    data: {
      sharedMailbox: string;
      filters?: string[];
      folders?: Record<string, string>;
      syncInterval?: string;
    },
  ) {
    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
    });
    if (!user || user.role !== 'ADMIN') {
      throw new HttpException('Only admins can setup lead sync', HttpStatus.FORBIDDEN);
    }

    await this.prisma.$transaction(async (prisma) => {
      await prisma.organization.update({
        where: { id: orgId },
        data: { sharedMailbox: data.sharedMailbox },
      });

      await prisma.leadConfiguration.upsert({
        where: { orgId },
        create: {
          orgId,
          filters: data.filters || ['inquiry', 'interested', 'quote', 'sales', 'meeting'],
          folders: data.folders || { inbox: 'Inbox', junkemail: 'Junk' },
          syncInterval: data.syncInterval || 'EVERY_HOUR',
        },
        update: {
          filters: data.filters || ['inquiry', 'interested', 'quote', 'sales', 'meeting'],
          folders: data.folders || { inbox: 'Inbox', junkemail: 'Junk' },
          syncInterval: data.syncInterval || 'EVERY_HOUR',
        },
      });
    });

    this.logger.log(`Lead sync setup completed for org ${orgId}`);
    return { message: 'Lead sync setup successful' };
  }

  async connectLeadSync(userId: string) {
    this.logger.log(`Connecting Microsoft lead sync for org via user ${userId}`);
    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
    });
    if (!user) throw new UnauthorizedException('User not found');
  
    if (user.role !== 'ADMIN') {
      throw new ForbiddenException('Only admins can connect lead sync');
    }
  
    const org = await this.prisma.organization.findUnique({
      where: { id: user.orgId },
      select: { sharedMailbox: true },
    });
    const leadConfig = await this.prisma.leadConfiguration.findUnique({
      where: { orgId: user.orgId },
    });
  
    if (!org?.sharedMailbox || !leadConfig) {
      this.logger.log(`Setup required for org ${user.orgId}`);
      return { needsSetup: true };
    }
  
    const platform = await this.prisma.marketingPlatform.upsert({
      where: { orgId_platform_name: { orgId: user.orgId, platform_name: this.platformName } },
      create: {
        orgId: user.orgId,
        platform_name: this.platformName,
        sync_status: 'CONNECTED',
      },
      update: {
        sync_status: 'CONNECTED',
      },
    });
  
    // Check for existing org-wide credentials
    const existingCredentials = await this.prisma.platformCredentials.findFirst({
      where: { platform_id: platform.platform_id, user_id: null, type: 'LEADS' },
    });
  
    if (existingCredentials) {
      this.logger.log(`Org-wide credentials already exist for org ${user.orgId}`);
      await this.scheduleOrgSync(user.orgId, leadConfig.syncInterval);
      await this.prisma.microsoftPreferences.upsert({
        where: { orgId: user.orgId },
        create: { orgId: user.orgId, leadSyncEnabled: true },
        update: { leadSyncEnabled: true },
      });
      return { needsAuth: false, message: 'Lead sync already connected' };
    }
  
    await this.prisma.microsoftPreferences.upsert({
      where: { orgId: user.orgId },
      create: { orgId: user.orgId, leadSyncEnabled: true },
      update: { leadSyncEnabled: true },
    });
  
    await this.scheduleOrgSync(user.orgId, leadConfig.syncInterval);
  
    this.logger.log(`Initiating Microsoft lead sync auth for org ${user.orgId}`);
    return { needsAuth: true, authUrl: 'http://localhost:5000/auth/microsoft/leads' };
  }

  async disconnectLeadSync(userId: string) {
    this.logger.log(`Disconnecting Microsoft lead sync for org via user ${userId}`);
    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
    });
    if (!user) throw new UnauthorizedException('User not found');
  
    if (user.role !== 'ADMIN') {
      throw new ForbiddenException('Only admins can disconnect lead sync');
    }
  
    const platform = await this.prisma.marketingPlatform.findFirst({
      where: { orgId: user.orgId, platform_name: this.platformName },
    });
    if (!platform) throw new HttpException('Microsoft platform not found', HttpStatus.NOT_FOUND);
  
    await this.prisma.$transaction(async (prisma) => {
      // Delete org-wide credentials
      await prisma.platformCredentials.deleteMany({
        where: { platform_id: platform.platform_id, user_id: null, type: 'LEADS' },
      });
  
      await prisma.microsoftPreferences.update({
        where: { orgId: user.orgId },
        data: { leadSyncEnabled: false },
      });
  
      await prisma.marketingPlatform.update({
        where: { platform_id: platform.platform_id },
        data: { sync_status: 'DISCONNECTED' },
      });
    });
  
    const job = this.jobs.get(user.orgId);
    if (job) {
      job.cancel();
      this.jobs.delete(user.orgId);
      this.logger.log(`Cancelled sync job for org ${user.orgId}`);
    }
  
    this.logger.log(`Microsoft lead sync disconnected for org ${user.orgId}`);
    return {
      message: 'Microsoft lead sync disconnected.',
    };
  }

  async connectMemberLeadSync(userId: string) {
    this.logger.log(`Connecting member Microsoft lead sync for user ${userId}`);
    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
    });
    if (!user) throw new UnauthorizedException('User not found');

    const platform = await this.prisma.marketingPlatform.findFirst({
      where: { orgId: user.orgId, platform_name: this.platformName },
    });
    if (!platform) {
      this.logger.log(`No Microsoft platform found for org ${user.orgId}`);
      return { needsAuth: true, authUrl: 'http://localhost:5000/auth/microsoft/leads' };
    }

    const existingCredentials = await this.prisma.platformCredentials.findFirst({
      where: { platform_id: platform.platform_id, user_id: userId, type: 'LEADS' },
    });
    if (existingCredentials) {
      this.logger.log(`User ${userId} already has LEADS credentials`);
      return { needsAuth: false, message: 'Already connected' };
    }

    return { needsAuth: true, authUrl: 'http://localhost:5000/auth/microsoft/leads' };
  }

  async disconnectMemberLeadSync(userId: string) {
    this.logger.log(`Disconnecting member Microsoft lead sync for user ${userId}`);
    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
    });
    if (!user) throw new UnauthorizedException('User not found');

    const platform = await this.prisma.marketingPlatform.findFirst({
      where: { orgId: user.orgId, platform_name: this.platformName },
    });
    if (!platform) throw new HttpException('Microsoft platform not found', HttpStatus.NOT_FOUND);

    await this.prisma.platformCredentials.deleteMany({
      where: { platform_id: platform.platform_id, user_id: userId, type: 'LEADS' },
    });

    this.logger.log(`Member Microsoft lead sync disconnected for user ${userId}`);
    return { message: 'Member Microsoft lead sync disconnected' };
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
          preferences: {
            select: { leadSyncEnabled: true },
          },
        },
      });
      this.logger.log(`Found ${organizations.length} organizations to sync`);
      for (const org of organizations) {
        if (org.preferences?.leadSyncEnabled) {
          await this.scheduleOrgSync(org.id, org.leadConfig?.syncInterval);
        }
      }
    } catch (error) {
      this.logger.error(
        'Error starting dynamic sync: ',
        error.message,
        error.stack,
      );
    }
  }

  async scheduleOrgSync(orgId: string, syncInterval?: string) {
    const preferences = await this.prisma.microsoftPreferences.findUnique({
      where: { orgId },
      select: { leadSyncEnabled: true },
    });
    if (!preferences?.leadSyncEnabled) {
      this.logger.log(`Lead sync disabled for org ${orgId}, skipping scheduling`);
      return;
    }

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
      if (result?.needsAuth) {
        this.logger.warn(`Org ${orgId} needs to re-authenticate`);
      } else {
        this.logger.log(`Sync completed for org ${orgId}`);
      }
    });

    this.jobs.set(orgId, job);
  }

  async fetchLeadsByUserId(orgId: string, userId: string) {
    this.logger.log(`Fetching leads for userId: ${userId}, orgId: ${orgId}`);

    try {
      const user = await this.prisma.user.findUnique({
        where: { user_id: userId },
        select: { role: true },
      });
      if (!user) throw new HttpException('User not found', HttpStatus.NOT_FOUND);

      const whereClause =
        user.role === 'ADMIN'
          ? { orgId }
          : {
              orgId,
              OR: [{ assignedToId: userId }, { assignedToId: null }],
            };

      const leads = await this.prisma.lead.findMany({
        where: whereClause,
        orderBy: { created_at: 'desc' },
        include: {
          leadEmails: {
            include: { attachments: true },
          },
        },
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
          emails: lead.leadEmails.map((leadEmail) => ({
            subject: leadEmail.subject,
            body: leadEmail.body,
            hasAttachments: leadEmail.hasAttachments,
            receivedDateTime: leadEmail.receivedDateTime.toISOString(),
            emailId: leadEmail.emailId,
            senderName: leadEmail.senderName,
            senderEmail: leadEmail.senderEmail,
            attachments: leadEmail.attachments.map((att) => ({
              id: att.id,
              fileName: att.fileName,
              cloudinaryUrl: att.cloudinaryUrl,
            })),
          })),
        })),
      };
    } catch (error) {
      this.logger.error('Error fetching leads: ', error.message);
      throw new HttpException('Failed to fetch leads', HttpStatus.INTERNAL_SERVER_ERROR);
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
        include: {
          leadEmails: {
            include: { attachments: true },
          },
        },
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
        emails: updatedLead.leadEmails.map((leadEmail) => ({
          subject: leadEmail.subject,
          body: leadEmail.body,
          hasAttachments: leadEmail.hasAttachments,
          receivedDateTime: leadEmail.receivedDateTime.toISOString(),
          emailId: leadEmail.emailId,
          senderName: leadEmail.senderName,
          senderEmail: leadEmail.senderEmail,
          attachments: leadEmail.attachments.map((att) => ({
            id: att.id,
            fileName: att.fileName,
            cloudinaryUrl: att.cloudinaryUrl,
          })),
        })),
      };
    } catch (error) {
      this.logger.error(`Error updating lead ${leadId}: ${error.message}`);
      throw new HttpException('Failed to update lead', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }
}