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

interface EmailTemplate {
  id: string;
  orgId: string;
  name: string;
  subject: string;
  body: string;
  isActive: boolean;
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
    this.startDynamicAutoReply();
  }

  private async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Fetch platform credentials (same as LeadService)
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

  // Personalize email template
  private personalizeTemplate(
    template: EmailTemplate,
    lead: any,
  ): { subject: string; body: string } {
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

  // Send auto-reply email via Microsoft Graph
  private async sendAutoReply(
    orgId: string,
    lead: any,
    template: EmailTemplate,
    mailbox: string,
    conversationId: string,
    originalMessageId: string,
    token: string,
  ): Promise<void> {
    try {
      if (!originalMessageId) {
        this.logger.error(`No valid originalMessageId for lead ${lead.lead_id}`);
        throw new HttpException('Invalid original message ID', HttpStatus.BAD_REQUEST);
      }
      if (!conversationId) {
        this.logger.error(`No valid conversationId for lead ${lead.lead_id}`);
        throw new HttpException('Invalid conversation ID', HttpStatus.BAD_REQUEST);
      }
      this.logger.log(`Sending reply to message ID ${originalMessageId} for ${lead.email}`);
      const { body } = this.personalizeTemplate(template, lead);
      const response = await axios.post(
        `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/messages/${originalMessageId}/reply`,
        {
          message: {
            body: {
              contentType: 'Text',
              content: body,
            },
            toRecipients: [{ emailAddress: { address: lead.email } }],
            conversationId,
          },
        },
        {
          headers: { Authorization: `Bearer ${token}` },
        },
      );
      this.logger.log(
        `Auto-reply sent as reply to ${lead.email} for lead ${lead.lead_id}`,
        JSON.stringify({ status: response.status, data: response.data }, null, 2),
      );
    } catch (error) {
      this.logger.error(
        `Failed to send auto-reply to ${lead.email}: ${error.message}`,
        JSON.stringify(error.response?.data, null, 2),
      );
      // Fallback to sendMail with inReplyTo
      try {
        const { body } = this.personalizeTemplate(template, lead);
        const fallbackResponse = await axios.post(
          `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox)}/sendMail`,
          {
            message: {
              body: {
                contentType: 'Text',
                content: body,
              },
              toRecipients: [{ emailAddress: { address: lead.email } }],
              conversationId,
              inReplyTo: { id: originalMessageId },
            },
            saveToSentItems: true,
          },
          {
            headers: { Authorization: `Bearer ${token}` },
          },
        );
        this.logger.log(
          `Fallback auto-reply sent to ${lead.email} for lead ${lead.lead_id}`,
          JSON.stringify({ status: fallbackResponse.status, data: fallbackResponse.data }, null, 2),
        );
      } catch (fallbackError) {
        this.logger.error(
          `Fallback sendMail failed for ${lead.email}: ${fallbackError.message}`,
          JSON.stringify(fallbackError.response?.data, null, 2),
        );
        throw fallbackError;
      }
    }
  }

  // Process auto-replies for eligible leads
  async processAutoReplies(orgId: string, configId: string) {
    this.logger.log(
      `Processing auto-replies for org ${orgId}, config ${configId}`,
    );

    try {
      const config = await this.prisma.autoReplyConfig.findUnique({
        where: { id: configId },
        include: { template: true },
      });
      this.logger.log(`Auto-reply config: ${JSON.stringify(config)}`);
      if (!config || !config.isActive) {
        this.logger.log(`Auto-reply config ${configId} is inactive or invalid`);
        return;
      }

      if (config.triggerType !== 'NEW_LEAD_ONE_EMAIL') {
        this.logger.log(`Unsupported trigger type: ${config.triggerType}`);
        return;
      }

      // Validate credentials
      const credResult = await this.getPlatformCredentials(orgId);
      if (credResult.needsAuth) {
        this.logger.warn(
          `Org ${orgId} needs to re-authenticate for auto-reply`,
        );
        return;
      }

      const token = await this.authService.getMicrosoftToken(
        orgId,
        this.scopes,
      );

      // Fetch leads with status NEW and exactly one incoming email
      const leads = await this.prisma.lead.findMany({
        where: {
          orgId,
          status: LeadStatus.NEW,
          conversations: {
            some: {
              emails: {
                every: { isIncoming: true },
              },
            },
          },
        },
        include: {
          conversations: {
            include: {
              emails: {
                select: {
                  id: true,
                  isIncoming: true,
                  emailId: true,
                  conversationId: true,
                  inReplyTo: true,
                },
              },
            },
          },
        },
      });

      for (const lead of leads) {
        const conversation = lead.conversations.find(
          (conv) => conv.emails.length === 1 && conv.emails[0].isIncoming,
        );

        if (!conversation) {
          this.logger.log(
            `Lead ${lead.lead_id} has no valid single-email conversation`,
          );
          continue;
        }

        // Check for existing replies to prevent duplicates
        const hasReply = lead.conversations.some((conv) =>
          conv.emails.some((email) => !email.isIncoming),
        );
        if (hasReply) {
          this.logger.log(`Lead ${lead.lead_id} already has a reply`);
          continue;
        }

        try {
          await this.sendAutoReply(
            orgId,
            lead,
            config.template,
            config.mailbox!,
            conversation.conversationId,
            conversation.emails[0].emailId || '',
            token,
          );

          // Update lead status to CONTACTED
          await this.prisma.lead.update({
            where: { lead_id: lead.lead_id },
            data: { status: LeadStatus.CONTACTED, updated_at: new Date() },
          });
          this.logger.log(
            `Lead ${lead.lead_id} status updated to CONTACTED after auto-reply`,
          );

          // Delay to avoid rate limits
          await this.delay(200);
        } catch (error) {
          this.logger.error(
            `Failed to process auto-reply for lead ${lead.lead_id}: ${error.message}`,
          );
          // Continue with next lead
        }
      }

      this.logger.log(`Completed auto-reply processing for org ${orgId}`);
    } catch (error) {
      this.logger.error(
        `Error processing auto-replies for org ${orgId}: ${error.message}`,
      );
    }
  }

  // Start dynamic auto-reply scheduling
  private async startDynamicAutoReply() {
    this.logger.log('Starting dynamic auto-reply for organizations');

    try {
      const configs = await this.prisma.autoReplyConfig.findMany({
        where: { isActive: true },
        select: { id: true, orgId: true, schedule: true },
      });

      for (const config of configs) {
        if (!config.schedule) {
          this.logger.log(
            `No schedule defined for auto-reply config ${config.id}`,
          );
          continue;
        }
        await this.scheduleAutoReply(config.orgId, config.id, config.schedule);
      }
    } catch (error) {
      this.logger.error(
        `Error starting dynamic auto-reply: ${error.message}`,
        error.stack,
      );
    }
  }

  // Schedule auto-reply job
  async scheduleAutoReply(
    orgId: string,
    configId: string,
    scheduleInterval: string,
  ) {
    const config = await this.prisma.autoReplyConfig.findUnique({
      where: { id: configId },
      select: { isActive: true },
    });

    if (!config?.isActive) {
      this.logger.log(
        `Auto-reply config ${configId} is inactive, skipping scheduling`,
      );
      return;
    }

    const jobKey = `${orgId}:${configId}`;
    const existingJob = this.autoReplyJobs.get(jobKey);
    if (existingJob) {
      existingJob.cancel();
      this.logger.log(`Cancelled old auto-reply job for ${jobKey}`);
    }

    const cronExpression =
      this.cronMap[scheduleInterval] || this.cronMap.EVERY_HOUR;
    this.logger.log(
      `Scheduling auto-reply for org ${orgId}, config ${configId} with ${scheduleInterval} (${cronExpression})`,
    );

    const job = schedule.scheduleJob(cronExpression, async () => {
      this.logger.log(
        `Running auto-reply job for org ${orgId}, config ${configId}`,
      );
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
    templateId: string,
    mailbox: string,
    schedule: string,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
    });
    if (!user || user.role !== 'ADMIN') {
      throw new ForbiddenException('Only admins can create auto-reply configs');
    }

    const template = await this.prisma.emailTemplate.findUnique({
      where: { id: templateId },
    });
    if (!template || template.orgId !== orgId) {
      throw new HttpException(
        'Invalid or inaccessible template',
        HttpStatus.BAD_REQUEST,
      );
    }

    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { sharedMailbox: true },
    });
    if (!org || org.sharedMailbox !== mailbox) {
      throw new HttpException(
        'Invalid mailbox for organization',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!Object.keys(this.cronMap).includes(schedule)) {
      throw new HttpException(
        'Invalid schedule interval',
        HttpStatus.BAD_REQUEST,
      );
    }

    const existingConfig = await this.prisma.autoReplyConfig.findFirst({
      where: { orgId, triggerType: 'NEW_LEAD_ONE_EMAIL' },
    });

    if (existingConfig) {
      throw new HttpException(
        'Auto-reply config for NEW_LEAD_ONE_EMAIL already exists',
        HttpStatus.CONFLICT,
      );
    }

    const config = await this.prisma.autoReplyConfig.create({
      data: {
        orgId,
        triggerType: 'NEW_LEAD_ONE_EMAIL',
        triggerValue: null,
        templateId,
        mailbox,
        schedule,
        isActive: true,
      },
      include: { template: true },
    });

    await this.scheduleAutoReply(orgId, config.id, schedule);
    this.logger.log(`Auto-reply config created for org ${orgId}`);
    return config;
  }

  // Update auto-reply config
  async updateConfig(
    orgId: string,
    userId: string,
    configId: string,
    templateId?: string,
    mailbox?: string,
    schedule?: string,
    isActive?: boolean,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
    });
    if (!user || user.role !== 'ADMIN') {
      throw new ForbiddenException('Only admins can update auto-reply configs');
    }

    const config = await this.prisma.autoReplyConfig.findUnique({
      where: { id: configId },
      select: { orgId: true },
    });
    if (!config || config.orgId !== orgId) {
      throw new HttpException(
        'Auto-reply config not found',
        HttpStatus.NOT_FOUND,
      );
    }

    if (templateId) {
      const template = await this.prisma.emailTemplate.findUnique({
        where: { id: templateId },
      });
      if (!template || template.orgId !== orgId) {
        throw new HttpException(
          'Invalid or inaccessible template',
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    if (mailbox) {
      const org = await this.prisma.organization.findUnique({
        where: { id: orgId },
        select: { sharedMailbox: true },
      });
      if (!org || org.sharedMailbox !== mailbox) {
        throw new HttpException(
          'Invalid mailbox for organization',
          HttpStatus.BAD_REQUEST,
        );
      }
    }

    if (schedule && !Object.keys(this.cronMap).includes(schedule)) {
      throw new HttpException(
        'Invalid schedule interval',
        HttpStatus.BAD_REQUEST,
      );
    }

    const updatedConfig = await this.prisma.autoReplyConfig.update({
      where: { id: configId },
      data: {
        templateId,
        mailbox,
        schedule,
        isActive,
      },
      include: { template: true },
    });

    if (schedule || isActive !== undefined) {
      await this.scheduleAutoReply(
        orgId,
        configId,
        updatedConfig.schedule || 'EVERY_HOUR',
      );
    }

    this.logger.log(`Auto-reply config ${configId} updated for org ${orgId}`);
    return updatedConfig;
  }

  // Delete auto-reply config
  async deleteConfig(orgId: string, userId: string, configId: string) {
    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
    });
    if (!user || user.role !== 'ADMIN') {
      throw new ForbiddenException('Only admins can delete auto-reply configs');
    }

    const config = await this.prisma.autoReplyConfig.findUnique({
      where: { id: configId },
      select: { orgId: true },
    });
    if (!config || config.orgId !== orgId) {
      throw new HttpException(
        'Auto-reply config not found',
        HttpStatus.NOT_FOUND,
      );
    }

    await this.prisma.autoReplyConfig.delete({
      where: { id: configId },
    });

    const jobKey = `${orgId}:${configId}`;
    const job = this.autoReplyJobs.get(jobKey);
    if (job) {
      job.cancel();
      this.autoReplyJobs.delete(jobKey);
      this.logger.log(`Cancelled auto-reply job for ${jobKey}`);
    }

    this.logger.log(`Auto-reply config ${configId} deleted for org ${orgId}`);
    return { message: 'Auto-reply config deleted successfully' };
  }
}
