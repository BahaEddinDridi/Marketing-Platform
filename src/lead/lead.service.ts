import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { AuthService } from 'src/auth/auth.service';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as schedule from 'node-schedule';
import { v2 as cloudinary } from 'cloudinary';
import { Readable } from 'stream';
import { LeadStatus, Prisma } from '@prisma/client';

interface GraphEmailResponse {
  value: {
    id: string;
    from: { emailAddress: { address: string; name: string } };
    subject: string;
    body?: { content: string; contentType: string };
    bodyPreview?: string;
    hasAttachments: boolean;
    receivedDateTime: string;
    conversationId: string;
    internetMessageId?: string;
    toRecipients?: { emailAddress: { address: string; name?: string } }[];
    ccRecipients?: { emailAddress: { address: string; name?: string } }[];
    bccRecipients?: { emailAddress: { address: string; name?: string } }[];
    attachments?: {
      id: string;
      name: string;
      contentBytes: string;
      contentType: string;
    }[];
  }[];
  '@odata.deltaLink'?: string;
  '@odata.nextLink'?: string;
}

interface AttachmentResponse {
  value: {
    id: string;
    name: string;
    contentBytes: string;
    contentType: string;
  }[];
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

interface EmailTemplate {
  id: string;
  orgId: string;
  name: string;
  subject: string;
  body: string;
  isActive: boolean;
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
  private readonly scopes = [
    'mail.read',
    'mail.send',
    'user.read',
    'offline_access',
  ];

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
  private async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
      return {
        valid: false,
        response: { needsAuth: false, message: 'Lead syncing is disabled' },
      };
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

