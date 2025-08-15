import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { AuthService } from 'src/auth/auth.service';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as schedule from 'node-schedule';
import { LeadStatus } from '@prisma/client';
import { LeadService } from 'src/lead/lead.service';

interface GraphReplyDraft {
  id: string;
  conversationId: string;
}

interface EmailTemplate {
  id: string;
  orgId: string;
  name: string;
  subject: string;
  body: string;
  isActive: boolean;
}

interface Lead {
  lead_id: string;
  email: string | null;
  name: string | null;
  company: string | null;
  conversations: { emails: { emailId: string; conversationId: string; isIncoming: boolean }[] }[];
  assignedTo?: { email: string } | null;
}

@Injectable()
export class AutoReplyService {
  private readonly logger = new Logger(AutoReplyService.name);
  private readonly cronMap = {
    EVERY_10_SECONDS: '*/10 * * * * *',
    EVERY_30_MINUTES: '*/30 * * * *',
    EVERY_HOUR: '0 * * * *',
    EVERY_DAY: '0 0 * * *',
  };
  private autoReplyJobs = new Map<string, schedule.Job>();
  private readonly platformName = 'Microsoft';
  private readonly scopes = [
    'Mail.Read',
    'Mail.Send',
    'User.Read.All',
    'Directory.Read.All',
  ];

  constructor(
    private readonly prisma: PrismaService,
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
    private readonly leadService: LeadService,
  ) {
    this.startDynamicAutoReply();
  }

