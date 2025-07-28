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
import * as striptags from 'striptags';
import Bottleneck from 'bottleneck';
import pLimit from 'p-limit';

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
    _sourceMailbox?: string; // Added
    _sourceFolder?: string;
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

interface GraphUsersResponse {
  value: {
    id: string;
    mail: string | null;
    userPrincipalName: string;
  }[];
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
  private runningSyncs = new Set<string>();
  private readonly platformName = 'Microsoft';
  private readonly limiter = new Bottleneck({
    maxConcurrent: 10, // Allow up to 10 concurrent requests
    minTime: 100, // Minimum 100ms between requests (adjust based on rate limits)
  });
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
      throw new Error('Shared mailbox not configured');
    }

    return { valid: true, sharedMailbox: org.sharedMailbox };
  }

  private async getMicrosoftToken(orgId: string) {
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
        this.logger.warn(
          `No Entra credentials found for org ${orgId}, falling back to .env`,
        );
      }

      if (!clientId || !clientSecret || !tenantId) {
        throw new Error('Missing Entra ID credentials');
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

      await this.updateMicrosoftCredentials(
        orgId,
        access_token,
        expires_in,
        ['Mail.Read', 'Mail.Send', 'User.Read.All'],
        'LEADS',
      );

      this.logger.log(`App token acquired for org ${orgId}`);
      return access_token;
    } catch (error) {
      this.logger.error(`Failed to get app token: ${error.message}`);
      throw new Error('Failed to acquire application token');
    }
  }

  private async updateMicrosoftCredentials(
    orgId: string,
    accessToken: string,
    expiresIn: number,
    scopes: string[],
    type: 'LEADS',
  ) {
    this.logger.log(
      `Updating Microsoft credentials for org ${orgId}, type: ${type}`,
    );

    const platform = await this.prisma.marketingPlatform.upsert({
      where: {
        orgId_platform_name: {
          orgId,
          platform_name: this.platformName,
        },
      },
      create: {
        orgId,
        platform_name: this.platformName,
        sync_status: 'CONNECTED',
      },
      update: {
        sync_status: 'CONNECTED',
      },
    });

    const existingCredentials = await this.prisma.platformCredentials.findFirst(
      {
        where: {
          platform_id: platform.platform_id,
          user_id: null,
          type,
        },
      },
    );

    if (existingCredentials) {
      await this.prisma.platformCredentials.update({
        where: { credential_id: existingCredentials.credential_id },
        data: {
          access_token: accessToken,
          refresh_token: null,
          scopes,
          expires_at: new Date(Date.now() + expiresIn * 1000),
        },
      });
    } else {
      await this.prisma.platformCredentials.create({
        data: {
          platform_id: platform.platform_id,
          user_id: null,
          type,
          access_token: accessToken,
          refresh_token: null,
          scopes,
          expires_at: new Date(Date.now() + expiresIn * 1000),
        },
      });
    }

    this.logger.log(`Credentials updated for org ${orgId}, type: ${type}`);
  }

  private async getPlatformCredentials(
    orgId: string,
  ): Promise<{ access_token: string; scopes: string[] }> {
    const platform = await this.prisma.marketingPlatform.findFirst({
      where: { orgId, platform_name: this.platformName },
    });

    if (!platform) {
      this.logger.log(
        `No marketing platform found for org ${orgId}, creating token`,
      );
      return {
        access_token: await this.getMicrosoftToken(orgId),
        scopes: ['Mail.Read', 'Mail.Send', 'User.Read.All'],
      };
    }

    const creds = await this.prisma.platformCredentials.findFirst({
      where: {
        platform_id: platform.platform_id,
        user_id: null,
        type: 'LEADS',
      },
    });

    const isExpired =
      creds?.expires_at && new Date(creds.expires_at) < new Date();
    if (!creds || isExpired || !creds.access_token) {
      this.logger.log(
        `Token missing, expired, or invalid for org ${orgId}, refreshing`,
      );
      return {
        access_token: await this.getMicrosoftToken(orgId),
        scopes: ['Mail.Read', 'Mail.Send', 'User.Read.All'],
      };
    }

    return { access_token: creds.access_token, scopes: creds.scopes };
  }

  private async getMailboxes(
    orgId: string,
    sharedMailbox: string,
    token: string,
  ): Promise<Mailbox[]> {
    try {
      const response = await axios.get<GraphUsersResponse>(
        'https://graph.microsoft.com/v1.0/users',
        {
          headers: { Authorization: `Bearer ${token}` },
          params: {
            $select: 'id,mail,userPrincipalName',
            $filter: "userType eq 'Member'",
          },
        },
      );

      const users = response.data.value;
      const members = await this.prisma.user.findMany({
        where: { orgId, allowPersonalEmailSync: true },
        select: { user_id: true, email: true },
      });

      const mailboxes: Mailbox[] = [
        { email: sharedMailbox, assignedToId: null, label: 'Shared Mailbox' },
        ...users
          .map((user) => {
            const email = user.mail || user.userPrincipalName;
            const member = members.find(
              (m) => m.email.toLowerCase() === email.toLowerCase(),
            );
            return member
              ? {
                  email,
                  assignedToId: member.user_id as string | null, // Explicitly match Mailbox type
                  label: `${email}’s Inbox`,
                }
              : null;
          })
          .filter((mailbox): mailbox is Mailbox => mailbox !== null),
      ];

      return mailboxes;
    } catch (error) {
      return [
        { email: sharedMailbox, assignedToId: null, label: 'Shared Mailbox' },
      ];
    }
  }

  private async getFolders(
    orgId: string,
    token: string,
    mailboxEmail: string,
  ): Promise<Folder[]> {
    const leadConfig = await this.prisma.leadConfiguration.findUnique({
      where: { orgId },
    });

    const configuredFolders: Record<string, { id: string; name: string }[]> =
      (leadConfig?.folders as Record<string, { id: string; name: string }[]>) ||
      {};
    const mailboxFolders = configuredFolders[mailboxEmail.toLowerCase()] || [];

    if (mailboxFolders.length > 0) {
      try {
        const batchRequest = {
          requests: mailboxFolders.map((folder, i) => ({
            id: `folder_${i}`,
            method: 'GET',
            url: `/users/${encodeURIComponent(mailboxEmail)}/mailFolders/${folder.id}`,
          })),
        };
        const response = await this.limiter.schedule(() =>
          axios.post<{
            responses: {
              id: string;
              status: number;
              body: { id: string; displayName: string };
            }[];
          }>('https://graph.microsoft.com/v1.0/$batch', batchRequest, {
            headers: { Authorization: `Bearer ${token}` },
          }),
        );

        const validFolders: Folder[] = response.data.responses
          .map((res, i) => {
            if (res.status < 400) {
              return {
                id: mailboxFolders[i].id,
                name: mailboxFolders[i].name, // Use stored name
              };
            }
            return null;
          })
          .filter((folder): folder is Folder => folder !== null);

        if (validFolders.length > 0) {
          return validFolders;
        }
      } catch (error) {
        // Fall through to fetch fresh folders
      }
    }

    // Fetch fresh folders if none configured or validation failed
    const freshFolders = await this.listMailboxFolders(orgId, mailboxEmail);

    // Update LeadConfiguration with fresh folders
    await this.prisma.leadConfiguration.upsert({
      where: { orgId },
      update: {
        folders: {
          ...configuredFolders,
          [mailboxEmail.toLowerCase()]: freshFolders.map((f) => ({
            id: f.id,
            name: f.name,
          })),
        },
      },
      create: {
        orgId,
        folders: {
          [mailboxEmail.toLowerCase()]: freshFolders.map((f) => ({
            id: f.id,
            name: f.name,
          })),
        },
        syncInterval: 'EVERY_HOUR',
        filters: ['inquiry', 'interested', 'quote', 'sales', 'meeting'],
      },
    });

    return freshFolders;
  }
  private async fetchConversationThread(
    orgId: string,
    mailboxEmail: string,
    conversationId: string,
    token: string,
  ): Promise<GraphEmailResponse['value']> {
    try {
      const folderResponse = await this.limiter.schedule(() =>
        axios.get<{
          value: { id: string; displayName: string; wellKnownName?: string }[];
        }>(
          `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailboxEmail)}/mailFolders`,
          {
            headers: { Authorization: `Bearer ${token}` },
            params: { $top: 100 },
          },
        ),
      );

      const folders = folderResponse.data.value.map((folder) => ({
        id: folder.id,
        name: folder.displayName,
      }));

      const fetchEmailsFromFolder = async (
        folder: Folder,
        email: string,
      ): Promise<GraphEmailResponse['value']> => {
        let url = `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(email)}/mailFolders/${folder.id}/messages`;
        let messageIds: { id: string }[] = [];
        do {
          try {
            const response = await this.limiter.schedule(() =>
              axios.get<{
                value: { id: string }[];
                '@odata.nextLink'?: string;
              }>(url, {
                headers: { Authorization: `Bearer ${token}` },
                params: {
                  $filter: `conversationId eq '${conversationId}'`,
                  $select: 'id',
                  $top: 50,
                },
              }),
            );
            messageIds = messageIds.concat(response.data.value);
            url = response.data['@odata.nextLink'] || '';
          } catch (error) {
            break;
          }
        } while (url);

        const emailPromises = messageIds.map(({ id }) =>
          this.limiter.schedule(async () => {
            try {
              const emailResponse = await axios.get<
                GraphEmailResponse['value'][0]
              >(
                `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(email)}/messages/${id}`,
                {
                  headers: { Authorization: `Bearer ${token}` },
                  params: {
                    $select:
                      'id,subject,from,toRecipients,ccRecipients,bccRecipients,receivedDateTime,body,bodyPreview,hasAttachments,conversationId,internetMessageId',
                  },
                },
              );
              const emailData = emailResponse.data;
              if (emailData.hasAttachments) {
                const attachmentResponse = await this.limiter.schedule(() =>
                  axios.get<AttachmentResponse>(
                    `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(email)}/messages/${id}/attachments`,
                    { headers: { Authorization: `Bearer ${token}` } },
                  ),
                );
                emailData.attachments = attachmentResponse.data.value;
              }
              return emailData;
            } catch (error) {
              return undefined;
            }
          }),
        );

        return (await Promise.all(emailPromises)).filter(
          (email): email is GraphEmailResponse['value'][0] =>
            email !== undefined,
        );
      };

      let allEmails = (
        await Promise.all(
          folders.map((folder) =>
            this.limiter.schedule(() =>
              fetchEmailsFromFolder(folder, mailboxEmail),
            ),
          ),
        )
      ).flat();

      if (allEmails.length === 0) {
        const mailboxes = await this.getMailboxes(orgId, mailboxEmail, token);
        const altMailboxes = mailboxes.filter((m) => m.email !== mailboxEmail);
        const altEmailPromises = await Promise.all(
          altMailboxes.map(async (altMailbox) => {
            const response = await this.limiter.schedule(() =>
              axios.get<{
                value: {
                  id: string;
                  displayName: string;
                  wellKnownName?: string;
                }[];
              }>(
                `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(altMailbox.email)}/mailFolders`,
                {
                  headers: { Authorization: `Bearer ${token}` },
                  params: { $top: 100 },
                },
              ),
            );
            const folders = response.data.value.map((folder) => ({
              id: folder.id,
              name: folder.displayName,
            }));
            return Promise.all(
              folders.map((folder) =>
                this.limiter.schedule(() =>
                  fetchEmailsFromFolder(folder, altMailbox.email),
                ),
              ),
            );
          }),
        );
        const resolvedEmails = altEmailPromises.flat();
        allEmails = resolvedEmails.flat();
      }

      return allEmails.sort(
        (a, b) =>
          new Date(a.receivedDateTime).getTime() -
          new Date(b.receivedDateTime).getTime(),
      );
    } catch (error) {
      this.logger.warn(`Failed to fetch conversation thread: ${error.message}`);
      return [];
    }
  }

  private async fetchEmails(
    orgId: string,
    mailboxes: Mailbox[],
    token: string,
  ): Promise<GraphEmailResponse['value']> {
    const limit = pLimit(5);
    const allEmails: GraphEmailResponse['value'] = [];

    const folderPromises = mailboxes.flatMap((mailbox) =>
      this.getFolders(orgId, token, mailbox.email).then((folders) =>
        folders.map((folder) =>
          limit(() =>
            this.limiter.schedule(() =>
              this.fetchEmailsFromFolder(orgId, mailbox, folder, token),
            ),
          ),
        ),
      ),
    );

    const folderResults = await Promise.all(folderPromises);
    const results = await Promise.allSettled(folderResults.flat());
    results.forEach((result) => {
      if (result.status === 'fulfilled') {
        allEmails.push(...result.value);
      }
    });

    return allEmails;
  }

  private async fetchEmailsFromFolder(
    orgId: string,
    mailbox: Mailbox,
    folder: Folder,
    token: string,
  ): Promise<GraphEmailResponse['value']> {
    const syncState = await this.prisma.syncState.findUnique({
      where: {
        orgId_mailboxEmail_folderId_unique: {
          orgId,
          mailboxEmail: mailbox.email,
          folderId: folder.id,
        },
      },
    });

    const url =
      syncState?.deltaLink ||
      `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailbox.email)}/mailFolders/${folder.id}/messages/delta`;
    const batchRequest = {
      requests: [
        {
          id: 'messages',
          method: 'GET',
          url: url.replace('https://graph.microsoft.com/v1.0', ''),
          params: syncState?.deltaLink
            ? {}
            : {
                $top: 50,
                $select:
                  'id,subject,from,receivedDateTime,body,bodyPreview,hasAttachments,conversationId,internetMessageId,toRecipients,ccRecipients,bccRecipients',
                $filter: `receivedDateTime ge ${new Date(
                  Date.now() - 30 * 24 * 60 * 60 * 1000,
                ).toISOString()}`,
              },
        },
      ],
    };

    try {
      const response = await axios.post<{
        responses: { id: string; status: number; body: GraphEmailResponse }[];
      }>('https://graph.microsoft.com/v1.0/$batch', batchRequest, {
        headers: { Authorization: `Bearer ${token}` },
      });

      const messageResponse = response.data.responses.find(
        (r) => r.id === 'messages',
      );
      if (!messageResponse || messageResponse.status >= 400) {
        throw new Error('Batch request failed');
      }

      const emails = messageResponse.body.value.map((email) => ({
        ...email,
        _sourceMailbox: mailbox.email,
        _sourceFolder: folder.name,
      }));

      const emailsWithAttachments = await Promise.all(
        emails
          .filter((email) => email.hasAttachments)
          .map(async (email) => {
            try {
              const batchAttachmentRequest = {
                requests: [
                  {
                    id: 'attachments',
                    method: 'GET',
                    url: `/users/${encodeURIComponent(mailbox.email)}/messages/${email.id}/attachments`,
                  },
                ],
              };
              const attachmentResponse = await this.limiter.schedule(() =>
                axios.post<{
                  responses: {
                    id: string;
                    status: number;
                    body: AttachmentResponse;
                  }[];
                }>(
                  'https://graph.microsoft.com/v1.0/$batch',
                  batchAttachmentRequest,
                  { headers: { Authorization: `Bearer ${token}` } },
                ),
              );
              const attachmentBody = attachmentResponse.data.responses.find(
                (r) => r.id === 'attachments',
              )?.body;
              return { ...email, attachments: attachmentBody?.value || [] };
            } catch (error) {
              return { ...email, attachments: [] };
            }
          }),
      );

      const finalEmails = emails.map((email) => ({
        ...email,
        attachments:
          emailsWithAttachments.find((e) => e.id === email.id)?.attachments ||
          email.attachments ||
          [],
      }));

      if (messageResponse.body['@odata.deltaLink']) {
        await this.prisma.syncState.upsert({
          where: {
            orgId_mailboxEmail_folderId_unique: {
              orgId,
              mailboxEmail: mailbox.email,
              folderId: folder.id,
            },
          },
          update: {
            deltaLink: messageResponse.body['@odata.deltaLink'],
            lastSyncedAt: new Date(),
          },
          create: {
            orgId,
            platform: this.platformName,
            mailboxEmail: mailbox.email,
            folderId: folder.id,
            deltaLink: messageResponse.body['@odata.deltaLink'],
          },
        });
      }

      return finalEmails;
    } catch (error) {
      return [];
    }
  }

  private async isPotentialLead(
    email: GraphEmailResponse['value'][0],
    orgId: string,
  ): Promise<{ isLead: boolean; leadEmail?: string; phone?: string | null }> {
    const senderEmail = email.from?.emailAddress?.address?.toLowerCase();
    if (!senderEmail) {
      return { isLead: false };
    }

    const leadConfig = await this.prisma.leadConfiguration.findUnique({
      where: { orgId },
      select: { filters: true, excludedEmails: true, specialEmails: true },
    });

    const excludedEmails = leadConfig?.excludedEmails || [];
    if (excludedEmails.includes(senderEmail)) {
      return { isLead: false };
    }

    const specialEmails = leadConfig?.specialEmails || [];
    let leadEmail = senderEmail;
    if (specialEmails.includes(senderEmail)) {
      this.logger.log(
        `Sender ${senderEmail} is a special email, attempting to extract email from content`,
      );

      const subject = email.subject || '';
      const body = striptags(email.body?.content || email.bodyPreview || '')
        .replace(/\s+/g, ' ')
        .trim();

      this.logger.debug(`Cleaned subject: ${subject}`);
      this.logger.debug(`Cleaned body: ${body}`);
      const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
      const foundEmails = ((subject.match(emailRegex) as string[]) || [])
        .concat((body.match(emailRegex) as string[]) || [])
        .map((email) => email.toLowerCase())
        .filter(
          (email) =>
            !excludedEmails.includes(email) && !specialEmails.includes(email),
        );

      this.logger.debug(`Found emails: ${JSON.stringify(foundEmails)}`);
      leadEmail = foundEmails[0] || senderEmail;
      this.logger.log(`Selected lead email: ${leadEmail}`);
    }

    const filters = leadConfig?.filters || [
      'inquiry',
      'interested',
      'quote',
      'sales',
      'meeting',
    ];
    const subject = email.subject.toLowerCase();
    const body = email.body?.content?.toLowerCase() || '';
    const isLead = filters.some(
      (kw) => subject.includes(kw) || body.includes(kw),
    );

    // Phone number extraction
    const phoneRegex = /\b\+?[\d\s-]{8,}\b/g;
    const phoneMatches =
      body.match(phoneRegex) || subject.match(phoneRegex) || [];
    const phone = phoneMatches[0] || null;

    return { isLead, leadEmail, phone };
  }

  private async uploadToCloudinary(
    fileName: string,
    content: string,
    contentType: string,
  ): Promise<string> {
    try {
      const buffer = Buffer.from(content, 'base64');
      const stream = Readable.from(buffer);
      return await new Promise<string>((resolve, reject) => {
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
    } catch (error) {
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
    await Promise.all(
      attachments.map(async (attachment) => {
        try {
          const cloudinaryUrl = await this.uploadToCloudinary(
            attachment.name,
            attachment.contentBytes,
            attachment.contentType,
          );
          await this.prisma.leadAttachment.create({
            data: {
              conversationEmailId,
              fileName: attachment.name,
              cloudinaryUrl,
            },
          });
        } catch (error) {
          // Skip failed attachments
        }
      }),
    );
  }

  private async storeLeads(
    orgId: string,
    emails: GraphEmailResponse['value'],
    mailboxes: Mailbox[],
    token: string,
  ) {
    const conversations = new Map<string, GraphEmailResponse['value'][0][]>();

    emails.forEach((email) => {
      if (!email.conversationId) return;
      if (!conversations.has(email.conversationId)) {
        conversations.set(email.conversationId, []);
      }
      conversations.get(email.conversationId)?.push(email);
    });

    for (const [conversationId, conversationEmails] of conversations) {
      // Check all emails in the conversation for lead eligibility
      let qualifyingEmail: GraphEmailResponse['value'][0] | undefined;
      let leadResult:
        | { isLead: boolean; leadEmail?: string; phone?: string | null }
        | undefined;

      for (const email of conversationEmails) {
        const result = await this.isPotentialLead(email, orgId);
        if (result.isLead) {
          qualifyingEmail = email;
          leadResult = result;
          break;
        }
      }

      if (!qualifyingEmail || !leadResult?.isLead) continue;

      const mailbox = qualifyingEmail.toRecipients?.length
        ? mailboxes.find((m) =>
            qualifyingEmail.toRecipients!.some(
              (r) =>
                r.emailAddress.address.toLowerCase() === m.email.toLowerCase(),
            ),
          ) || mailboxes[0]
        : mailboxes[0];

      let fullConversation: GraphEmailResponse['value'];
      try {
        fullConversation = await this.fetchConversationThread(
          orgId,
          mailbox.email,
          conversationId,
          token,
        );
      } catch (error) {
        fullConversation = conversationEmails;
      }

      fullConversation.sort(
        (a, b) =>
          new Date(a.receivedDateTime).getTime() -
          new Date(b.receivedDateTime).getTime(),
      );

      const leadData = {
        organization: { connect: { id: orgId } },
        source: 'email',
        assignedTo: mailbox.assignedToId
          ? { connect: { user_id: mailbox.assignedToId } }
          : undefined,
        name: qualifyingEmail.from.emailAddress.name || 'Unknown',
        email:
          leadResult.leadEmail || qualifyingEmail.from.emailAddress.address,
        phone: leadResult.phone,
        company: null,
        job_title: null,
        initialConversationId: conversationId,
        status: 'NEW' as LeadStatus,
        created_at: new Date(qualifyingEmail.receivedDateTime),
      };

      const lead = await this.prisma.$transaction(async (tx) => {
        const existingLead = await tx.lead.findFirst({
          where: {
            email: leadData.email,
            organization: { id: orgId },
            status: { not: 'CLOSED' },
          },
          include: { conversations: { select: { conversationId: true } } },
        });

        if (existingLead) {
          if (
            !existingLead.conversations.some(
              (conv) => conv.conversationId === conversationId,
            )
          ) {
            return await tx.lead.update({
              where: { lead_id: existingLead.lead_id },
              data: {
                name: leadData.name,
                phone: leadData.phone,
                assignedTo: leadData.assignedTo,
                status: leadData.status,
                created_at: leadData.created_at,
                updated_at: new Date(),
              },
            });
          }
          return existingLead;
        }
        return await tx.lead.create({ data: leadData });
      });

      const existingConversation = await this.prisma.leadConversation.findFirst(
        {
          where: { conversationId },
          include: { lead: { select: { status: true } } },
        },
      );

      const conversation = await (async () => {
        const conversationData = {
          lead: { connect: { lead_id: lead.lead_id } },
          conversationId,
        };
        if (!existingConversation) {
          return await this.prisma.leadConversation.create({
            data: conversationData,
          });
        }
        if (existingConversation.lead.status === 'CLOSED') {
          return await this.prisma.leadConversation.create({
            data: conversationData,
          });
        }
        if (existingConversation.leadId !== lead.lead_id) {
          return await this.prisma.leadConversation.update({
            where: { id: existingConversation.id },
            data: { lead: { connect: { lead_id: lead.lead_id } } },
          });
        }
        return existingConversation;
      })();

      for (const [index, email] of fullConversation.entries()) {
        const existingEmail = await this.prisma.conversationEmail.findUnique({
          where: { emailId: email.id },
        });
        if (existingEmail) continue;

        const isIncoming =
          email.from?.emailAddress?.address.toLowerCase() ===
          leadData.email.toLowerCase();
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

        if (email.hasAttachments && email.attachments?.length) {
          await this.processEmailAttachments(
            conversationEmail.id,
            email.attachments,
          );
        }

        await this.delay(200);
      }
    }
  }
  async fetchAndStoreLeads(orgId: string) {
    try {
      const syncValidation = await this.validateSyncSettings(orgId);
      if (!syncValidation.valid) return syncValidation.response;

      const { access_token: token } = await this.getPlatformCredentials(orgId);
      const mailboxes = await this.getMailboxes(
        orgId,
        syncValidation.sharedMailbox!,
        token,
      );
      const emails = await this.fetchEmails(orgId, mailboxes, token);
      await this.storeLeads(orgId, emails, mailboxes, token);

      return { message: 'Sync Successful' };
    } catch (error) {
      this.logger.error(`Sync failed for org ${orgId}: ${error.message}`);
      return { message: `Sync failed: ${error.message}` };
    }
  }

  async listMailboxFolders(
    orgId: string,
    mailboxEmail: string,
  ): Promise<Folder[]> {
    const { access_token: token } = await this.getPlatformCredentials(orgId);

    try {
      const tokenPayload = JSON.parse(
        Buffer.from(token.split('.')[1], 'base64').toString(),
      );
      this.logger.log(
        `Token payload for ${mailboxEmail}: ${JSON.stringify(tokenPayload, null, 2)}`,
      );
      this.logger.log(
        `Token roles for ${mailboxEmail}: ${tokenPayload.roles || 'none'}`,
      );
      if (!tokenPayload.roles?.includes('Mail.Read')) {
        this.logger.error(`Token lacks Mail.Read role for ${mailboxEmail}`);
        throw new Error('Invalid token roles');
      }
    } catch (e) {
      this.logger.warn(
        `Failed to decode token for ${mailboxEmail}: ${e.message}`,
      );
    }

    try {
      this.logger.log(`Fetching folders for mailbox: ${mailboxEmail}`);
      const response = await this.limiter.schedule(() =>
        axios.get<{
          value: { id: string; displayName: string }[];
        }>(
          `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailboxEmail)}/mailFolders`,
          {
            headers: { Authorization: `Bearer ${token}` },
            params: {
              $top: 50,
              $select: 'id,displayName', // Removed wellKnownName
              includeHiddenFolders: false,
            },
          },
        ),
      );

      let folders: Folder[] = response.data.value
        .filter((f) => f.displayName && f.id)
        .map((f) => ({
          id: f.id,
          name: f.displayName,
        }));

      if (folders.length === 0) {
        this.logger.warn(
          `No folders found for ${mailboxEmail}, fetching inbox`,
        );
        const inboxResponse = await this.limiter.schedule(() =>
          axios.get<{ id: string; displayName: string }>(
            `https://graph.microsoft.com/v1.0/users/${encodeURIComponent(mailboxEmail)}/mailFolders/inbox`,
            {
              headers: { Authorization: `Bearer ${token}` },
            },
          ),
        );
        folders.push({
          id: inboxResponse.data.id,
          name: inboxResponse.data.displayName || 'Inbox',
        });
      }

      this.logger.log(`Fetched ${folders.length} folders for ${mailboxEmail}`);
      return folders;
    } catch (error: any) {
      const status = error.response?.status;
      const errorDetails = error.response?.data?.error || {};
      this.logger.error(
        `Failed to fetch folders for ${mailboxEmail}: HTTP ${status || 'unknown'}, Details: ${JSON.stringify(errorDetails)}`,
      );

      if (status === 400) {
        this.logger.warn(
          `Invalid request for ${mailboxEmail}. Check mailbox validity or query parameters.`,
        );
      } else if (status === 403) {
        this.logger.error(
          `Permission denied for ${mailboxEmail}. Check app permissions or mailbox access.`,
        );
      } else if (status === 404) {
        this.logger.error(
          `Mailbox ${mailboxEmail} not found. Verify email address.`,
        );
      } else {
        this.logger.error(
          `Unexpected error for ${mailboxEmail}: ${error.message}`,
        );
      }

      // Fallback to default folder
      this.logger.log(`Returning fallback folder for ${mailboxEmail}`);
      return [{ id: 'inbox', name: 'Inbox' }];
    }
  }

  async updateLeadConfig(
    orgId: string,
    data: {
      filters?: string[];
      folders?: Record<string, { id: string; name: string }[]>;
      syncInterval?: string;
      excludedEmails?: string[];
      specialEmails?: string[];
      sharedMailbox?: string;
    },
  ) {
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
      include: { leadConfig: true },
    });
    if (!org) {
      throw new HttpException('Organization not found', HttpStatus.NOT_FOUND);
    }

    this.logger.log(`Updating lead config for org ${orgId}`);
    this.logger.log(`Data received: ${JSON.stringify(data)}`);
    // Validate folder objects
    let validatedFolders:
      | Record<string, { id: string; name: string }[]>
      | undefined;
    if (data.folders) {
      validatedFolders = {};
      for (const [mailboxEmail, folders] of Object.entries(data.folders)) {
        try {
          const availableFolders = await this.listMailboxFolders(
            orgId,
            mailboxEmail,
          );
          const validFolders = folders
            .map((folder) => {
              const match = availableFolders.find((f) => f.id === folder.id);
              return match ? { id: match.id, name: match.name } : null;
            })
            .filter((f): f is { id: string; name: string } => f !== null);
          validatedFolders[mailboxEmail.toLowerCase()] =
            validFolders.length > 0 ? validFolders : [];
        } catch (error) {
          this.logger.error(
            `Failed to validate folders for ${mailboxEmail}: ${error.message}`,
          );
          validatedFolders[mailboxEmail.toLowerCase()] = [];
        }
      }
    }

    let updatedLeadConfig;

    await this.prisma.$transaction(async (prisma) => {
      // Update sharedMailbox if provided
      if (data.sharedMailbox !== undefined) {
        await prisma.organization.update({
          where: { id: orgId },
          data: { sharedMailbox: data.sharedMailbox },
        });
      }

      // Prepare lead config data
      const leadConfigData = {
        filters: data.filters || [
          'inquiry',
          'interested',
          'quote',
          'sales',
          'meeting',
        ],
        folders: validatedFolders || {},
        syncInterval: data.syncInterval || 'EVERY_HOUR',
        excludedEmails: data.excludedEmails || [],
        specialEmails: data.specialEmails || [],
      };

      if (!org.leadConfig) {
        // Create new lead config
        updatedLeadConfig = await prisma.leadConfiguration.create({
          data: {
            orgId,
            ...leadConfigData,
          },
        });
      } else {
        // Update existing lead config
        updatedLeadConfig = await prisma.leadConfiguration.update({
          where: { orgId },
          data: {
            filters: data.filters !== undefined ? data.filters : undefined,
            folders:
              validatedFolders !== undefined ? validatedFolders : undefined,
            syncInterval:
              data.syncInterval !== undefined ? data.syncInterval : undefined,
            excludedEmails:
              data.excludedEmails !== undefined
                ? data.excludedEmails
                : undefined,
            specialEmails:
              data.specialEmails !== undefined ? data.specialEmails : undefined,
          },
        });
      }

      // Reschedule sync if syncInterval changed
      if (data.syncInterval !== undefined || !this.jobs.has(orgId)) {
        this.logger.log(
          `Rescheduling sync for org ${orgId} due to config update`,
        );
        await this.scheduleOrgSync(orgId, updatedLeadConfig.syncInterval);
      }
    });

    return {
      ...updatedLeadConfig,
      folders: validatedFolders || updatedLeadConfig.folders,
    };
  }

  async setupLeadSync(
  orgId: string,
  userId: string,
  data: {
    sharedMailbox: string;
    filters?: string[];
    syncInterval?: string;
    excludedEmails?: string[];
    specialEmails?: string[];
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
        syncInterval: data.syncInterval || 'EVERY_HOUR',
        excludedEmails: data.excludedEmails || [],
        specialEmails: data.specialEmails || [],
        folders: {}, // Default empty JSON object
      },
      update: {
        filters: data.filters || [
          'inquiry',
          'interested',
          'quote',
          'sales',
          'meeting',
        ],
        syncInterval: data.syncInterval || 'EVERY_HOUR',
        excludedEmails: data.excludedEmails || [],
        specialEmails: data.specialEmails || [],
        folders: {}, // Default empty JSON object
      },
    });
  });

  this.logger.log(`Lead sync setup completed for org ${orgId}`);
  return { message: 'Lead sync setup successful' };
}

 async connectLeadSync(
  userId: string,
  setupData?: {
    sharedMailbox: string;
    filters?: string[];
    syncInterval?: string;
    excludedEmails?: string[];
    specialEmails?: string[];
  },
) {
  this.logger.log(
    `Connecting Microsoft lead sync for org via user ${userId}`,
  );
  const user = await this.prisma.user.findUnique({
    where: { user_id: userId },
  });
  if (!user) {
    throw new HttpException('User not found', HttpStatus.UNAUTHORIZED);
  }
  if (user.role !== 'ADMIN') {
    throw new HttpException('Access denied', HttpStatus.FORBIDDEN);
  }

  const orgId = user.orgId;
  const org = await this.prisma.organization.findUnique({
    where: { id: orgId },
    select: { sharedMailbox: true },
  });
  let leadConfig = await this.prisma.leadConfiguration.findUnique({
    where: { orgId },
  });

  if (!org?.sharedMailbox || !leadConfig) {
    if (!setupData) {
      this.logger.log(`Setup required for org ${orgId}`);
      return {
        needsSetup: true,
        message: 'Please configure shared mailbox and lead settings',
      };
    }

    // Perform setup if data is provided
    await this.setupLeadSync(orgId, userId, setupData);

    // Re-fetch to ensure config exists
    const updatedOrg = await this.prisma.organization.findUnique({
      where: { id: orgId },
      select: { sharedMailbox: true },
    });
    leadConfig = await this.prisma.leadConfiguration.findUnique({
      where: { orgId },
    });

    if (!updatedOrg?.sharedMailbox || !leadConfig) {
      throw new HttpException(
        'Failed to setup lead configuration',
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  await this.getPlatformCredentials(orgId);

  await this.prisma.microsoftPreferences.upsert({
    where: { orgId },
    create: { orgId, leadSyncEnabled: true },
    update: { leadSyncEnabled: true },
  });

  await this.scheduleOrgSync(orgId, leadConfig.syncInterval);
  this.logger.log(`Microsoft lead sync connected for org ${orgId}`);
  return { needsSetup: false, message: 'Connected successfully' };
}

  async disconnectLeadSync(userId: string) {
    this.logger.log(
      `Disconnecting Microsoft lead sync for org via user ${userId}`,
    );
    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
    });
    if (!user)
      throw new HttpException('User not found', HttpStatus.UNAUTHORIZED);
    if (user.role !== 'ADMIN') {
      throw new HttpException(
        'Only admins can disconnect lead sync',
        HttpStatus.FORBIDDEN,
      );
    }

    const orgId = user.orgId;
    const platform = await this.prisma.marketingPlatform.findFirst({
      where: { orgId, platform_name: this.platformName },
    });
    if (!platform) {
      throw new HttpException(
        'Microsoft platform not found',
        HttpStatus.NOT_FOUND,
      );
    }

    await this.prisma.$transaction(async (prisma) => {
      await prisma.platformCredentials.deleteMany({
        where: {
          platform_id: platform.platform_id,
          user_id: null,
          type: 'LEADS',
        },
      });

      await prisma.microsoftPreferences.update({
        where: { orgId },
        data: { leadSyncEnabled: false },
      });

      await prisma.marketingPlatform.update({
        where: { platform_id: platform.platform_id },
        data: { sync_status: 'DISCONNECTED' },
      });
    });

    const job = this.jobs.get(orgId);
    if (job) {
      job.cancel();
      this.jobs.delete(orgId);
      this.logger.log(`Cancelled sync job for org ${orgId}`);
    }

    this.logger.log(`Microsoft lead sync disconnected for org ${orgId}`);
    return { message: 'Microsoft lead sync disconnected' };
  }

  async connectMemberLeadSync(userId: string) {
    this.logger.log(`Enabling member lead sync for user ${userId}`);
    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
    });
    if (!user) throw new UnauthorizedException('User not found');

    await this.prisma.user.update({
      where: { user_id: userId },
      data: { allowPersonalEmailSync: true },
    });

    this.logger.log(`Member lead sync enabled for user ${userId}`);
    return { message: 'Member lead sync enabled' };
  }

  async disconnectMemberLeadSync(userId: string) {
    this.logger.log(`Disabling member lead sync for user ${userId}`);
    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
    });
    if (!user) throw new UnauthorizedException('User not found');

    await this.prisma.user.update({
      where: { user_id: userId },
      data: { allowPersonalEmailSync: false },
    });

    this.logger.log(`Member lead sync disabled for user ${userId}`);
    return { message: 'Member lead sync disabled' };
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
      this.jobs.delete(orgId);
      this.logger.log(`Cancelled old sync job for org ${orgId}`);
    }

    const interval = syncInterval || 'EVERY_HOUR';
    const cronExpression = this.cronMap[interval] || this.cronMap.EVERY_HOUR;

    this.logger.log(
      `Scheduling org ${orgId} with ${interval} (${cronExpression})`,
    );

    const job = schedule.scheduleJob(cronExpression, async () => {
      if (this.runningSyncs.has(orgId)) {
        this.logger.warn(`Sync already running for org ${orgId}, skipping`);
        return;
      }

      this.runningSyncs.add(orgId);
      this.logger.log(`Starting sync for org ${orgId}`);
      try {
        await this.fetchAndStoreLeads(orgId);
        this.logger.log(`Sync completed for org ${orgId}`);
      } catch (error) {
        this.logger.error(`Sync failed for org ${orgId}: ${error.message}`);
      } finally {
        this.runningSyncs.delete(orgId);
      }
    });
    this.jobs.set(orgId, job);
  }

  private async startDynamicSync() {
    this.logger.log('Starting dynamic sync for single-org');
    try {
      const org = await this.prisma.organization.findUnique({
        where: { id: 'single-org' },
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

      if (!org) {
        this.logger.warn('Organization single-org not found');
        return;
      }

      this.logger.log('Found organization single-org to sync');
      if (org.preferences?.leadSyncEnabled && !this.jobs.has(org.id)) {
        await this.scheduleOrgSync(org.id, org.leadConfig?.syncInterval);
      }
    } catch (error) {
      this.logger.error(
        'Error starting dynamic sync: ',
        error.message,
        error.stack,
      );
    }
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

  async fetchAllLeadsByUserId(orgId: string, userId: string) {
    this.logger.log(
      `Fetching all leads for userId: ${userId}, orgId: ${orgId}`,
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

      const leads = await this.prisma.lead.findMany({
        where: baseWhereClause,
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
      });

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
      };
    } catch (error) {
      this.logger.error('Error fetching all leads: ', error.message);
      throw new HttpException(
        'Failed to fetch all leads',
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


  async createLead(
  userId: string,
  leadInputs: {
    name: string;
    email: string;
    phone?: string | null;
    company?: string | null;
    jobTitle?: string | null;
    status?: LeadStatus;
    source?: string;
  },
) {
  this.logger.log(`Creating lead for userId: ${userId} with inputs: ${JSON.stringify(leadInputs)}`);

  try {
    // Validate the user
    const user = await this.prisma.user.findUnique({
      where: { user_id: userId },
      select: { orgId: true, role: true },
    });

    if (!user) {
      throw new HttpException('User not found', HttpStatus.NOT_FOUND);
    }

    // Optionally restrict to ADMIN or specific roles
    if (user.role !== 'ADMIN') {
      throw new HttpException(
        'Only admins can create leads',
        HttpStatus.FORBIDDEN,
      );
    }

    // Validate required fields
    if (!leadInputs.name || !leadInputs.email) {
      throw new HttpException(
        'Name and email are required',
        HttpStatus.BAD_REQUEST,
      );
    }

    // Prepare lead data
    const leadData: Prisma.LeadCreateInput = {
      organization: { connect: { id: user.orgId } },
      source: leadInputs.source || 'manual',
      name: leadInputs.name,
      email: leadInputs.email.toLowerCase(),
      phone: leadInputs.phone || null,
      company: leadInputs.company || null,
      job_title: leadInputs.jobTitle || null,
      status: leadInputs.status || 'NEW',
      assignedTo: { connect: { user_id: userId } },
      created_at: new Date(),
    };

    // Create the lead
    const newLead = await this.prisma.lead.create({
      data: leadData,
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
    });

    this.logger.log(`Lead created successfully with ID: ${newLead.lead_id}`);
    return {
      leadId: newLead.lead_id,
      source: newLead.source,
      name: newLead.name,
      email: newLead.email,
      phone: newLead.phone,
      company: newLead.company,
      jobTitle: newLead.job_title,
      status: newLead.status,
      assignedTo: newLead.assignedTo,
      createdAt: newLead.created_at,
    };
  } catch (error) {
    this.logger.error(`Error creating lead for user ${userId}: ${error.message}`);
    throw new HttpException(
      'Failed to create lead',
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }
}
}