  private async getMailboxes(
    orgId: string,
    sharedMailbox: string,
  ): Promise<Mailbox[]> {
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

  private async getFolders(
    orgId: string,
    token: string,
    mailboxEmail: string,
  ): Promise<Folder[]> {
    const leadConfig = await this.prisma.leadConfiguration.findUnique({
      where: { orgId },
    });

    if (leadConfig?.folders) {
      return Object.entries(leadConfig.folders).map(([id, name]) => ({
        id,
        name,
      }));
    }

    try {
      const response = await axios.get<{
        value: { id: string; displayName: string; wellKnownName?: string }[];
      }>(`https://graph.microsoft.com/v1.0/users/${mailboxEmail}/mailFolders`, {
        headers: { Authorization: `Bearer ${token}` },
        params: { $top: 50 },
      });

      const folders = response.data.value
        .filter(
          (folder) =>
            folder.wellKnownName?.toLowerCase() === 'inbox' ||
            folder.wellKnownName?.toLowerCase() === 'junkemail' ||
            folder.displayName.toLowerCase().includes('inbox') ||
            folder.displayName.toLowerCase().includes('junk'),
        )
        .map((folder) => ({
          id: folder.id,
          name: folder.displayName,
        }));

      this.logger.log(
        `Fetched folders for ${mailboxEmail}: ${folders.map((f) => `${f.name} (${f.id})`).join(', ')}`,
      );

      if (folders.length === 0) {
        this.logger.warn(
          `No matching folders found for ${mailboxEmail}, using defaults`,
        );
        return [
          { name: 'Inbox', id: 'inbox' },
          { name: 'Junk', id: 'junkemail' },
        ];
      }

      await this.prisma.leadConfiguration.upsert({
        where: { orgId },
        update: {
          folders: Object.fromEntries(folders.map((f) => [f.id, f.name])),
        },
        create: {
          orgId,
          filters: ['inquiry', 'interested', 'quote', 'sales', 'meeting'],
          folders: Object.fromEntries(folders.map((f) => [f.id, f.name])),
          syncInterval: 'EVERY_HOUR',
        },
      });

      return folders;
    } catch (error) {
      this.logger.error(
        `Failed to fetch folders for ${mailboxEmail}: ${error.message}`,
        error.response?.data,
      );
      return [
        { name: 'Inbox', id: 'inbox' },
        { name: 'Junk', id: 'junkemail' },
      ];
    }
  }

  private async fetchConversationThread(
    orgId: string,
    mailboxEmail: string,
    conversationId: string,
    token: string,
  ): Promise<GraphEmailResponse['value']> {
    try {
      const encodedMailbox = encodeURIComponent(mailboxEmail);

      const messagesResponse = await axios.get<{ value: { id: string }[] }>(
        `https://graph.microsoft.com/v1.0/users/${encodedMailbox}/messages`,
        {
          headers: { Authorization: `Bearer ${token}` },
          params: {
            $filter: `conversationId eq '${conversationId}'`,
            $select: 'id',
            $top: 100,
          },
        },
      );

      const emailPromises = messagesResponse.data.value.map(async ({ id }) => {
        try {
          const emailResponse = await axios.get<GraphEmailResponse['value'][0]>(
            `https://graph.microsoft.com/v1.0/users/${encodedMailbox}/messages/${id}`,
            {
              headers: { Authorization: `Bearer ${token}` },
              params: {
                $select:
                  'id,subject,from,toRecipients,ccRecipients,bccRecipients,receivedDateTime,body,bodyPreview,hasAttachments,conversationId,internetMessageId',
              },
            },
          );

          const email = emailResponse.data;
          if (email.hasAttachments) {
            try {
              const attachmentResponse = await axios.get<AttachmentResponse>(
                `https://graph.microsoft.com/v1.0/users/${encodedMailbox}/messages/${id}/attachments`,
                { headers: { Authorization: `Bearer ${token}` } },
              );
              email.attachments = attachmentResponse.data.value;
            } catch (error) {
              this.logger.error(
                `Failed to fetch attachments for email ${id}: ${error.message}`,
              );
              email.attachments = [];
            }
          }
          return email;
        } catch (error) {
          this.logger.error(`Failed to fetch email ${id}: ${error.message}`);
          return undefined;
        }
      });

      const emails = (await Promise.all(emailPromises)).filter(
        (email): email is GraphEmailResponse['value'][0] => email !== undefined,
      );

      return emails.sort(
        (a, b) =>
          new Date(a.receivedDateTime).getTime() -
          new Date(b.receivedDateTime).getTime(),
      );
    } catch (error) {
      this.logger.error(
        `Failed to fetch conversation ${conversationId}: ${error.message}`,
        error.response?.data,
      );
      throw error;
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
              $top: 50,
              $select:
                'id,subject,from,receivedDateTime,body,bodyPreview,hasAttachments,conversationId,internetMessageId',
              $filter: `receivedDateTime ge ${new Date(
                Date.now() - 30 * 24 * 60 * 60 * 1000,
              ).toISOString()}`,
            };

        try {
          this.logger.log(
            `Fetching emails from ${url} with params: ${JSON.stringify(params)}`,
          );
          const response = await axios.get<GraphEmailResponse>(url, {
            headers: { Authorization: `Bearer ${token}` },
            params,
          });

          this.logger.log(
            `Fetched ${response.data.value.length} emails from ${mailbox.label} - ${folder.name}`,
          );

          const emailsWithAttachments = await Promise.all(
            response.data.value
              .filter((email) => email.hasAttachments)
              .map(async (email) => {
                try {
                  const attachmentResponse =
                    await axios.get<AttachmentResponse>(
                      `https://graph.microsoft.com/v1.0/users/${mailbox.email}/messages/${email.id}/attachments`,
                      { headers: { Authorization: `Bearer ${token}` } },
                    );
                  email.attachments = attachmentResponse.data.value;
                } catch (error) {
                  email.attachments = [];
                }
                return email;
              }),
          );

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
      const defaultKeywords = [
        'inquiry',
        'interested',
        'quote',
        'sales',
        'meeting',
      ];
      const subject = email.subject.toLowerCase();
      const preview = email.body?.content?.toLowerCase() || '';
      return defaultKeywords.some(
        (kw) =>
          subject.includes(kw) ||
          defaultKeywords.some((kw) => preview.includes(kw)),
      );
    }

    const subject = email.subject.toLowerCase();
    const preview = email.body?.content?.toLowerCase() || '';
    return (
      leadConfig.filters.some((kw) => subject.includes(kw)) ||
      leadConfig.filters.some((kw) => preview.includes(kw))
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
      this.logger.error(
        `Failed to upload ${fileName} to Cloudinary: ${error.message}`,
      );
      throw error;
    }
  }

  private async processEmailAttachments(
    conversationEmailId: string,
    attachments: {
      id: string;
      name: string;
      contentBytes: string;
      contentType: string;
    }[],
  ) {
    for (const attachment of attachments) {
      try {
        const cloudinaryUrl = await this.uploadToCloudinary(
          attachment.name,
          attachment.contentBytes,
          attachment.contentType,
        );
        await this.prisma.leadAttachment.create({
          data: {
            conversationEmailId, // Updated field name
            fileName: attachment.name,
            cloudinaryUrl,
          },
        });
      } catch (error) {
        this.logger.error(
          `Failed to process attachment ${attachment.name}: ${error.message}`,
        );
      }
    }
  }

  private async storeLeads(
    orgId: string,
    emails: GraphEmailResponse['value'],
    mailboxes: Mailbox[],
    token: string,
  ) {
    const conversations = new Map<string, GraphEmailResponse['value'][0][]>();

    // Group emails by conversation
    emails.forEach((email) => {
      if (!email.conversationId) return;
      if (!conversations.has(email.conversationId)) {
        conversations.set(email.conversationId, []);
      }
      conversations.get(email.conversationId)?.push(email);
    });

    for (const [conversationId, conversationEmails] of conversations) {
      const firstEmail = conversationEmails[0];
      const senderEmail = firstEmail.from.emailAddress.address;
      const mailbox =
        mailboxes.find((m) => m.email === senderEmail) || mailboxes[0];

      if (!(await this.isPotentialLead(firstEmail, orgId))) continue;

      // Get full conversation thread
      let fullConversation: GraphEmailResponse['value'];
      try {
        fullConversation = await this.fetchConversationThread(
          orgId,
          mailbox.email,
          conversationId,
          token,
        );
      } catch (error) {
        this.logger.error(
          `Using initial emails for conversation ${conversationId}`,
        );
        fullConversation = conversationEmails;
      }

      // Sort chronologically
      fullConversation.sort(
        (a, b) =>
          new Date(a.receivedDateTime).getTime() -
          new Date(b.receivedDateTime).getTime(),
      );

      // Create/update lead
      const leadData = {
        organization: { connect: { id: orgId } },
        source: 'email',
        assignedTo: mailbox.assignedToId
          ? { connect: { user_id: mailbox.assignedToId } }
          : undefined,
        name: firstEmail.from.emailAddress.name || 'Unknown',
        email: senderEmail,
        phone: null,
        company: null,
        job_title: null,
        initialConversationId: conversationId,
        status: 'NEW' as LeadStatus,
        created_at: new Date(firstEmail.receivedDateTime),
      };

      // Use a transaction to ensure atomicity
      const lead = await this.prisma.$transaction(async (tx) => {
        // Check for existing non-CLOSED leads with the same orgId and email
        const existingLead = await tx.lead.findFirst({
          where: {
            email: leadData.email,
            organization: { id: orgId },
            status: { not: 'CLOSED' }, // Exclude CLOSED leads
          },
          include: {
            conversations: {
              select: { conversationId: true },
            },
          },
        });

        if (existingLead) {
          // Check if this conversation is already associated with the lead
          const hasConversation = existingLead.conversations.some(
            (conv) => conv.conversationId === conversationId,
          );
          if (!hasConversation) {
            // Update the existing lead and associate the new conversation later
            return await tx.lead.update({
              where: { lead_id: existingLead.lead_id },
              data: {
                name: leadData.name,
                assignedTo: leadData.assignedTo,
                status: leadData.status,
                created_at: leadData.created_at,
                updated_at: new Date(),
              },
            });
          }
          // If the conversation already exists, return the lead without updating
          return existingLead;
        } else {
          // No non-CLOSED lead exists, create a new lead
          return await tx.lead.create({
            data: leadData,
          });
        }
      });

      // Create or update conversation
      const conversationData = {
        lead: { connect: { lead_id: lead.lead_id } },
        conversationId,
      };

      const existingConversation = await this.prisma.leadConversation.findFirst(
        {
          where: { conversationId },
          include: {
            lead: {
              select: { status: true },
            },
          },
        },
      );

      let conversation;
      if (existingConversation) {
        if (existingConversation.lead.status === 'CLOSED') {
          // If the conversation belongs to a CLOSED lead, create a new conversation
          conversation = await this.prisma.leadConversation.create({
            data: conversationData,
          });
          this.logger.log(
            `Created new conversation for lead ${lead.lead_id} with conversationId ${conversationId} (existing conversation belongs to CLOSED lead)`,
          );
        } else {
          // If the conversation belongs to a non-CLOSED lead, update it if necessary
          if (existingConversation.leadId !== lead.lead_id) {
            conversation = await this.prisma.leadConversation.update({
              where: { id: existingConversation.id },
              data: conversationData,
            });
            this.logger.log(
              `Updated conversation ${existingConversation.id} to point to lead ${lead.lead_id}`,
            );
          } else {
            conversation = existingConversation;
            this.logger.log(
              `Reusing existing conversation ${conversation.id} for lead ${lead.lead_id}`,
            );
          }
        }
      } else {
        // No existing conversation, create a new one
        conversation = await this.prisma.leadConversation.create({
          data: conversationData,
        });
        this.logger.log(
          `Created new conversation ${conversation.id} for lead ${lead.lead_id}`,
        );
      }

      // Process all emails in conversation
      for (const [index, email] of fullConversation.entries()) {
        const existingEmail = await this.prisma.conversationEmail.findUnique({
          where: { emailId: email.id },
        });

        if (existingEmail) continue;

        const isIncoming = email.from?.emailAddress?.address === senderEmail;

        const conversationEmail = await this.prisma.conversationEmail.create({
          data: {
            conversation: { connect: { id: conversation.id } },
            emailId: email.id,
            subject: email.subject || 'No Subject',
            body: email.body?.content || email.bodyPreview || '',
            contentType: email.body?.contentType || 'text',
            from: {
              name: email.from?.emailAddress?.name || null,
              email: email.from?.emailAddress?.address || 'unknown',
            },
            to:
              email.toRecipients?.map((r) => ({
                name: r.emailAddress?.name || null,
                email: r.emailAddress?.address || 'unknown',
              })) || [],
            cc:
              email.ccRecipients?.map((r) => ({
                name: r.emailAddress?.name || null,
                email: r.emailAddress?.address || 'unknown',
              })) || [],
            bcc:
              email.bccRecipients?.map((r) => ({
                name: r.emailAddress?.name || null,
                email: r.emailAddress?.address || 'unknown',
              })) || [],
            hasAttachments: email.hasAttachments || false,
            receivedDateTime: new Date(email.receivedDateTime),
            isIncoming,
            isThreadHead: index === 0,
            inReplyTo: email.internetMessageId,
          },
        });

        // Process attachments using the ConversationEmail's ID
        if (email.hasAttachments && email.attachments?.length) {
          await this.processEmailAttachments(
            conversationEmail.id,
            email.attachments,
          );
        }

        // Add a small delay between processing emails
        await this.delay(200);
      }
    }
  }

  async fetchAndStoreLeads(orgId: string) {
    try {
      const syncValidation = await this.validateSyncSettings(orgId);
      if (!syncValidation.valid) return syncValidation.response;

      const credResult = await this.getPlatformCredentials(orgId);
      if (credResult.needsAuth) return credResult;

      const token = await this.authService.getMicrosoftToken(
        orgId,
        this.scopes,
      );

      const mailboxes = await this.getMailboxes(
        orgId,
        syncValidation.sharedMailbox!,
      );

      const emails = await this.fetchEmails(orgId, mailboxes, token);

      await this.storeLeads(orgId, emails, mailboxes, token);

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
    if (!org)
      throw new HttpException('Organization not found', HttpStatus.NOT_FOUND);

    let updatedLeadConfig;

    if (!org.leadConfig) {
      updatedLeadConfig = await this.prisma.leadConfiguration.create({
        data: {
          orgId,
          filters: data.filters || [
            'inquiry',
            'interested',
            'quote',
            'sales',
            'meeting',
          ],
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
          syncInterval:
            data.syncInterval !== undefined ? data.syncInterval : undefined,
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
      throw new HttpException(
        'Only admins can setup lead sync',
        HttpStatus.FORBIDDEN,
      );
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
          filters: data.filters || [
            'inquiry',
            'interested',
            'quote',
            'sales',
            'meeting',
          ],
          folders: data.folders || { inbox: 'Inbox', junkemail: 'Junk' },
          syncInterval: data.syncInterval || 'EVERY_HOUR',
        },
        update: {
          filters: data.filters || [
            'inquiry',
            'interested',
            'quote',
            'sales',
            'meeting',
          ],
          folders: data.folders || { inbox: 'Inbox', junkemail: 'Junk' },
          syncInterval: data.syncInterval || 'EVERY_HOUR',
        },
      });
    });

    this.logger.log(`Lead sync setup completed for org ${orgId}`);
    return { message: 'Lead sync setup successful' };
  }

  async connectLeadSync(userId: string) {
    this.logger.log(
      `Connecting Microsoft lead sync for org via user ${userId}`,
    );
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
      where: {
        orgId_platform_name: {
          orgId: user.orgId,
          platform_name: this.platformName,
        },
      },
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
    const existingCredentials = await this.prisma.platformCredentials.findFirst(
      {
        where: {
          platform_id: platform.platform_id,
          user_id: null,
          type: 'LEADS',
        },
      },
    );

    if (existingCredentials) {
      this.logger.log(
        `Org-wide credentials already exist for org ${user.orgId}`,
      );
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

    this.logger.log(
      `Initiating Microsoft lead sync auth for org ${user.orgId}`,
    );
    return {
      needsAuth: true,
      authUrl: 'http://localhost:5000/auth/microsoft/leads',
    };
  }

  async disconnectLeadSync(userId: string) {
    this.logger.log(
      `Disconnecting Microsoft lead sync for org via user ${userId}`,
    );
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
    if (!platform)
      throw new HttpException(
        'Microsoft platform not found',
        HttpStatus.NOT_FOUND,
      );

    await this.prisma.$transaction(async (prisma) => {
      // Delete org-wide credentials
      await prisma.platformCredentials.deleteMany({
        where: {
          platform_id: platform.platform_id,
          user_id: null,
          type: 'LEADS',
        },
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
      return {
        needsAuth: true,
        authUrl: 'http://localhost:5000/auth/microsoft/leads',
      };
    }

    const existingCredentials = await this.prisma.platformCredentials.findFirst(
      {
        where: {
          platform_id: platform.platform_id,
          user_id: userId,
          type: 'LEADS',
        },
      },
    );
    if (existingCredentials) {
      this.logger.log(`User ${userId} already has LEADS credentials`);
      return { needsAuth: false, message: 'Already connected' };
    }

    return {
      needsAuth: true,
      authUrl: 'http://localhost:5000/auth/microsoft/leads',
    };
  }

  async disconnectMemberLeadSync(userId: string) {
    this.logger.log(
      `Disconnecting member Microsoft lead sync for user ${userId}`,
    );
    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
    });
    if (!user) throw new UnauthorizedException('User not found');

    const platform = await this.prisma.marketingPlatform.findFirst({
      where: { orgId: user.orgId, platform_name: this.platformName },
    });
    if (!platform)
      throw new HttpException(
        'Microsoft platform not found',
        HttpStatus.NOT_FOUND,
      );

    await this.prisma.platformCredentials.deleteMany({
      where: {
        platform_id: platform.platform_id,
        user_id: userId,
        type: 'LEADS',
      },
    });

    this.logger.log(
      `Member Microsoft lead sync disconnected for user ${userId}`,
    );
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
      this.logger.log(
        `Lead sync disabled for org ${orgId}, skipping scheduling`,
      );
      return;
    }

    const existingJob = this.jobs.get(orgId);
    if (existingJob) {
      existingJob.cancel();
      this.logger.log(`Cancelled old sync job for org ${orgId}`);
    }

    const interval = syncInterval || 'EVERY_HOUR';
    const cronExpression = this.cronMap[interval] || this.cronMap.EVERY_HOUR;

    this.logger.log(
      `Scheduling org ${orgId} with ${interval} (${cronExpression})`,
    );

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

  async fetchLeadsByUserId(
  orgId: string,
  userId: string,
  page: number = 1,
  pageSize: number = 10,
  filters: {
    search?: string;
    status?: LeadStatus[]; // Use LeadStatus[]
    source?: string[]; // Assuming source is a String field
  } = {},
) {
  this.logger.log(
    `Fetching leads for userId: ${userId}, orgId: ${orgId}, page: ${page}, pageSize: ${pageSize}, filters: ${JSON.stringify(filters)}`,
  );

  try {
    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
      select: { role: true },
    });
    if (!user)
      throw new HttpException('User not found', HttpStatus.NOT_FOUND);

    // Base where clause based on user role
    const baseWhereClause: Prisma.LeadWhereInput =
      user.role === 'ADMIN'
        ? { orgId }
        : {
            orgId,
            OR: [{ assignedToId: userId }, { assignedToId: null }],
          };

    // Build search conditions for name, email, company, jobTitle
    const searchConditions: Prisma.LeadWhereInput[] = [];
    if (filters.search) {
      const searchTerm = filters.search;
      searchConditions.push(
        {
          name: {
            contains: searchTerm,
            mode: 'insensitive' as Prisma.QueryMode,
          },
        },
        {
          email: {
            contains: searchTerm,
            mode: 'insensitive' as Prisma.QueryMode,
          },
        },
        {
          company: {
            contains: searchTerm,
            mode: 'insensitive' as Prisma.QueryMode,
          },
        },
        {
          job_title: {
            contains: searchTerm,
            mode: 'insensitive' as Prisma.QueryMode,
          },
        },
      );
    }

    // Extend where clause with filters
    const whereClause: Prisma.LeadWhereInput = {
      ...baseWhereClause,
      ...(filters.search && { OR: searchConditions }),
      ...(filters.status?.length && { status: { in: filters.status } }), // Compatible with LeadStatus[]
      ...(filters.source?.length && { source: { in: filters.source } }), // Works for String field
    };

    const skip = (page - 1) * pageSize;

    const [leads, total] = await Promise.all([
      this.prisma.lead.findMany({
        where: whereClause,
        orderBy: { created_at: 'desc' },
        include: {
          assignedTo: {
            select: {
              user_id: true,
              firstName: true,
              lastName: true,
              email: true,
            },
          },
        },
        skip,
        take: pageSize,
      }),
      this.prisma.lead.count({ where: whereClause }),
    ]);

    this.logger.log(`Fetched ${leads.length} leads for userId: ${userId}`);

    return {
      leads: leads.map((lead) => ({
        leadId: lead.lead_id,
        source: lead.source,
        name: lead.name,
        email: lead.email,
        phone: lead.phone,
        company: lead.company,
        jobTitle: lead.job_title,
        status: lead.status,
        assignedTo: lead.assignedTo,
        createdAt: lead.created_at,
      })),
      pagination: {
        currentPage: page,
        pageSize,
        totalItems: total,
        totalPages: Math.ceil(total / pageSize),
      },
    };
  } catch (error) {
    this.logger.error('Error fetching leads: ', error.message);
    throw new HttpException(
      'Failed to fetch leads',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }
}
  async fetchLeadConversation(leadId: string) {
    this.logger.log(`Fetching conversation for leadId: ${leadId}`);

    try {
      const lead = await this.prisma.lead.findUnique({
        where: { lead_id: leadId },
        include: {
          conversations: {
            include: {
              emails: {
                include: {
                  attachments: true,
                },
                orderBy: { receivedDateTime: 'asc' },
              },
            },
          },
        },
      });

      if (!lead) {
        throw new HttpException('Lead not found', HttpStatus.NOT_FOUND);
      }

      return {
        leadId: lead.lead_id,
        conversations: lead.conversations.map((conversation) => ({
          conversationId: conversation.conversationId,
          emails: conversation.emails.map((email) => ({
            id: email.id,
            subject: email.subject,
            body: email.body,
            contentType: email.contentType,
            from: email.from,
            to: email.to,
            cc: email.cc,
            bcc: email.bcc,
            hasAttachments: email.hasAttachments,
            receivedDateTime: email.receivedDateTime,
            isIncoming: email.isIncoming,
            isThreadHead: email.isThreadHead,
            attachments: email.attachments.map((att) => ({
              id: att.id,
              fileName: att.fileName,
              cloudinaryUrl: att.cloudinaryUrl,
            })),
          })),
        })),
      };
    } catch (error) {
      this.logger.error(
        `Error fetching conversation for lead ${leadId}: ${error.message}`,
      );
      throw new HttpException(
        'Failed to fetch lead conversation',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
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
      status?: LeadStatus;
      assignedToId?: string | null;
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
          status: data.status,
          assignedToId: data.assignedToId,
        },
        include: {
          assignedTo: {
            select: {
              user_id: true,
              firstName: true,
              lastName: true,
              email: true,
            },
          },
          conversations: {
            include: {
              emails: {
                include: {
                  attachments: true,
                },
              },
            },
          },
        },
      });

      this.logger.log(`Lead ${leadId} updated successfully`);
      return {
        updatedLead,
      };
    } catch (error) {
      this.logger.error(`Error updating lead ${leadId}: ${error.message}`);
      throw new HttpException(
        'Failed to update lead',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