  private async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async getMicrosoftToken(orgId: string): Promise<string> {
    this.logger.log(`Fetching Microsoft app token for org ${orgId}`);
    let clientId = this.configService.get('CLIENT_ID');
    let clientSecret = this.configService.get('CLIENT_SECRET');
    let tenantId = this.configService.get('TENANT_ID');

    try {
      const entraCreds = await this.authService.getEntraCredentials();
      if (entraCreds) {
        clientId = entraCreds.clientId;
        clientSecret = entraCreds.clientSecret;
        tenantId = entraCreds.tenantId;
        this.logger.log(`Using Entra credentials for org ${orgId}`);
      } else {
        this.logger.warn(`No Entra credentials found for org ${orgId}, falling back to .env`);
      }

      if (!clientId || !clientSecret || !tenantId) {
        throw new HttpException('Missing Entra ID credentials', HttpStatus.INTERNAL_SERVER_ERROR);
      }

      const response = await axios.post<{
        access_token: string;
        expires_in: number;
      }>(
        `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
        new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          scope: 'https://graph.microsoft.com/.default',
          grant_type: 'client_credentials',
        }).toString(),
        {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        },
      );

      const { access_token, expires_in } = response.data;
      await this.updateMicrosoftCredentials(orgId, access_token, expires_in, this.scopes, 'LEADS');
      this.logger.log(`App token acquired for org ${orgId}`);
      return access_token;
    } catch (error) {
      this.logger.error(`Failed to get app token: ${error.message}`);
      throw new HttpException('Failed to acquire application token', HttpStatus.INTERNAL_SERVER_ERROR);
    }
  }

  private async updateMicrosoftCredentials(
    orgId: string,
    accessToken: string,
    expiresIn: number,
    scopes: string[],
    type: 'LEADS',
  ) {
    this.logger.log(`Updating Microsoft credentials for org ${orgId}, type: ${type}`);
    const platform = await this.prisma.marketingPlatform.upsert({
      where: { orgId_platform_name: { orgId, platform_name: this.platformName } },
      create: { orgId, platform_name: this.platformName, sync_status: 'CONNECTED' },
      update: { sync_status: 'CONNECTED' },
    });

    const existingCredentials = await this.prisma.platformCredentials.findFirst({
      where: { platform_id: platform.platform_id, user_id: null, type },
    });

    const credentialData = {
      platform_id: platform.platform_id,
      user_id: null,
      type,
      access_token: accessToken,
      refresh_token: null,
      scopes,
      expires_at: new Date(Date.now() + expiresIn * 1000),
    };

    if (existingCredentials) {
      await this.prisma.platformCredentials.update({
        where: { credential_id: existingCredentials.credential_id },
        data: credentialData,
      });
    } else {
      await this.prisma.platformCredentials.create({ data: credentialData });
    }
    this.logger.log(`Credentials updated for org ${orgId}, type: ${type}`);
  }

  private async getPlatformCredentials(orgId: string): Promise<{ creds?: any; needsAuth: boolean; token?: string }> {
    const platform = await this.prisma.marketingPlatform.findFirst({
      where: { orgId, platform_name: this.platformName },
    });

    if (!platform) {
      return { needsAuth: true };
    }

    const creds = await this.prisma.platformCredentials.findFirst({
      where: { platform_id: platform.platform_id, user_id: null, type: 'LEADS' },
    });

    if (!creds) {
      return { needsAuth: true };
    }

    const isExpired = creds.expires_at && new Date(creds.expires_at) < new Date();
    if (!isExpired && creds.access_token) {
      return { creds, needsAuth: false, token: creds.access_token };
    }

    return { creds, needsAuth: true };
  }

  private personalizeTemplate(template: EmailTemplate, lead: Lead): { subject: string; body: string } {
    const replacements = {
      '{{lead.name}}': lead.name || 'Customer',
      '{{lead.email}}': lead.email || '',
      '{{company}}': lead.company || 'Our Company',
    };
    let subject = template.subject;
    let body = template.body;
    for (const [key, value] of Object.entries(replacements)) {
      subject = subject.replace(new RegExp(key, 'g'), value);
      body = body.replace(new RegExp(key, 'g'), value);
    }
    return { subject, body };
  }

  
 private async upsertConversationEmails(
    orgId: string,
    leadId: string,
    conversationId: string,
    mailboxEmail: string,
    token: string,
  ) {
    try {
      const emails = await this.leadService.fetchConversationThread(orgId, mailboxEmail, conversationId, token);
      let conversation = await this.prisma.leadConversation.findFirst({
        where: { conversationId, leadId },
      });

      if (!conversation) {
        this.logger.warn(`No conversation found for lead ${leadId}, creating new one`);
        conversation = await this.prisma.leadConversation.create({
          data: {
            lead: { connect: { lead_id: leadId } },
            conversationId,
          },
        });
      }

      for (const email of emails) {
        // Check if email already exists
        const existingEmail = await this.prisma.conversationEmail.findUnique({
          where: { emailId: email.id },
        });
        if (existingEmail) continue;

        // Check for pending email with matching details
        const pendingEmail = await this.prisma.conversationEmail.findFirst({
          where: {
            conversationId,
            emailId: { startsWith: 'pending-' },
            from: { equals: { name: email.from?.emailAddress?.name || null, email: email.from?.emailAddress?.address || 'unknown' } },
            to: { equals: email.toRecipients?.map((r) => ({ name: r.emailAddress?.name || null, email: r.emailAddress?.address || 'unknown' })) || [] },
            subject: email.subject || 'No Subject',
            body: email.body?.content || email.bodyPreview || '',
          },
        });

        if (pendingEmail) {
          // Update pending email with actual emailId
          await this.prisma.conversationEmail.update({
            where: { id: pendingEmail.id },
            data: {
              emailId: email.id,
              contentType: email.body?.contentType || 'text',
              hasAttachments: email.hasAttachments || false,
              receivedDateTime: new Date(email.receivedDateTime),
              isIncoming: email.from?.emailAddress?.address.toLowerCase() !== mailboxEmail.toLowerCase(),
              isThreadHead: emails[0]?.id === email.id,
              inReplyTo: email.internetMessageId || null,
            },
          });
          this.logger.log(`Updated pending email ${pendingEmail.emailId} to ${email.id} for conversation ${conversationId}`);
          continue;
        }

        // Create new email if no pending match
        const isIncoming = email.from?.emailAddress?.address.toLowerCase() !== mailboxEmail.toLowerCase();
        await this.prisma.conversationEmail.create({
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
            to: email.toRecipients?.map((r) => ({
              name: r.emailAddress?.name || null,
              email: r.emailAddress?.address || 'unknown',
            })) || [],
            cc: email.ccRecipients?.map((r) => ({
              name: r.emailAddress?.name || null,
              email: r.emailAddress?.address || 'unknown',
            })) || [],
            bcc: email.bccRecipients?.map((r) => ({
              name: r.emailAddress?.name || null,
              email: r.emailAddress?.address || 'unknown',
            })) || [],
            hasAttachments: email.hasAttachments || false,
            receivedDateTime: new Date(email.receivedDateTime),
            isIncoming,
            isThreadHead: emails[0]?.id === email.id,
            inReplyTo: email.internetMessageId || null,
          },
        });
      }
      this.logger.log(`Upserted ${emails.length} emails for conversation ${conversationId}`);
    } catch (error) {
      this.logger.error(`Failed to upsert conversation emails for ${conversationId}: ${error.message}`);
    }
  }

async sendAutoReply(
  orgId: string,
  lead: Lead,
  template: EmailTemplate,
  mailbox: string, // Ignored, use admin mailbox
  conversationId: string,
  originalMessageId: string,
  token: string,
): Promise<string | null> {
  try {
    // Use admin mailbox always
    const adminUser = await this.prisma.user.findFirst({
      where: { orgId, role: 'ADMIN' },
      select: { email: true },
    });
    mailbox = adminUser?.email || mailbox;

    if (!originalMessageId || !conversationId) {
      this.logger.error(`Invalid message or conversation ID for lead ${lead.lead_id}`);
      return null;
    }

    // Validate originalMessageId exists
    const originalEmail = await this.prisma.conversationEmail.findFirst({
      where: { emailId: originalMessageId, conversation: { conversationId } },
    });
    if (!originalEmail) {
      this.logger.error(`Original message ${originalMessageId} not found for conversation ${conversationId}`);
      return null;
    }

    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    if (!emailRegex.test(mailbox) || mailbox.includes('gmail.com')) {
      this.logger.error(`Invalid mailbox ${mailbox} for lead ${lead.lead_id}`);
      return null;
    }

    let leadEmail = lead.email;
    if (!leadEmail || !emailRegex.test(leadEmail)) {
      const conversation = await this.prisma.leadConversation.findFirst({
        where: { conversationId, leadId: lead.lead_id },
        include: { emails: { where: { isIncoming: true }, take: 1 } },
      });
      leadEmail = (conversation?.emails[0]?.from as { email: string } | undefined)?.email || mailbox;
      this.logger.log(`Falling back to sender email ${leadEmail} for lead ${lead.lead_id}`);
    }

    const { subject, body } = this.personalizeTemplate(template, { ...lead, email: leadEmail });
    if (!body.trim() || !subject.trim()) {
      this.logger.error(`Empty template body/subject for lead ${lead.lead_id}`);
      return null;
    }

    // Save auto-reply attempt to DB immediately
    let conversation = await this.prisma.leadConversation.findFirst({
      where: { conversationId, leadId: lead.lead_id },
    });
    if (!conversation) {
      conversation = await this.prisma.leadConversation.create({
        data: {
          lead: { connect: { lead_id: lead.lead_id } },
          conversationId,
        },
      });
    }

    const pendingEmailId = `pending-${conversationId}-${Date.now()}`;
    await this.prisma.conversationEmail.create({
      data: {
        conversation: { connect: { id: conversation.id } },
        emailId: pendingEmailId,
        subject,
        body,
        contentType: 'Text',
        from: { name: null, email: mailbox },
        to: [{ name: null, email: leadEmail }],
        cc: [],
        bcc: [],
        hasAttachments: false,
        receivedDateTime: new Date(),
        isIncoming: false,
        isThreadHead: false,
        inReplyTo: originalMessageId,
      },
    });

    let emailId: string | null = null;
    this.logger.log(`Sending auto-reply to ${leadEmail} from ${mailbox} for conversation ${conversationId}`);

    try {
      await axios.post(
        `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages/${originalMessageId}/reply`,
        {
          message: {
            subject,
            body: { contentType: 'Text', content: body },
            toRecipients: [{ emailAddress: { address: leadEmail } }],
            conversationId,
          },
        },
        { headers: { Authorization: `Bearer ${token}` } },
      );
      await this.delay(3000);
      const sentItems = await axios.get(
        `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/mailFolders/sentitems/messages`,
        {
          headers: { Authorization: `Bearer ${token}` },
          params: { $top: 10, $orderby: 'createdDateTime desc' },
        },
      );
      const sentItemsData = sentItems.data as { value: { id?: string; createdDateTime?: string; conversationId?: string }[] };
      emailId = sentItemsData.value.find((item) => item.conversationId === conversationId)?.id || null;
      this.logger.log(`Reply sent for lead ${lead.lead_id}, emailId: ${emailId || 'none'}`);
    } catch (error) {
      this.logger.error(`Reply error for lead ${lead.lead_id}: ${JSON.stringify(error.response?.data || error.message)}`);
      if (error.response?.status === 429) {
        await this.delay(2000);
        return this.sendAutoReply(orgId, lead, template, mailbox, conversationId, originalMessageId, token);
      }
      this.logger.log(`Falling back to sendMail for lead ${lead.lead_id}`);
      try {
        await axios.post(
          `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/sendMail`,
          {
            message: {
              subject,
              body: { contentType: 'Text', content: body },
              toRecipients: [{ emailAddress: { address: leadEmail } }],
              conversationId,
              inReplyTo: { id: originalMessageId },
            },
            saveToSentItems: true,
          },
          { headers: { Authorization: `Bearer ${token}` } },
        );
        await this.delay(3000);
        const sentItems = await axios.get(
          `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/mailFolders/sentitems/messages`,
          {
            headers: { Authorization: `Bearer ${token}` },
            params: { $top: 10, $orderby: 'createdDateTime desc' },
          },
        );
        const sentItemsData = sentItems.data as { value: { id?: string; createdDateTime?: string; conversationId?: string }[] };
        emailId = sentItemsData.value.find((item) => item.conversationId === conversationId)?.id || null;
        this.logger.log(`Fallback sendMail sent for lead ${lead.lead_id}, emailId: ${emailId || 'none'}`);
      } catch (fallbackError) {
        this.logger.error(`Fallback failed for lead ${lead.lead_id}: ${JSON.stringify(fallbackError.response?.data || fallbackError.message)}`);
      }
    }

    // Update emailId if found
    if (emailId) {
      await this.prisma.conversationEmail.update({
        where: { emailId: pendingEmailId },
        data: { emailId },
      });
    }

    // Fetch and upsert full conversation
    await this.upsertConversationEmails(orgId, lead.lead_id, conversationId, mailbox, token);

    return emailId || pendingEmailId;
  } catch (error) {
    this.logger.error(`Overall error in sendAutoReply for lead ${lead.lead_id}: ${error.message}`);
    return null;
  }
}

  private async fetchConfig(configId: string) {
    return this.prisma.autoReplyConfig.findUnique({
      where: { id: configId },
      include: { template: true, organization: { select: { sharedMailbox: true } } },
    });
  }

  private async fetchLeadsAndConfig(orgId: string) {
    const leadConfig = await this.prisma.leadConfiguration.findUnique({
      where: { orgId },
      select: { specialEmails: true, excludedEmails: true },
    });
    const leads = await this.prisma.lead.findMany({
      where: {
        orgId,
        status: LeadStatus.NEW,
        conversations: { some: { emails: { every: { isIncoming: true } } } },
      },
      include: {
        conversations: {
          include: { emails: { select: { id: true, isIncoming: true, emailId: true, conversationId: true, inReplyTo: true } } },
        },
        assignedTo: { select: { email: true } },
      },
    });
    return {
      leads,
      specialEmails: (leadConfig?.specialEmails || []).map((e) => e.toLowerCase()),
      excludedEmails: (leadConfig?.excludedEmails || []).map((e) => e.toLowerCase()),
    };
  }

  private shouldSkipLead(lead: Lead, specialEmails: string[], excludedEmails: string[]): boolean {
    const leadEmail = lead.email?.toLowerCase();
    return typeof leadEmail === 'string' && (specialEmails.includes(leadEmail) || excludedEmails.includes(leadEmail));
  }

  private hasExistingReply(lead: Lead): boolean {
    return lead.conversations.some((conv) => conv.emails.some((email) => !email.isIncoming));
  }

 async processAutoReplies(orgId: string, configId: string) {
  this.logger.log(`Processing auto-replies for org ${orgId}, config ${configId}`);
  try {
    const config = await this.fetchConfig(configId);
    if (!config || !config.isActive) {
      this.logger.log(`Auto-reply config ${configId} is inactive or invalid`);
      return;
    }
    if (config.triggerType !== 'NEW_LEAD_ONE_EMAIL') {
      this.logger.log(`Unsupported trigger type: ${config.triggerType}`);
      return;
    }

    const credResult = await this.getPlatformCredentials(orgId);
    let token: string;
    if (!credResult.needsAuth && credResult.token) {
      token = credResult.token;
    } else {
      token = await this.getMicrosoftToken(orgId);
    }

    const { leads, specialEmails, excludedEmails } = await this.fetchLeadsAndConfig(orgId);

    // Changed: Fetch admin mailbox once
    const adminUser = await this.prisma.user.findFirst({
      where: { orgId, role: 'ADMIN' },
      select: { email: true },
    });
    const adminMailbox = adminUser?.email || config.organization.sharedMailbox;
    if (!adminMailbox) {
      this.logger.warn(`No admin mailbox found for org ${orgId}, skipping all auto-replies`);
      return;
    }

    for (const lead of leads) {
      try {
        if (this.shouldSkipLead(lead, specialEmails, excludedEmails)) {
          this.logger.log(`Skipping auto-reply for lead ${lead.lead_id} with email ${lead.email}`);
          continue;
        }

        const conversation = lead.conversations.find(
          (conv) => conv.emails.length === 1 && conv.emails[0].isIncoming,
        );
        if (!conversation) {
          this.logger.log(`Lead ${lead.lead_id} has no valid single-email conversation`);
          continue;
        }

        if (this.hasExistingReply(lead)) {
          this.logger.log(`Lead ${lead.lead_id} already has a reply`);
          continue;
        }

        // Use adminMailbox
        const emailId = await this.sendAutoReply(
          orgId,
          lead,
          config.template,
          adminMailbox,
          conversation.conversationId,
          conversation.emails[0].emailId || '',
          token,
        );
        if (emailId) {
          await this.prisma.lead.update({
            where: { lead_id: lead.lead_id },
            data: { status: LeadStatus.CONTACTED, updated_at: new Date() },
          });
        }
        await this.delay(200);
      } catch (leadError) {
        this.logger.error(`Error processing lead ${lead.lead_id}: ${leadError.message}`);
        // Silence: Continue to next lead
      }
    }
    this.logger.log(`Completed auto-reply processing for org ${orgId}`);
  } catch (error) {
    this.logger.error(`Overall error processing auto-replies for org ${orgId}: ${error.message}`);
    // Silence: No throw
  }
}

  private async startDynamicAutoReply() {
    this.logger.log('Starting dynamic auto-reply for organizations');
    try {
      const configs = await this.prisma.autoReplyConfig.findMany({
        where: { isActive: true },
        select: { id: true, orgId: true, schedule: true },
      });

      for (const config of configs) {
        if (!config.schedule) {
          this.logger.log(`No schedule defined for auto-reply config ${config.id}`);
          continue;
        }
        await this.scheduleAutoReply(config.orgId, config.id, config.schedule);
      }
    } catch (error) {
      this.logger.error(`Error starting dynamic auto-reply: ${error.message}`);
    }
  }

  private async scheduleAutoReply(orgId: string, configId: string, scheduleInterval: string) {
    const config = await this.prisma.autoReplyConfig.findUnique({
      where: { id: configId },
      select: { isActive: true, schedule: true },
    });

    if (!config?.isActive) {
      this.logger.log(`Auto-reply config ${configId} is inactive, skipping scheduling`);
      return;
    }

    const jobKey = `${orgId}:${configId}`;
    this.autoReplyJobs.get(jobKey)?.cancel();
    this.logger.log(`Cancelled old auto-reply job for ${jobKey}`);

    const cronExpression = this.cronMap[scheduleInterval] || this.cronMap.EVERY_HOUR;
    this.logger.log(`Scheduling auto-reply for org ${orgId}, config ${configId} with ${cronExpression}`);

    const job = schedule.scheduleJob(cronExpression, async () => {
      this.logger.log(`Running auto-reply job for org ${orgId}, config ${configId}`);
      await this.processAutoReplies(orgId, configId);
    });
    this.autoReplyJobs.set(jobKey, job);
  }

  async getConfigs(orgId: string) {
    return this.prisma.autoReplyConfig.findMany({
      where: { orgId },
      include: { template: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getByTriggerType(orgId: string, triggerType: string) {
    return this.prisma.autoReplyConfig.findMany({
      where: { orgId, triggerType },
      include: { template: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createConfig(
    orgId: string,
    userId: string,
    name: string,
    description: string | null,
    triggerType: string,
    templateId: string,
    mailbox: boolean,
    schedule: string,
  ) {
    const user = await this.prisma.user.findUnique({ where: { user_id: userId } });
    const template = await this.prisma.emailTemplate.findUnique({ where: { id: templateId } });
    if (!template || template.orgId !== orgId) {
      throw new HttpException('Invalid or inaccessible template', HttpStatus.BAD_REQUEST);
    }
    if (!Object.keys(this.cronMap).includes(schedule)) {
      throw new HttpException('Invalid schedule interval', HttpStatus.BAD_REQUEST);
    }

    const config = await this.prisma.autoReplyConfig.create({
      data: {
        orgId,
        name,
        description,
        triggerType,
        triggerValue: null,
        templateId,
        mailbox,
        schedule,
        isActive: false,
      },
      include: { template: true },
    });

    await this.scheduleAutoReply(orgId, config.id, schedule);
    this.logger.log(`Auto-reply config created for org ${orgId}: ${name}`);
    return config;
  }

  async updateConfig(
    orgId: string,
    userId: string,
    configId: string,
    name?: string,
    description?: string | null,
    triggerType?: string,
    templateId?: string,
    mailbox?: boolean,
    schedule?: string,
    isActive?: boolean,
  ) {
    const user = await this.prisma.user.findUnique({ where: { user_id: userId } });
    if (!user || user.role !== 'ADMIN') {
      throw new ForbiddenException('Only admins can update auto-reply configs');
    }

    const config = await this.prisma.autoReplyConfig.findUnique({
      where: { id: configId },
      select: { orgId: true },
    });
    if (!config || config.orgId !== orgId) {
      throw new HttpException('Auto-reply config not found', HttpStatus.NOT_FOUND);
    }

    if (templateId) {
      const template = await this.prisma.emailTemplate.findUnique({ where: { id: templateId } });
      if (!template || template.orgId !== orgId) {
        throw new HttpException('Invalid or inaccessible template', HttpStatus.BAD_REQUEST);
      }
    }

    if (schedule && !Object.keys(this.cronMap).includes(schedule)) {
      throw new HttpException('Invalid schedule interval', HttpStatus.BAD_REQUEST);
    }

    const updatedConfig = await this.prisma.autoReplyConfig.update({
      where: { id: configId },
      data: { name, description, triggerType, templateId, mailbox, schedule, isActive },
      include: { template: true },
    });

    if (schedule || isActive !== undefined) {
      await this.scheduleAutoReply(orgId, configId, updatedConfig.schedule || 'EVERY_HOUR');
    }

    this.logger.log(`Auto-reply config ${configId} updated for org ${orgId}`);
    return updatedConfig;
  }

  async deleteConfig(orgId: string, userId: string, configId: string) {
    const user = await this.prisma.user.findUnique({ where: { user_id: userId } });
    if (!user || user.role !== 'ADMIN') {
      throw new ForbiddenException('Only admins can delete auto-reply configs');
    }

    const config = await this.prisma.autoReplyConfig.findUnique({
      where: { id: configId },
      select: { orgId: true },
    });
    if (!config || config.orgId !== orgId) {
      throw new HttpException('Auto-reply config not found', HttpStatus.NOT_FOUND);
    }

    await this.prisma.autoReplyConfig.delete({ where: { id: configId } });
    const jobKey = `${orgId}:${configId}`;
    this.autoReplyJobs.get(jobKey)?.cancel();
    this.autoReplyJobs.delete(jobKey);
    this.logger.log(`Cancelled auto-reply job for ${jobKey}`);
    return { message: 'Auto-reply config deleted successfully' };
  }
}