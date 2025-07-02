import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { LinkedInService } from 'src/auth/linkedIn/linkedIn.service';
import { ConfigService } from '@nestjs/config';
import {
  CampaignType,
  CampaignStatus,
  ObjectiveType,
  CostType,
  Format,
} from '@prisma/client';
import axios from 'axios';
const FormData = require('form-data');

interface LinkedInPost {
  paging: {
    start: number;
    count: string; // API returns string
    links: { type: string; rel: string; href: string }[];
    total: number;
  };
  elements: {
    id: string;
    commentary?: string;
    createdAt?: number;
    lastModifiedAt?: string;
    visibility?: string;
    lifecycleState?: string;
    publishedAt?: number;
    author?: string;
    isReshareDisabledByAuthor?: boolean;
    content?: {
      media?: { title?: string; id?: string };
      multiImage?: { images: { id: string; altText?: string }[] };
      video?: { id: string };
      document?: { id: string; title?: string };
      article?: {
        title: string;
        source: string;
        thumbnail?: string;
        thumbnailAltText?: string;
      };
      reference?: { id: string };
    };
    contentLandingPage?: string;
    contentCallToActionLabel?: string;
    distribution?: {
      feedDistribution: string;
      thirdPartyDistributionChannels: string[];
    };
    lifecycleStateInfo?: {
      isEditedByAuthor: boolean;
    };
    reshareContext?: {
      parent: string;
      root: string;
    };
    adContext?: {
      dscStatus: string;
      dscName: string;
      dscAdType: string;
      isDsc: boolean;
      dscAdAccount: string;
    };
  }[];
}

enum PostContentType {
  TEXT = 'TEXT',
  IMAGE = 'IMAGE',
  MULTI_IMAGE = 'MULTI_IMAGE',
  VIDEO = 'VIDEO',
  DOCUMENT = 'DOCUMENT',
  ARTICLE = 'ARTICLE',
}

// Interface for the returned post data
export interface AdEligiblePost {
  id: string;
  commentary: string | null;
  contentType: PostContentType;
  content: {
    mediaTitle?: string;
    mediaId?: string;
    imageIds?: string[];
    article?: {
      title: string;
      source: string;
      thumbnail?: string;
      thumbnailAltText?: string;
    };
  };
  createdAt: number | null;
  lastModifiedAt: number | null;
  visibility: string | null;
  lifecycleState: string | null;
  contentLandingPage: string | null;
  isReshareDisabledByAuthor: boolean;
  adContext: {
    dscStatus: string | null;
    dscName: string | null;
    dscAdType: string | null;
    isDsc: boolean;
    dscAdAccount: string | null;
  } | null;
}

interface LinkedInAdPreviewResponse {
  paging: {
    start: number;
    count: number;
    links: any[];
    total: number;
  };
  elements: Array<{
    preview: string;
    creative: string;
    placement: {
      linkedin: {
        placementName: string;
        contentPresentationType: string;
      };
    };
  }>;
}

interface LinkedInCreativesResponse {
  paging: {
    start: number;
    count: number;
    links: any[];
  };
  metadata: Record<string, any>;
  elements: Array<{
    id: string;
    account: string;
    campaign: string;
    name: string;
    content: { reference: string };
    intendedStatus: string;
    isServing: boolean;
    servingHoldReasons: string[];
    review?: { status: string; rejectionReasons?: string[] };
    createdAt: number;
    lastModifiedAt: number;
    createdBy: string;
    lastModifiedBy: string;
    isTest: boolean;
  }>;
}

@Injectable()
export class LinkedInAdsService {
  private readonly logger = new Logger(LinkedInAdsService.name);

  constructor(
    private prisma: PrismaService,
    private readonly linkedinService: LinkedInService,
    private readonly configService: ConfigService,
  ) {}

  private extractIdFromUrn(urn: string): string {
    const match = urn.match(/:(\d+)$/);
    if (!match) {
      this.logger.error(`Invalid URN format: ${urn}`);
      throw new Error(`Invalid URN format: ${urn}`);
    }
    return match[1];
  }

  async syncCampaignAds(): Promise<{
    success: boolean;
    message: string;
    data: {
      totalCampaigns: number;
      totalAdsProcessed: number;
      errors: string[];
    };
  }> {
    this.logger.log('Starting sync of LinkedIn campaign ads');

    try {
      // Fetch all campaigns with external_id
      const campaigns = await this.prisma.marketingCampaign.findMany({
        where: { external_id: { not: null } },
        select: { campaign_id: true, external_id: true, ad_account_id: true },
      });

      if (!campaigns.length) {
        return {
          success: true,
          message: 'No campaigns with external_id found',
          data: { totalCampaigns: 0, totalAdsProcessed: 0, errors: [] },
        };
      }

      let totalAdsProcessed = 0;
      const errors: string[] = [];

      // Process each campaign
      for (const campaign of campaigns) {
        if (!campaign.ad_account_id) {
          errors.push(`Campaign ${campaign.campaign_id} missing ad_account_id`);
          continue;
        }

        if (!campaign.external_id) {
          errors.push(`Campaign ${campaign.campaign_id} missing external_id`);
          continue;
        }

        try {
          // Fetch ads from LinkedIn API
          const ads = await this.fetchAdsForCampaign(
            campaign.ad_account_id,
            campaign.external_id,
          );

          // Save or update ads in Prisma
          for (const ad of ads) {
            const leadgenCallToAction = ad.leadgenCallToAction
              ? {
                  destination: ad.leadgenCallToAction.destination,
                  label: ad.leadgenCallToAction.label,
                }
              : undefined;
            this.logger.log('leadgenCallToAction', leadgenCallToAction);
            await this.prisma.ad.upsert({
              where: {
                campaignId_id: {
                  campaignId: campaign.campaign_id,
                  id: this.extractIdFromUrn(ad.id),
                },
              },
              create: {
                id: this.extractIdFromUrn(ad.id),
                campaignId: campaign.campaign_id,
                adAccountId: this.extractIdFromUrn(ad.account),
                content: JSON.stringify(ad.content),
                leadgenCallToAction: leadgenCallToAction,
                name: ad.name,
                intendedStatus: ad.intendedStatus,
                isServing: ad.isServing,
                servingHoldReasons: ad.servingHoldReasons,
                reviewStatus: ad.review?.status,
                rejectionReasons: ad.review?.rejectionReasons || [],
                createdAt: new Date(ad.createdAt),
                lastModifiedAt: new Date(ad.lastModifiedAt),
                createdBy: ad.createdBy,
                lastModifiedBy: ad.lastModifiedBy,
                isTest: ad.isTest,
                changeAuditStamps: {
                  created: { time: ad.createdAt, actor: ad.createdBy },
                  lastModified: {
                    time: ad.lastModifiedAt,
                    actor: ad.lastModifiedBy,
                  },
                },
              },
              update: {
                adAccountId: this.extractIdFromUrn(ad.account),
                content: JSON.stringify(ad.content),
                leadgenCallToAction: leadgenCallToAction,
                name: ad.name,
                intendedStatus: ad.intendedStatus,
                isServing: ad.isServing,
                servingHoldReasons: ad.servingHoldReasons,
                reviewStatus: ad.review?.status,
                rejectionReasons: ad.review?.rejectionReasons || [],
                createdAt: new Date(ad.createdAt),
                lastModifiedAt: new Date(ad.lastModifiedAt),
                createdBy: ad.createdBy,
                lastModifiedBy: ad.lastModifiedBy,
                isTest: ad.isTest,
                changeAuditStamps: {
                  created: { time: ad.createdAt, actor: ad.createdBy },
                  lastModified: {
                    time: ad.lastModifiedAt,
                    actor: ad.lastModifiedBy,
                  },
                },
              },
            });
            totalAdsProcessed++;
          }
        } catch (error) {
          const errorMsg = `Failed to sync ads for campaign ${campaign.campaign_id}: ${error.message}`;
          this.logger.error(errorMsg);
          errors.push(errorMsg);
        }
      }

      return {
        success: errors.length === 0,
        message: `Synced ads for ${campaigns.length} campaigns`,
        data: {
          totalCampaigns: campaigns.length,
          totalAdsProcessed,
          errors,
        },
      };
    } catch (error) {
      this.logger.error(`Sync failed: ${error.message}`);
      return {
        success: false,
        message: 'Failed to sync campaign ads',
        data: {
          totalCampaigns: 0,
          totalAdsProcessed: 0,
          errors: [error.message],
        },
      };
    }
  }

  // Helper method to fetch ads for a single campaign (updated to use axios)
  private async fetchAdsForCampaign(
    adAccountId: string,
    campaignId: string,
  ): Promise<any[]> {
    this.logger.log(
      `Fetching ads for campaign ${campaignId} under ad account ${adAccountId}`,
    );

    const campaignUrn = `urn:li:sponsoredCampaign:${campaignId}`;

    // Validate inputs
    if (!campaignUrn || !campaignUrn.startsWith('urn:li:sponsoredCampaign:')) {
      this.logger.error(`Invalid campaignUrn: ${campaignUrn}`);
      throw new Error('Invalid campaign URN');
    }

    const ads: any[] = [];
    let start = 0;
    const count = 10; // API default page size

    try {
      // Get LinkedIn access token
      const accessToken = await this.linkedinService.getValidAccessToken();
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        'LinkedIn-Version': '202505',
        'X-RestLi-Protocol-Version': '2.0.0',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };

      // Handle pagination
      while (true) {
        const url = `https://api.linkedin.com/rest/adAccounts/${adAccountId}/creatives?q=criteria&campaigns=List(${encodeURIComponent(campaignUrn)})&start=${start}&count=${count}`;
        this.logger.log(`Sending request to LinkedIn API: ${url}`);

        const response = await axios.get<LinkedInCreativesResponse>(url, {
          headers,
        });

        if (response.status !== 200) {
          this.logger.error(`Unexpected response status: ${response.status}`);
          throw new Error(
            `Failed to fetch ads: Received status ${response.status}`,
          );
        }

        ads.push(...response.data.elements);

        // Check for pagination
        if (
          response.data.paging.links.length === 0 ||
          response.data.elements.length < count
        ) {
          break;
        }

        start += count;
      }

      this.logger.log(`Fetched ${ads.length} ads for campaign ${campaignUrn}`);
      return ads;
    } catch (error: any) {
      if (error.response) {
        this.logger.error(
          `LinkedIn API Error: ${error.response.status} - ${JSON.stringify(error.response.data)}`,
          {
            request: {
              url: error.config?.url,
              method: error.config?.method,
              headers: error.config?.headers,
            },
          },
        );
        if (error.response.status === 401) {
          throw new UnauthorizedException('Invalid or expired access token');
        }
        if (error.response.status === 403) {
          throw new ForbiddenException(
            'Missing required scopes (r_ads, rw_ads) or insufficient permissions',
          );
        }
        if (error.response.status === 429) {
          throw new Error('Rate limit exceeded');
        }
        if (error.response.status === 400) {
          throw new Error(
            `Invalid request: ${JSON.stringify(error.response.data)}`,
          );
        }
      }
      this.logger.error(
        `Failed to fetch ads for campaign ${campaignUrn}: ${error.message}`,
      );
      throw new Error(`Failed to fetch ads: ${error.message}`);
    }
  }

  async createLinkedInCampaignAd(
    campaignId: string,
    adInputs: any,
  ): Promise<{
    success: boolean;
    message: string;
    data?: any;
  }> {
    try {
      // Fetch campaign from database
      const campaign = await this.prisma.marketingCampaign.findUnique({
        where: { campaign_id: campaignId },
        select: {
          ad_account_id: true,
          objective: true,
          format: true,
          external_id: true,
        },
      });

      if (!campaign) {
        this.logger.error(`Campaign not found: ${campaignId}`);
        throw new NotFoundException(`Campaign not found: ${campaignId}`);
      }

      if (!campaign.ad_account_id) {
        this.logger.error(`Campaign ${campaignId} missing ad_account_id`);
        throw new Error(`Campaign ${campaignId} missing ad_account_id`);
      }

      if (!campaign.external_id) {
        this.logger.error(`Campaign ${campaignId} missing external_id`);
        throw new Error(`Campaign ${campaignId} missing external_id`);
      }

      const { ad_account_id, objective, format, external_id } = campaign;
      this.logger.log(
        `Campaign details - adAccountId: ${ad_account_id}, objective: ${objective}, format: ${format}, externalId: ${external_id}`,
      );

      let adId: string;

      // Handle based on ad format
      switch (format) {
        case Format.TEXT_AD:
          adId = await this.createTextAd(
            adInputs,
            campaignId,
            ad_account_id,
            external_id,
          );
          break;
        case Format.CAROUSEL:
          adId = await this.createCarouselAd(
            adInputs,
            campaignId,
            ad_account_id,
            external_id,
          );
          break;
        case Format.STANDARD_UPDATE:
          adId = await this.createSingleImageAd(
            adInputs,
            campaignId,
            ad_account_id,
            external_id,
          );
          break;
        case Format.SINGLE_VIDEO:
          adId = await this.createSingleVideoAd(
            adInputs,
            campaignId,
            ad_account_id,
            external_id,
          );
          break;
        case Format.SPOTLIGHT:
          adId = await this.createSpotlightAd(
            adInputs,
            campaignId,
            ad_account_id,
            external_id,
          );
          break;
        default:
          this.logger.error(`Unsupported ad format: ${format}`);
          throw new Error(`Unsupported ad format: ${format}`);
      }

      // Fetch the newly created ad from LinkedIn
      const ads = await this.fetchAdsForCampaign(ad_account_id, external_id);
      const createdAd = ads.find((ad) => this.extractIdFromUrn(ad.id) === adId);

      if (!createdAd) {
        this.logger.error(`Failed to fetch newly created ad with ID: ${adId}`);
        throw new Error(`Ad ${adId} not found on LinkedIn after creation`);
      }

      // Save to Prisma
      const adData = {
        id: this.extractIdFromUrn(createdAd.id),
        campaignId: campaignId,
        adAccountId: this.extractIdFromUrn(createdAd.account),
        content: JSON.stringify(createdAd.content),
        name: createdAd.name,
        intendedStatus: createdAd.intendedStatus,
        isServing: createdAd.isServing,
        servingHoldReasons: createdAd.servingHoldReasons,
        reviewStatus: createdAd.review?.status,
        rejectionReasons: createdAd.review?.rejectionReasons || [],
        createdAt: new Date(createdAd.createdAt),
        lastModifiedAt: new Date(createdAd.lastModifiedAt),
        createdBy: createdAd.createdBy,
        lastModifiedBy: createdAd.lastModifiedBy,
        isTest: createdAd.isTest,
      };

      await this.prisma.ad.upsert({
        where: {
          campaignId_id: {
            campaignId: campaignId,
            id: adData.id,
          },
        },
        create: {
          ...adData,
          changeAuditStamps: {
            created: { time: adData.createdAt, actor: adData.createdBy },
            lastModified: {
              time: adData.lastModifiedAt,
              actor: adData.lastModifiedBy,
            },
          },
        },
        update: {
          ...adData,
          changeAuditStamps: {
            created: { time: adData.createdAt, actor: adData.createdBy },
            lastModified: {
              time: adData.lastModifiedAt,
              actor: adData.lastModifiedBy,
            },
          },
        },
      });

      return {
        success: true,
        message: `Successfully created and saved ${format} with ID ${adId} for campaign ${campaignId}`,
        data: adData,
      };
    } catch (error: any) {
      this.logger.error(
        `Failed to create ad for campaign ${campaignId}: ${error.message}`,
      );
      throw new Error(`Failed to create ad: ${error.message}`);
    }
  }
  private async createTextAd(
    adInputs: any,
    campaignId: string,
    adAccountId: string,
    campaignExternalId: string,
  ): Promise<string> {
    this.logger.log(
      `Creating TEXT_AD for campaign ID: ${campaignId}, ad account ID: ${adAccountId}, inputs: ${JSON.stringify(adInputs, null, 2)}`,
    );
    try {
      // Get LinkedIn access token
      const accessToken = await this.linkedinService.getValidAccessToken();
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        'LinkedIn-Version': '202505',
        'X-RestLi-Protocol-Version': '2.0.0',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };

      let imageUrn: string | undefined;
      if (adInputs.image) {
        this.logger.log(
          `Uploading image for TEXT_AD in campaign ${campaignId}`,
        );
        const uploadResult = await this.uploadImageToLinkedIn(
          adInputs.image,
          adAccountId,
        );
        if (!uploadResult.success || !uploadResult.data?.urn) {
          this.logger.error('Failed to upload image for TEXT_AD');
          throw new Error('Failed to upload image for TEXT_AD');
        }
        imageUrn = uploadResult.data.urn;
        this.logger.log(`Image uploaded successfully, URN: ${imageUrn}`);
      }

      const createUrl = `https://api.linkedin.com/rest/adAccounts/${adAccountId}/creatives`;
      const createPayload = {
        content: {
          textAd: {
            headline: adInputs.headline,
            description: adInputs.description,
            landingPage: adInputs.landingPage,
            ...(imageUrn && { image: imageUrn }), // Include image URN if available
          },
        },
        campaign: `urn:li:sponsoredCampaign:${campaignExternalId}`,
        intendedStatus: 'DRAFT',
        ...(adInputs.name && { name: adInputs.name }), // Include name if provided
      };

      this.logger.log(
        `Creating TEXT_AD on LinkedIn API for campaign URN: urn:li:sponsoredCampaign:${campaignExternalId}, ad account URN: urn:li:sponsoredAccount:${adAccountId}`,
      );
      const createResponse = await axios.post(createUrl, createPayload, {
        headers,
      });

      if (createResponse.status !== 201) {
        this.logger.error(`Failed to create text ad: ${createResponse.status}`);
        throw new Error(
          `Failed to create text ad: Received status ${createResponse.status}`,
        );
      }

      // Extract ad ID from x-restli-id header
      const adUrn = createResponse.headers['x-restli-id'];
      if (!adUrn || !adUrn.startsWith('urn:li:sponsoredCreative:')) {
        this.logger.error('Invalid or missing x-restli-id header in response');
        throw new Error('Invalid or missing ad ID in response');
      }

      const adId = this.extractIdFromUrn(adUrn);
      this.logger.log(`Successfully created TEXT_AD with ID: ${adId}`);

      return adId;
    } catch (error: any) {
      this.logger.error(
        `Failed to create TEXT_AD for campaign ${campaignId}: ${error.message}`,
      );
      throw new Error(`Failed to create TEXT_AD: ${error.message}`);
    }
  }
  private async createSingleImageAd(
    adInputs: {
      name?: string;
      intendedStatus: string;
      headline: string;
      introText: string;
      destinationUrl?: string;
      image: Buffer;
      imageUrn?: string;
      imageAltText?: string;
      leadGenFormUrn?: string;
      leadgenCallToAction?: string;
    },
    campaignId: string,
    adAccountId: string,
    campaignExternalId: string,
  ): Promise<string> {
    // Log inputs
    const { image, ...adInputsWithoutImage } = adInputs;
    this.logger.log(
      `Creating SINGLE_IMAGE ad for campaign ID: ${campaignId}, ad account ID: ${adAccountId}, inputs: ${JSON.stringify(adInputsWithoutImage, null, 2)}`,
    );

    try {
      if (!adInputs.image && !adInputs.imageUrn) {
        this.logger.error(
          'Either image (Buffer) or imageUrn (string) is required',
        );
        throw new Error('Either image or imageUrn is required');
      }
      if (adInputs.image && adInputs.imageUrn) {
        this.logger.error('Cannot provide both image and imageUrn');
        throw new Error('Cannot provide both image and imageUrn');
      }
      if (adInputs.image && !(adInputs.image instanceof Buffer)) {
        this.logger.error('Image must be a Buffer');
        throw new Error('Image must be a Buffer');
      }
      if (adInputs.imageUrn && !adInputs.imageUrn.startsWith('urn:li:image:')) {
        this.logger.error(
          'Invalid imageUrn format; must start with urn:li:image:',
        );
        throw new Error('Invalid imageUrn format');
      }

      // Fetch campaign
      const campaign = await this.prisma.marketingCampaign.findUnique({
        where: { campaign_id: campaignId },
        select: { objective: true },
      });
      if (!campaign) {
        this.logger.error(`Campaign not found: ${campaignId}`);
        throw new Error(`Campaign not found: ${campaignId}`);
      }

      // Validate lead generation fields
      const isLeadGen = campaign.objective === 'LEAD_GENERATION';
      if (isLeadGen) {
        if (
          !adInputs.leadGenFormUrn ||
          !/^(urn:li:(leadGenForm|adForm):.+)$/.test(adInputs.leadGenFormUrn)
        ) {
          this.logger.error(
            'Valid leadGenFormUrn (e.g., urn:li:leadGenForm:...) is required for LEAD_GENERATION',
          );
          throw new Error('Valid leadGenFormUrn is required');
        }
        if (
          !adInputs.leadgenCallToAction ||
          ![
            'APPLY',
            'DOWNLOAD',
            'VIEW_QUOTE',
            'LEARN_MORE',
            'SIGN_UP',
            'SUBSCRIBE',
            'REGISTER',
            'REQUEST_DEMO',
            'JOIN',
            'ATTEND',
            'UNLOCK_FULL_DOCUMENT',
          ].includes(adInputs.leadgenCallToAction)
        ) {
          this.logger.error(
            'Valid leadgenCallToAction (e.g., REGISTER) is required for LEAD_GENERATION',
          );
          throw new Error('Valid leadgenCallToAction is required');
        }
      } else {
        if (
          !adInputs.destinationUrl ||
          !/^https?:\/\/.+/.test(adInputs.destinationUrl)
        ) {
          this.logger.error(
            'Valid destination URL (http:// or https://) is required for non-lead generation campaigns',
          );
          throw new Error('Valid destination URL is required');
        }
      }

      // Fetch ad account
      const adAccount = await this.prisma.adAccount.findUnique({
        where: { id: adAccountId },
        include: { linkedInPage: { select: { pageId: true } } },
      });
      if (!adAccount || !adAccount.linkedInPage?.pageId) {
        this.logger.error(
          `No LinkedIn page found for ad account ${adAccountId}`,
        );
        throw new Error('No LinkedIn page found');
      }
      const authorUrn = `urn:li:organization:${adAccount.linkedInPage.pageId}`;

      // Upload image
      let finalImageUrn: string;
      if (adInputs.imageUrn) {
        this.logger.log(`Using provided imageUrn: ${adInputs.imageUrn}`);
        finalImageUrn = adInputs.imageUrn;
      } else {
        this.logger.log('Uploading image...');
        const uploadResult = await this.uploadImageToLinkedIn(
          adInputs.image!,
          adAccountId,
        );
        if (
          !uploadResult.success ||
          !uploadResult.data ||
          !uploadResult.data.urn
        ) {
          this.logger.error('Image upload failed');
          throw new Error('Image upload failed');
        }
        finalImageUrn = uploadResult.data.urn;
        this.logger.log(`Image uploaded: ${finalImageUrn}`);
      }

      // Build payload step-by-step
      // Step 1: Core post structure
      const postPayload = {
        adContext: {
          dscAdAccount: `urn:li:sponsoredAccount:${adAccountId}`,
          dscStatus: adAccount.status || 'ACTIVE',
        },
        author: authorUrn,
        commentary: adInputs.introText || '',
        visibility: 'PUBLIC',
        lifecycleState: 'PUBLISHED',
      };

      // Step 2: Media content
      const contentPayload = {
        media: {
          title: adInputs.headline || 'Single Image Ad',
          id: finalImageUrn,
          altText: adInputs.imageAltText || 'Ad Image',
          // landingPage will be conditionally added below
        },
      };

      // Step 3: Add landing page for non-lead gen campaigns
      if (!isLeadGen && adInputs.destinationUrl) {
        (contentPayload.media as any).landingPage = adInputs.destinationUrl;
      }

      // Step 4: Combine into inline content
      const inlineContentPayload = {
        post: {
          ...postPayload,
          content: contentPayload,
        },
      };

      // Step 5: Build leadgenCallToAction for lead gen campaigns
      let leadgenCallToActionPayload = {};
      if (
        isLeadGen &&
        adInputs.leadGenFormUrn &&
        adInputs.leadgenCallToAction
      ) {
        leadgenCallToActionPayload = {
          label: adInputs.leadgenCallToAction, // String, e.g., "REGISTER"
          destination: adInputs.leadGenFormUrn, // e.g., "urn:li:leadGenForm:..."
        };
      }

      // Step 6: Final creative payload
      const creativePayload = {
        creative: {
          inlineContent: inlineContentPayload,
          ...(isLeadGen
            ? { leadgenCallToAction: leadgenCallToActionPayload }
            : {}),
          campaign: `urn:li:sponsoredCampaign:${campaignExternalId}`,
          intendedStatus: adInputs.intendedStatus || 'DRAFT',
          type: isLeadGen ? 'LEAD_GEN' : 'SPONSORED',
          name: adInputs.name || `Single Image Ad ${Date.now()}`,
        },
      };

      // Log payload
      this.logger.log(
        `Creating ad creative for campaign URN: urn:li:sponsoredCampaign:${campaignExternalId}, payload: ${JSON.stringify(creativePayload, null, 2)}`,
      );

      // Create ad
      const accessToken = await this.linkedinService.getValidAccessToken();
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        'LinkedIn-Version': '202505',
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-RestLi-Protocol-Version': '2.0.0',
      };

      const createUrl = `https://api.linkedin.com/rest/adAccounts/${adAccountId}/creatives?action=createInline`; // Standard endpoint

      const response = await axios.post(createUrl, creativePayload, {
        headers,
      });

      if (![200, 201].includes(response.status)) {
        this.logger.error(
          `Failed to create ad: ${response.status} - ${JSON.stringify(response.data, null, 2)}`,
          {
            request: {
              url: createUrl,
              method: 'POST',
              headers,
              payload: JSON.stringify(creativePayload, null, 2),
            },
          },
        );
        throw new Error(`Failed to create ad: ${response.status}`);
      }

      let adUrn: string | undefined;
      if (
        response.data &&
        typeof response.data === 'object' &&
        'value' in response.data &&
        response.data.value &&
        typeof response.data.value === 'object' &&
        'creative' in response.data.value
      ) {
        adUrn = (response.data as any).value.creative;
      } else {
        adUrn = response.headers['x-restli-id'];
      }
      if (!adUrn || !adUrn.startsWith('urn:li:sponsoredCreative:')) {
        this.logger.error('Invalid or missing ad URN in response', {
          responseData: JSON.stringify(response.data, null, 2),
          headers: response.headers,
        });
        throw new Error('Invalid ad URN');
      }

      const adId = this.extractIdFromUrn(adUrn);
      this.logger.log(`Created ad with ID: ${adId}`);
      return adId;
    } catch (error: any) {
      this.logger.error(
        `Error creating SINGLE_IMAGE ad for campaign ${campaignId}: ${error.message}`,
        error.response
          ? {
              status: error.response.status,
              data: JSON.stringify(error.response.data, null, 2),
              request: {
                url: error.config?.url,
                method: error.config?.method,
                headers: error.config?.headers,
                payload: error.config?.data
                  ? JSON.parse(error.config.data)
                  : undefined,
              },
            }
          : undefined,
      );

      if (error.response?.status === 401) {
        throw new UnauthorizedException('Invalid access token');
      }
      if (error.response?.status === 403) {
        throw new ForbiddenException(
          'Missing permissions (rw_ads, w_organization_social)',
        );
      }
      if (error.response?.status === 429) {
        throw new Error('Rate limit exceeded');
      }
      if (error.response?.status === 400 || error.response?.status === 422) {
        throw new Error(
          `Invalid request: ${error.response.data.message || JSON.stringify(error.response.data, null, 2)}`,
        );
      }
      throw new Error(`Failed to create ad: ${error.message}`);
    }
  }
  private async createSingleVideoAd(
    adInputs: {
      name?: string;
      intendedStatus: string;
      headline: string;
      introText: string;
      destinationUrl?: string;
      video: Buffer;
      videoUrn?: string;
      thumbnail?: Buffer;
      leadGenFormUrn?: string;
      leadgenCallToAction?: string;
    },
    campaignId: string,
    adAccountId: string,
    campaignExternalId: string,
  ): Promise<string> {
    // Log inputs
    const { video, thumbnail, ...adInputsWithoutMedia } = adInputs;
    this.logger.log(
      `Creating SINGLE_VIDEO ad for campaign ID: ${campaignId}, ad account ID: ${adAccountId}, inputs: ${JSON.stringify(adInputsWithoutMedia, null, 2)}`,
    );

    try {
      // Validate media inputs
      if (!adInputs.video && !adInputs.videoUrn) {
        this.logger.error(
          'Either video (Buffer) or videoUrn (string) is required',
        );
        throw new Error('Either video or videoUrn is required');
      }
      if (adInputs.video && adInputs.videoUrn) {
        this.logger.error('Cannot provide both video and videoUrn');
        throw new Error('Cannot provide both video and videoUrn');
      }
      if (adInputs.video && !(adInputs.video instanceof Buffer)) {
        this.logger.error('Video must be a Buffer');
        throw new Error('Video must be a Buffer');
      }
      if (adInputs.videoUrn && !adInputs.videoUrn.startsWith('urn:li:video:')) {
        this.logger.error(
          'Invalid videoUrn format; must start with urn:li:video:',
        );
        throw new Error('Invalid videoUrn format');
      }
      if (adInputs.thumbnail && !(adInputs.thumbnail instanceof Buffer)) {
        this.logger.error('Thumbnail must be a Buffer');
        throw new Error('Thumbnail must be a Buffer');
      }

      // Fetch campaign
      const campaign = await this.prisma.marketingCampaign.findUnique({
        where: { campaign_id: campaignId },
        select: { objective: true },
      });
      if (!campaign) {
        this.logger.error(`Campaign not found: ${campaignId}`);
        throw new Error(`Campaign not found: ${campaignId}`);
      }

      // Validate lead generation fields
      const isLeadGen = campaign.objective === 'LEAD_GENERATION';
      if (isLeadGen) {
        if (
          !adInputs.leadGenFormUrn ||
          !/^(urn:li:(leadGenForm|adForm):.+)$/.test(adInputs.leadGenFormUrn)
        ) {
          this.logger.error(
            'Valid leadGenFormUrn (e.g., urn:li:adForm:...) is required for LEAD_GENERATION',
          );
          throw new Error('Valid leadGenFormUrn is required');
        }
        if (
          !adInputs.leadgenCallToAction ||
          ![
            'APPLY',
            'DOWNLOAD',
            'VIEW_QUOTE',
            'LEARN_MORE',
            'SIGN_UP',
            'SUBSCRIBE',
            'REGISTER',
            'REQUEST_DEMO',
            'JOIN',
            'ATTEND',
            'UNLOCK_FULL_DOCUMENT',
          ].includes(adInputs.leadgenCallToAction)
        ) {
          this.logger.error(
            'Valid leadgenCallToAction (e.g., SIGN_UP) is required for LEAD_GENERATION',
          );
          throw new Error('Valid leadgenCallToAction is required');
        }
        if (adInputs.destinationUrl) {
          this.logger.warn(
            'destinationUrl is ignored for LEAD_GENERATION campaigns',
          );
          adInputs.destinationUrl = undefined;
        }
      } else {
        if (
          !adInputs.destinationUrl ||
          !/^https?:\/\/.+/.test(adInputs.destinationUrl)
        ) {
          this.logger.error(
            'Valid destination URL (http:// or https://) is required for non-lead generation campaigns',
          );
          throw new Error('Valid destination URL is required');
        }
      }

      // Fetch ad account
      const adAccount = await this.prisma.adAccount.findUnique({
        where: { id: adAccountId },
        include: { linkedInPage: { select: { pageId: true } } },
      });
      if (!adAccount || !adAccount.linkedInPage?.pageId) {
        this.logger.error(
          `No LinkedIn page found for ad account ${adAccountId}`,
        );
        throw new Error('No LinkedIn page found');
      }
      const authorUrn = `urn:li:organization:${adAccount.linkedInPage.pageId}`;

      // Upload video
      let finalVideoUrn: string;
      if (adInputs.videoUrn) {
        this.logger.log(`Using provided videoUrn: ${adInputs.videoUrn}`);
        finalVideoUrn = adInputs.videoUrn;
      } else {
        this.logger.log('Uploading video...');
        const uploadResult = await this.uploadVideoToLinkedIn(
          adInputs.video!,
          adAccountId,
          adInputs.thumbnail,
        );
        if (
          !uploadResult.success ||
          !uploadResult.data ||
          !uploadResult.data.urn
        ) {
          this.logger.error('Video upload failed');
          throw new Error('Video upload failed');
        }
        finalVideoUrn = uploadResult.data.urn;
        this.logger.log(`Video uploaded: ${finalVideoUrn}`);
      }

      // Build payload step-by-step
      const postPayload = {
        adContext: {
          dscAdAccount: `urn:li:sponsoredAccount:${adAccountId}`,
          dscStatus: adAccount.status || 'ACTIVE',
        },
        author: authorUrn,
        commentary: adInputs.introText || '',
        visibility: 'PUBLIC',
        lifecycleState: 'PUBLISHED',
        isReshareDisabledByAuthor: false,
        contentCallToActionLabel: isLeadGen
          ? adInputs.leadgenCallToAction
          : 'LEARN_MORE',
        contentLandingPage: isLeadGen ? '' : adInputs.destinationUrl || '',
      };

      const contentPayload = {
        media: {
          title: adInputs.headline || 'Single Video Ad',
          id: finalVideoUrn,
        },
      };

      const inlineContentPayload = {
        post: {
          ...postPayload,
          content: contentPayload,
        },
      };

      let leadgenCallToActionPayload = {};
      if (
        isLeadGen &&
        adInputs.leadGenFormUrn &&
        adInputs.leadgenCallToAction
      ) {
        leadgenCallToActionPayload = {
          destination: adInputs.leadGenFormUrn,
          label: adInputs.leadgenCallToAction,
        };
      }

      const creativePayload = {
        creative: {
          inlineContent: inlineContentPayload,
          ...(isLeadGen
            ? { leadgenCallToAction: leadgenCallToActionPayload }
            : {}),
          campaign: `urn:li:sponsoredCampaign:${campaignExternalId}`,
          intendedStatus: adInputs.intendedStatus || 'DRAFT',
          name: adInputs.name || `Single Video Ad ${Date.now()}`,
        },
      };

      this.logger.log(
        `Creating ad creative for campaign URN: urn:li:sponsoredCampaign:${campaignExternalId}, payload: ${JSON.stringify(creativePayload, null, 2)}`,
      );

      const accessToken = await this.linkedinService.getValidAccessToken();
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        'LinkedIn-Version': '202505',
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-RestLi-Protocol-Version': '2.0.0',
      };

      const createUrl = `https://api.linkedin.com/rest/adAccounts/${adAccountId}/creatives?action=createInline`;

      const response = await axios.post(createUrl, creativePayload, {
        headers,
      });

      if (![200, 201].includes(response.status)) {
        this.logger.error(
          `Failed to create ad: ${response.status} - ${JSON.stringify(response.data, null, 2)}`,
          {
            response: {
              data: response.data,
              headers: response.headers,
              request: {
                url: createUrl,
                payload: creativePayload,
              },
            },
          },
        );
        throw new Error(`Failed to create ad: ${response.status}`);
      }

      let adUrn: string | undefined;
      if (
        response.data &&
        typeof response.data === 'object' &&
        'value' in response.data &&
        response.data.value &&
        typeof response.data.value === 'object' &&
        'creative' in response.data.value
      ) {
        adUrn = (response.data as any).value.creative;
      } else {
        adUrn = response.headers['x-restli-id'];
      }
      if (!adUrn || !adUrn.startsWith('urn:li:sponsoredCreative:')) {
        this.logger.error('Invalid ad URN in response', {
          responseData: JSON.stringify(response.data, null, 2),
          headers: response.headers,
        });
        throw new Error('Invalid ad URN');
      }

      const adId = this.extractIdFromUrn(adUrn);
      this.logger.log(`Created ad with ID: ${adId}`);
      return adId;
    } catch (error: any) {
      this.logger.error(
        `Error creating SINGLE_VIDEO ad for campaign ${campaignId}: ${error.message}`,
        error.response
          ? {
              status: error.response.status,
              data: JSON.stringify(error.response.data, null, 2),
              request: {
                url: error.config?.url,
                method: error.config?.method,
                headers: error.config?.headers,
                payload: error.config?.data
                  ? JSON.parse(error.config.data)
                  : undefined,
              },
            }
          : undefined,
      );

      if (error.response?.status === 401) {
        throw new UnauthorizedException('Invalid access token');
      }
      if (error.response?.status === 403) {
        throw new ForbiddenException(
          'Missing permissions (rw_ads, w_organization_social)',
        );
      }
      if (error.response?.status === 429) {
        throw new Error('Rate limit exceeded');
      }
      if (error.response?.status === 400 || error.response?.status === 422) {
        const errorDetails =
          error.response.data.errorDetails?.inputErrors || [];
        const errorMessages = errorDetails
          .map((e: any) => e.description)
          .join('; ');
        throw new Error(
          `Invalid request: ${error.response.data.message || 'Validation failed'} - ${errorMessages}`,
        );
      }
      throw new Error(`Failed to create ad: ${error.message}`);
    }
  }
  private async createCarouselAd(
    adInputs: {
      name?: string;
      intendedStatus: string;
      introText: string;
      destinationUrl?: string;
      useGlobalUrl: boolean;
      leadGenFormUrn?: string;
      leadgenCallToAction?: string;
      cards: {
        image?: Buffer;
        imageUrn?: string;
        headline: string;
        destinationUrl?: string;
      }[];
    },
    campaignId: string,
    adAccountId: string,
    campaignExternalId: string,
  ): Promise<string> {
    // Log inputs, excluding binary data for clarity
    const { cards, ...adInputsWithoutCards } = adInputs;
    const cardsForLogging = cards.map(({ image, ...card }) => card); // Omit image Buffer
    this.logger.log(
      `Creating CAROUSEL ad for campaign ID: ${campaignId}, ad account ID: ${adAccountId}, inputs: ${JSON.stringify(
        { ...adInputsWithoutCards, cards: cardsForLogging },
        null,
        2,
      )}`,
    );

    try {
      // Validate inputs
      if (
        !adInputs.cards ||
        !Array.isArray(adInputs.cards) ||
        adInputs.cards.length < 2 ||
        adInputs.cards.length > 10
      ) {
        this.logger.error('Carousel must have 2–10 cards');
        throw new Error('Carousel must have 2–10 cards');
      }

      for (const [index, card] of adInputs.cards.entries()) {
        if (!card.image && !card.imageUrn) {
          this.logger.error(`Card ${index} missing image or imageUrn`);
          throw new Error(
            `Card ${index} must include either an image or imageUrn`,
          );
        }
        if (card.image && card.imageUrn) {
          this.logger.error(
            `Card ${index} cannot provide both image and imageUrn`,
          );
          throw new Error(
            `Card ${index} cannot provide both image and imageUrn`,
          );
        }
        if (card.image && !(card.image instanceof Buffer)) {
          this.logger.error(`Card ${index} image must be a Buffer`);
          throw new Error(`Card ${index} image must be a Buffer`);
        }
        if (card.imageUrn && !card.imageUrn.startsWith('urn:li:image:')) {
          this.logger.error(
            `Card ${index} invalid imageUrn format; must start with urn:li:image:`,
          );
          throw new Error(`Card ${index} invalid imageUrn format`);
        }
        const headlineLimit = adInputs.useGlobalUrl ? 45 : 30; // Adjust based on LinkedIn’s constraints
        if (card.headline.length > headlineLimit) {
          this.logger.error(
            `Card ${index} headline exceeds ${headlineLimit} characters`,
          );
          throw new Error(
            `Card ${index} headline must be ${headlineLimit} characters or less`,
          );
        }
        if (!adInputs.useGlobalUrl && !card.destinationUrl) {
          this.logger.error(
            `Card ${index} missing destination URL when useGlobalUrl is false`,
          );
          throw new Error(`Card ${index} must include a destination URL`);
        }
      }

      // Fetch campaign
      const campaign = await this.prisma.marketingCampaign.findUnique({
        where: { campaign_id: campaignId },
        select: { objective: true },
      });
      if (!campaign) {
        this.logger.error(`Campaign not found: ${campaignId}`);
        throw new Error(`Campaign not found: ${campaignId}`);
      }

      // Validate lead generation fields
      const isLeadGen = campaign.objective === 'LEAD_GENERATION';
      if (isLeadGen) {
        if (
          !adInputs.leadGenFormUrn ||
          !/^(urn:li:(leadGenForm|adForm):.+)$/.test(adInputs.leadGenFormUrn)
        ) {
          this.logger.error(
            'Valid leadGenFormUrn (e.g., urn:li:adForm:...) is required for LEAD_GENERATION',
          );
          throw new Error('Valid leadGenFormUrn is required');
        }
        if (
          !adInputs.leadgenCallToAction ||
          ![
            'APPLY',
            'DOWNLOAD',
            'VIEW_QUOTE',
            'LEARN_MORE',
            'SIGN_UP',
            'SUBSCRIBE',
            'REGISTER',
            'REQUEST_DEMO',
            'JOIN',
            'ATTEND',
            'UNLOCK_FULL_DOCUMENT',
          ].includes(adInputs.leadgenCallToAction)
        ) {
          this.logger.error(
            'Valid leadgenCallToAction (e.g., REGISTER) is required for LEAD_GENERATION',
          );
          throw new Error('Valid leadgenCallToAction is required');
        }
        if (adInputs.destinationUrl) {
          this.logger.warn(
            'destinationUrl is ignored for LEAD_GENERATION campaigns',
          );
          adInputs.destinationUrl = undefined;
        }
      } else {
        if (
          !adInputs.destinationUrl ||
          !/^https?:\/\/.+/.test(adInputs.destinationUrl)
        ) {
          this.logger.error(
            'Valid destination URL (http:// or https://) is required for non-lead generation campaigns',
          );
          throw new Error('Valid destination URL is required');
        }
      }

      // Fetch ad account
      const adAccount = await this.prisma.adAccount.findUnique({
        where: { id: adAccountId },
        include: { linkedInPage: { select: { pageId: true } } },
      });
      if (!adAccount || !adAccount.linkedInPage?.pageId) {
        this.logger.error(
          `No LinkedIn page found for ad account ${adAccountId}`,
        );
        throw new Error('No LinkedIn page found');
      }
      const authorUrn = `urn:li:organization:${adAccount.linkedInPage.pageId}`;

      // Upload images for each card
      const cardImagesUrns: string[] = [];
      for (const [index, card] of adInputs.cards.entries()) {
        let imageUrn: string;
        if (card.imageUrn) {
          this.logger.log(
            `Using provided imageUrn for card ${index}: ${card.imageUrn}`,
          );
          imageUrn = card.imageUrn;
        } else {
          this.logger.log(
            `Uploading image for card ${index} in campaign ${campaignId}`,
          );
          const uploadResult = await this.uploadImageToLinkedIn(
            card.image!,
            adAccountId,
          );
          if (!uploadResult.success || !uploadResult.data?.urn) {
            this.logger.error(`Failed to upload image for card ${index}`);
            throw new Error(`Failed to upload image for card ${index}`);
          }
          imageUrn = uploadResult.data.urn;
          this.logger.log(
            `Image for card ${index} uploaded successfully, URN: ${imageUrn}`,
          );
        }
        cardImagesUrns.push(imageUrn);
      }

      // Build payload step-by-step
      const postPayload = {
        adContext: {
          dscAdAccount: `urn:li:sponsoredAccount:${adAccountId}`,
          dscStatus: adAccount.status || 'ACTIVE',
        },
        author: authorUrn,
        commentary: adInputs.introText || '',
        visibility: 'PUBLIC',
        lifecycleState: 'PUBLISHED',
        isReshareDisabledByAuthor: false,
        contentCallToActionLabel: isLeadGen
          ? adInputs.leadgenCallToAction
          : 'LEARN_MORE',
        contentLandingPage: isLeadGen ? '' : adInputs.destinationUrl || '',
      };

      const contentPayload = {
        carousel: {
          cards: adInputs.cards.map((card, index) => ({
            media: {
              id: cardImagesUrns[index],
              title: card.headline,
            },
            landingPage: adInputs.useGlobalUrl
              ? adInputs.destinationUrl
              : card.destinationUrl || '',
          })),
        },
      };

      const inlineContentPayload = {
        post: {
          ...postPayload,
          content: contentPayload,
        },
      };

      let leadgenCallToActionPayload = {};
      if (
        isLeadGen &&
        adInputs.leadGenFormUrn &&
        adInputs.leadgenCallToAction
      ) {
        leadgenCallToActionPayload = {
          destination: adInputs.leadGenFormUrn,
          label: adInputs.leadgenCallToAction,
        };
      }

      const creativePayload = {
        creative: {
          inlineContent: inlineContentPayload,
          ...(isLeadGen
            ? { leadgenCallToAction: leadgenCallToActionPayload }
            : {}),
          campaign: `urn:li:sponsoredCampaign:${campaignExternalId}`,
          intendedStatus: adInputs.intendedStatus || 'DRAFT',
          name: adInputs.name || `Carousel Ad ${Date.now()}`,
        },
      };

      this.logger.log(
        `Creating CAROUSEL ad creative for campaign URN: urn:li:sponsoredCampaign:${campaignExternalId}, payload: ${JSON.stringify(creativePayload, null, 2)}`,
      );

      // Create ad via inline creative endpoint
      const accessToken = await this.linkedinService.getValidAccessToken();
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        'LinkedIn-Version': '202505',
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-RestLi-Protocol-Version': '2.0.0',
      };

      const createUrl = `https://api.linkedin.com/rest/adAccounts/${adAccountId}/creatives?action=createInline`;
      const response = await axios.post(createUrl, creativePayload, {
        headers,
      });

      if (![200, 201].includes(response.status)) {
        this.logger.error(
          `Failed to create carousel ad: ${response.status} - ${JSON.stringify(response.data, null, 2)}`,
          {
            request: {
              url: createUrl,
              method: 'POST',
              headers,
              payload: creativePayload,
            },
          },
        );
        throw new Error(`Failed to create carousel ad: ${response.status}`);
      }

      let adUrn: string | undefined;
      if (
        response.data &&
        typeof response.data === 'object' &&
        'value' in response.data &&
        response.data.value &&
        typeof response.data.value === 'object' &&
        'creative' in response.data.value
      ) {
        adUrn = (response.data as any).value.creative;
      } else {
        adUrn = response.headers['x-restli-id'];
      }
      if (!adUrn || !adUrn.startsWith('urn:li:sponsoredCreative:')) {
        this.logger.error('Invalid ad URN in response', {
          responseData: JSON.stringify(response.data, null, 2),
          headers: response.headers,
        });
        throw new Error('Invalid ad URN');
      }

      const adId = this.extractIdFromUrn(adUrn);
      this.logger.log(`Created CAROUSEL ad with ID: ${adId}`);
      return adId;
    } catch (error: any) {
      this.logger.error(
        `Error creating CAROUSEL ad for campaign ${campaignId}: ${error.message}`,
        error.response
          ? {
              status: error.response.status,
              data: JSON.stringify(error.response.data, null, 2),
              request: {
                url: error.config?.url,
                method: error.config?.method,
                headers: error.config?.headers,
                payload: error.config?.data
                  ? JSON.parse(error.config.data)
                  : undefined,
              },
            }
          : undefined,
      );

      if (error.response?.status === 401) {
        throw new UnauthorizedException('Invalid access token');
      }
      if (error.response?.status === 403) {
        throw new ForbiddenException(
          'Missing permissions (rw_ads, w_organization_social)',
        );
      }
      if (error.response?.status === 429) {
        throw new Error('Rate limit exceeded');
      }
      if (error.response?.status === 400 || error.response?.status === 422) {
        const errorDetails =
          error.response.data.errorDetails?.inputErrors || [];
        const errorMessages = errorDetails
          .map((e: any) => e.description)
          .join('; ');
        throw new Error(
          `Invalid request: ${error.response.data.message || 'Validation failed'} - ${errorMessages}`,
        );
      }
      throw new Error(`Failed to create CAROUSEL ad: ${error.message}`);
    }
  }
  private async createSpotlightAd(
    adInputs: {
      name?: string;
      intendedStatus: string;
      headline: string;
      description?: string;
      destinationUrl: string;
      customCallToAction: string;
      image: Buffer;
      imageUrn?: string;
      useProfileImage: boolean;
      companyPage: string;
    },
    campaignId: string,
    adAccountId: string,
    campaignExternalId: string,
  ): Promise<string> {
    // Log inputs, excluding binary data for clarity
    const { image, ...adInputsWithoutImage } = adInputs;
    this.logger.log(
      `Creating SPOTLIGHT ad for campaign ID: ${campaignId}, ad account ID: ${adAccountId}, inputs: ${JSON.stringify(adInputsWithoutImage, null, 2)}`,
    );

    try {
      const adAccount = await this.prisma.adAccount.findUnique({
        where: { id: adAccountId },
      });
      if (!adAccount) {
        this.logger.error(`No ad account ${adAccountId}`);
        throw new Error('No ad account found');
      }
      // Upload image if provided
      let finalImageUrn: string;
      if (adInputs.imageUrn) {
        this.logger.log(`Using provided imageUrn: ${adInputs.imageUrn}`);
        finalImageUrn = adInputs.imageUrn;
      } else {
        this.logger.log('Uploading image for SPOTLIGHT ad...');
        const uploadResult = await this.uploadImageToLinkedIn(
          adInputs.image!,
          adAccountId,
        );
        if (!uploadResult.success || !uploadResult.data?.urn) {
          this.logger.error('Image upload failed');
          throw new Error('Image upload failed');
        }
        finalImageUrn = uploadResult.data.urn;
        this.logger.log(`Image uploaded: ${finalImageUrn}`);
      }

      // Build payload
      const creativePayload = {
        content: {
          spotlight: {
            callToAction: adInputs.customCallToAction,
            description: adInputs.description || '',
            headline: adInputs.headline,
            landingPage: adInputs.destinationUrl,
            logo: finalImageUrn,
            organizationName: adInputs.companyPage,
            showMemberProfilePhoto: adInputs.useProfileImage,
          },
        },
        name: adInputs.name || `Spotlight Ad ${Date.now()}`,
        campaign: `urn:li:sponsoredCampaign:${campaignExternalId}`,
        intendedStatus: adInputs.intendedStatus || 'DRAFT',
      };

      this.logger.log(
        `Creating SPOTLIGHT ad creative for campaign URN: urn:li:sponsoredCampaign:${campaignExternalId}, payload: ${JSON.stringify(creativePayload, null, 2)}`,
      );

      // Create ad via the creatives endpoint
      const accessToken = await this.linkedinService.getValidAccessToken();
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        'LinkedIn-Version': '202505',
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-RestLi-Protocol-Version': '2.0.0',
      };

      const createUrl = `https://api.linkedin.com/rest/adAccounts/${adAccountId}/creatives`;
      const response = await axios.post(createUrl, creativePayload, {
        headers,
      });

      if (![200, 201].includes(response.status)) {
        this.logger.error(
          `Failed to create SPOTLIGHT ad: ${response.status} - ${JSON.stringify(response.data, null, 2)}`,
          {
            request: {
              url: createUrl,
              method: 'POST',
              headers,
              payload: JSON.stringify(creativePayload, null, 2),
            },
          },
        );
        throw new Error(`Failed to create SPOTLIGHT ad: ${response.status}`);
      }

      let adUrn: string | undefined;
      if (
        response.data &&
        typeof response.data === 'object' &&
        'value' in response.data &&
        response.data.value &&
        typeof response.data.value === 'object' &&
        'creative' in response.data.value
      ) {
        adUrn = (response.data as any).value.creative;
      } else {
        adUrn = response.headers['x-restli-id'];
      }
      if (!adUrn || !adUrn.startsWith('urn:li:sponsoredCreative:')) {
        this.logger.error('Invalid ad URN in response', {
          responseData: JSON.stringify(response.data, null, 2),
          headers: response.headers,
        });
        throw new Error('Invalid ad URN');
      }

      const adId = this.extractIdFromUrn(adUrn);
      this.logger.log(`Created SPOTLIGHT ad with ID: ${adId}`);
      return adId;
    } catch (error: any) {
      this.logger.error(
        `Error creating SPOTLIGHT ad for campaign ${campaignId}: ${error.message}`,
        error.response
          ? {
              status: error.response.status,
              data: JSON.stringify(error.response.data, null, 2),
              request: {
                url: error.config?.url,
                method: error.config?.method,
                headers: error.config?.headers,
                payload: error.config?.data
                  ? JSON.parse(error.config.data)
                  : undefined,
              },
            }
          : undefined,
      );

      if (error.response?.status === 401) {
        throw new UnauthorizedException('Invalid access token');
      }
      if (error.response?.status === 403) {
        throw new ForbiddenException(
          'Missing permissions (rw_ads, w_organization_social)',
        );
      }
      if (error.response?.status === 429) {
        throw new Error('Rate limit exceeded');
      }
      if (error.response?.status === 400 || error.response?.status === 422) {
        const errorDetails =
          error.response.data.errorDetails?.inputErrors || [];
        const errorMessages = errorDetails
          .map((e: any) => e.description)
          .join('; ');
        throw new Error(
          `Invalid request: ${error.response.data.message || 'Validation failed'} - ${errorMessages}`,
        );
      }
      throw new Error(`Failed to create SPOTLIGHT ad: ${error.message}`);
    }
  }

  async uploadImageToLinkedIn(
    imageFile: Buffer,
    adAccountId: string,
  ): Promise<{
    success: boolean;
    message: string;
    data?: { urn: string };
  }> {
    this.logger.log(
      `uploading an image to LinkedIn for ad account ${adAccountId}, image size: ${imageFile.length} bytes`,
    );

    try {
      // Validate inputs
      if (!imageFile || !Buffer.isBuffer(imageFile)) {
        this.logger.error('Invalid image file provided');
        throw new Error('Invalid image file');
      }

      const adAccount = await this.prisma.adAccount.findUnique({
        where: { id: adAccountId },
        include: { linkedInPage: { select: { pageId: true } } },
      });

      if (!adAccount || !adAccount.linkedInPage) {
        this.logger.error(
          `Ad account ${adAccountId} not found or missing LinkedIn page`,
        );
        throw new NotFoundException(`Ad account ${adAccountId} not found`);
      }

      const organizationId = adAccount.linkedInPage.pageId;
      const organizationUrn = `urn:li:organization:${organizationId}`;

      // Get LinkedIn access token
      const accessToken = await this.linkedinService.getValidAccessToken();
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        'LinkedIn-Version': '202505',
        'X-RestLi-Protocol-Version': '2.0.0',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };

      // Step 1: Initialize image upload
      const initializeUrl =
        'https://api.linkedin.com/rest/images?action=initializeUpload';
      const initializePayload = {
        initializeUploadRequest: {
          owner: organizationUrn,
          mediaLibraryMetadata: {
            associatedAccount: `urn:li:sponsoredAccount:${adAccountId}`,
            assetName: `Ad Image ${Date.now()}`,
          },
        },
      };

      this.logger.log(
        `Initializing image upload for ad account URN: urn:li:sponsoredAccount:${adAccountId}`,
      );

      const initializeResponse = await axios.post<{
        value: {
          uploadUrl: string;
          uploadUrlExpiresAt: number;
          image: string;
        };
      }>(initializeUrl, initializePayload, { headers });

      if (initializeResponse.status !== 200) {
        this.logger.error(
          `Failed to initialize image upload: ${initializeResponse.status}`,
        );
        throw new Error(
          `Failed to initialize image upload: Received status ${initializeResponse.status}`,
        );
      }

      const { uploadUrl, image: imageUrn } = initializeResponse.data.value;

      // Step 2: Upload the image
      const uploadHeaders = {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'multipart/form-data',
      };

      this.logger.log(`Uploading image to ${uploadUrl}`);

      const formData = new FormData();
      formData.append('file', imageFile, {
        filename: `image-${Date.now()}.jpg`,
        contentType: 'image/jpeg',
      });

      const uploadResponse = await axios.put(uploadUrl, formData, {
        headers: {
          ...uploadHeaders,
          ...formData.getHeaders(),
        },
      });

      if (uploadResponse.status !== 200 && uploadResponse.status !== 201) {
        this.logger.error(`Failed to upload image: ${uploadResponse.status}`);
        throw new Error(
          `Failed to upload image: Received status ${uploadResponse.status}`,
        );
      }

      // Step 3: Verify image status (optional, to ensure it's AVAILABLE)
      const imageStatusUrl = `https://api.linkedin.com/rest/images/${encodeURIComponent(imageUrn)}`;
      let attempts = 0;
      const maxAttempts = 5;
      const delay = 1000; // 1 second delay between retries

      while (attempts < maxAttempts) {
        const statusResponse = await axios.get<{
          status: string;
          downloadUrl?: string;
          downloadUrlExpiresAt?: number;
        }>(imageStatusUrl, { headers });

        if (statusResponse.status !== 200) {
          this.logger.error(
            `Failed to fetch image status: ${statusResponse.status}`,
          );
          throw new Error(
            `Failed to fetch image status: Received status ${statusResponse.status}`,
          );
        }

        const { status } = statusResponse.data;
        this.logger.log(`Image ${imageUrn} status: ${status}`);

        if (status === 'AVAILABLE') {
          return {
            success: true,
            message: `Successfully uploaded and processed image for ad account ${adAccountId}`,
            data: { urn: imageUrn },
          };
        } else if (status === 'PROCESSING_FAILED') {
          this.logger.error(`Image processing failed for ${imageUrn}`);
          throw new Error(`Image processing failed for ${imageUrn}`);
        }

        attempts++;
        if (attempts < maxAttempts) {
          this.logger.log(`Image still processing, retrying in ${delay}ms...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }

      this.logger.error(
        `Image ${imageUrn} did not become AVAILABLE after ${maxAttempts} attempts`,
      );
      throw new Error(`Image processing timeout for ${imageUrn}`);
    } catch (error: any) {
      if (error.response) {
        this.logger.error(
          `LinkedIn API Error: ${error.response.status} - ${JSON.stringify(error.response.data)}`,
          {
            request: {
              url: error.config?.url,
              method: error.config?.method,
              headers: error.config?.headers,
            },
          },
        );
        if (error.response.status === 401) {
          throw new UnauthorizedException('Invalid or expired access token');
        }
        if (error.response.status === 403) {
          throw new ForbiddenException(
            'Missing required permissions (rw_ads, w_organization_social, w_power_creators)',
          );
        }
        if (error.response.status === 429) {
          throw new Error('Rate limit exceeded');
        }
        if (error.response.status === 400) {
          const errorMessage = error.response.data.message || 'Invalid request';
          if (
            errorMessage.includes('INVALID_IMAGE_ID') ||
            errorMessage.includes('INVALID_URN_ID') ||
            errorMessage.includes('INVALID_URN_TYPE')
          ) {
            throw new Error(`Invalid request: ${errorMessage}`);
          }
          if (errorMessage.includes('UPDATING_ASSET_FAILED')) {
            throw new Error(`Failed to process image: ${errorMessage}`);
          }
          throw new Error(
            `Invalid request: ${JSON.stringify(error.response.data)}`,
          );
        }
      }
      this.logger.error(
        `Failed to upload image for ad account ${adAccountId}: ${error.message}`,
      );
      throw new Error(`Failed to upload image: ${error.message}`);
    }
  }
  async uploadVideoToLinkedIn(
    video: Buffer,
    adAccountId: string,
    thumbnail?: Buffer,
  ): Promise<{ success: boolean; data: { urn: string } | null }> {
    this.logger.log(
      `Uploading video for ad account ID: ${adAccountId}, video size: ${video.length} bytes, thumbnail: ${thumbnail ? `${thumbnail.length} bytes` : 'none'}`,
    );

    try {
      // Validate inputs
      if (!video || video.length === 0) {
        this.logger.error('Video buffer is empty or missing');
        throw new Error('Video buffer is empty or missing');
      }
      const maxSizeMB = 500 * 1024 * 1024; // 500 MB max
      if (video.length > maxSizeMB) {
        this.logger.error(`Video size exceeds 500 MB: ${video.length} bytes`);
        throw new Error(`Video size exceeds 500 MB: ${video.length} bytes`);
      }
      if (!adAccountId) {
        this.logger.error('Ad account ID is required');
        throw new Error('Ad account ID is required');
      }
      if (thumbnail && thumbnail.length === 0) {
        this.logger.error('Thumbnail buffer is empty');
        throw new Error('Thumbnail buffer is empty');
      }

      // Fetch ad account to get organization URN
      const adAccount = await this.prisma.adAccount.findUnique({
        where: { id: adAccountId },
        include: { linkedInPage: { select: { pageId: true } } },
      });
      if (!adAccount || !adAccount.linkedInPage?.pageId) {
        this.logger.error(
          `No LinkedIn page found for ad account ${adAccountId}`,
        );
        throw new NotFoundException(
          `No LinkedIn page found for ad account ${adAccountId}`,
        );
      }
      const owner = `urn:li:organization:${adAccount.linkedInPage.pageId}`;
      this.logger.log(`Using organization URN as owner: ${owner}`);

      // Get access token
      const accessToken = await this.linkedinService.getValidAccessToken();
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        'LinkedIn-Version': '202505',
        'X-RestLi-Protocol-Version': '2.0.0',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };

      // Step 1: Initialize Upload
      const initializeUrl =
        'https://api.linkedin.com/rest/videos?action=initializeUpload';
      const initializePayload = {
        initializeUploadRequest: {
          owner,
          fileSizeBytes: video.length,
          uploadCaptions: false,
          uploadThumbnail: !!thumbnail,
          mediaLibraryMetadata: {
            associatedAccount: `urn:li:sponsoredAccount:${adAccountId}`,
            assetName: `Ad Video ${Date.now()}`,
          },
        },
      };

      this.logger.log(
        `Initializing video upload with payload: ${JSON.stringify(initializePayload, null, 2)}`,
      );
      const initializeResponse = await axios.post(
        initializeUrl,
        initializePayload,
        { headers },
      );

      const initData = initializeResponse.data as {
        value: {
          uploadUrlsExpireAt: number;
          video: string;
          uploadInstructions: Array<{
            uploadUrl: string;
            firstByte: number;
            lastByte: number;
          }>;
          uploadToken: string;
          thumbnailUploadUrl?: string;
        };
      };

      if (initializeResponse.status !== 200 || !initData.value) {
        this.logger.error(
          `Failed to initialize video upload: ${initializeResponse.status} - ${JSON.stringify(initializeResponse.data)}`,
          {
            request: {
              url: initializeUrl,
              method: 'POST',
              headers,
              payload: initializePayload,
            },
          },
        );
        throw new Error(
          `Failed to initialize video upload: ${initializeResponse.status}`,
        );
      }

      const {
        uploadInstructions,
        video: videoUrn,
        uploadToken,
        thumbnailUploadUrl,
      } = initData.value;
      this.logger.log(
        `Video upload initialized, URN: ${videoUrn}, uploadInstructions: ${JSON.stringify(uploadInstructions, null, 2)}`,
      );
      if (!uploadInstructions?.length || !videoUrn) {
        this.logger.error(
          'Missing uploadInstructions or video URN in initialize response',
        );
        throw new Error('Missing uploadInstructions or video URN');
      }
      if (thumbnail && !thumbnailUploadUrl) {
        this.logger.error(
          'Missing thumbnailUploadUrl in initialize response when thumbnail is provided',
        );
        throw new Error('Missing thumbnailUploadUrl');
      }

      // Step 2: Upload Video Parts
      const eTags: string[] = [];
      for (const instruction of uploadInstructions) {
        const { uploadUrl, firstByte, lastByte } = instruction;
        const chunk = video.slice(firstByte, lastByte + 1);
        const uploadHeaders = {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/octet-stream',
          'Content-Length': (lastByte - firstByte + 1).toString(),
          'Content-Range': `bytes ${firstByte}-${lastByte}/${video.length}`,
        };

        this.logger.log(
          `Uploading video part to ${uploadUrl}, bytes ${firstByte}-${lastByte}`,
        );
        const maxRetries = 3;
        let attempt = 1;
        let uploadResponse;
        while (attempt <= maxRetries) {
          try {
            uploadResponse = await axios.put(uploadUrl, chunk, {
              headers: uploadHeaders,
            });
            break;
          } catch (error: any) {
            if (
              error.response?.status === 429 ||
              error.response?.status === 503
            ) {
              this.logger.warn(
                `Retry ${attempt}/${maxRetries} for ${uploadUrl}: ${error.response.status}`,
              );
              await new Promise((resolve) =>
                setTimeout(resolve, 1000 * attempt),
              );
              attempt++;
              continue;
            }
            throw error;
          }
        }

        if (!uploadResponse || uploadResponse.status !== 200) {
          this.logger.error(
            `Failed to upload video part: ${uploadResponse?.status || 'No response'} - ${JSON.stringify(uploadResponse?.data || {})}`,
            {
              request: {
                url: uploadUrl,
                method: 'PUT',
                headers: uploadHeaders,
                payload: 'Binary video part',
              },
            },
          );
          throw new Error(
            `Failed to upload video part: ${uploadResponse?.status || 'No response'}`,
          );
        }

        const eTag = uploadResponse.headers.etag;
        if (!eTag) {
          this.logger.error(
            'Missing ETag in video part upload response headers',
          );
          throw new Error('Missing ETag');
        }
        eTags.push(eTag);
        this.logger.log(`Video part uploaded, ETag: ${eTag}`);
      }

      // Step 3: Upload Thumbnail (if provided)
      if (thumbnail && thumbnailUploadUrl) {
        const thumbnailHeaders = {
          Authorization: `Bearer ${accessToken}`,
          'media-type-family': 'STILLIMAGE',
          'Content-Type': 'application/octet-stream',
          'Content-Length': thumbnail.length.toString(),
        };

        this.logger.log(`Uploading thumbnail to ${thumbnailUploadUrl}`);
        const thumbnailResponse = await axios.put(
          thumbnailUploadUrl,
          thumbnail,
          { headers: thumbnailHeaders },
        );

        if (thumbnailResponse.status !== 201) {
          this.logger.error(
            `Failed to upload thumbnail: ${thumbnailResponse.status} - ${JSON.stringify(thumbnailResponse.data)}`,
            {
              request: {
                url: thumbnailUploadUrl,
                method: 'PUT',
                headers: thumbnailHeaders,
                payload: 'Binary thumbnail data',
              },
            },
          );
          throw new Error(
            `Failed to upload thumbnail: ${thumbnailResponse.status}`,
          );
        }
        this.logger.log('Thumbnail uploaded successfully');
      }

      // Step 4: Finalize Upload
      const finalizeUrl =
        'https://api.linkedin.com/rest/videos?action=finalizeUpload';
      const finalizePayload = {
        finalizeUploadRequest: {
          video: videoUrn,
          uploadToken,
          uploadedPartIds: eTags,
        },
      };

      this.logger.log(`Finalizing video upload for URN: ${videoUrn}`);
      const finalizeResponse = await axios.post(finalizeUrl, finalizePayload, {
        headers,
      });

      if (finalizeResponse.status !== 200) {
        this.logger.error(
          `Failed to finalize video upload: ${finalizeResponse.status} - ${JSON.stringify(finalizeResponse.data)}`,
          {
            request: {
              url: finalizeUrl,
              method: 'POST',
              headers,
              payload: finalizePayload,
            },
          },
        );
        throw new Error(
          `Failed to finalize video upload: ${finalizeResponse.status}`,
        );
      }

      this.logger.log(
        `Successfully finalized video upload with URN: ${videoUrn}`,
      );
      return { success: true, data: { urn: videoUrn } };
    } catch (error: any) {
      if (error.response) {
        const { status, data } = error.response;
        this.logger.error(
          `LinkedIn API Error: ${status} - ${JSON.stringify(data)}`,
          {
            request: {
              url: error.config?.url,
              method: error.config?.method,
              headers: error.config?.headers,
              payload:
                error.config?.data && typeof error.config.data === 'string'
                  ? JSON.parse(error.config.data)
                  : 'Binary data',
            },
          },
        );
        if (status === 401) {
          throw new UnauthorizedException('Invalid or expired access token');
        } else if (status === 403) {
          throw new ForbiddenException(
            'Missing required permissions (rw_ads, w_organization_social)',
          );
        } else if (status === 429) {
          throw new Error('Rate limit exceeded');
        } else if (status === 400 || status === 422) {
          const errorMessage = data.message || JSON.stringify(data);
          if (errorMessage.includes('EXPIRED_UPLOAD_URL')) {
            throw new Error('Video upload URL expired');
          } else if (errorMessage.includes('MEDIA_ASSET_PROCESSING_FAILED')) {
            throw new Error('Media asset processing failed');
          }
          throw new Error(`Invalid request: ${errorMessage}`);
        }
      }
      this.logger.error(
        `Failed to upload video for ad account ${adAccountId}: ${error.message}`,
        { stack: error.stack },
      );
      throw new Error(`Failed to upload video: ${error.message}`);
    }
  }
  async updateLinkedInCampaignAd(
    adId: string,
    data,
  ): Promise<{
    success: boolean;
    message: string;
    data?: any;
  }> {
    this.logger.log(`Updating LinkedIn campaign ad with ID: ${adId}`);
    // TODO: Implement campaign update logic
    throw new Error('Method not implemented');
  }

  async deleteLinkedInCampaignAd(adId: string): Promise<{
    success: boolean;
    message: string;
    data: { id: string };
  }> {
    this.logger.log(`Deleting LinkedIn campaign ad with ID: ${adId}`);
    // TODO: Implement campaign deletion logic
    throw new Error('Method not implemented');
  }

  async findOneLinkedInCampaignAd(adId: string): Promise<any> {
    this.logger.log(`Fetching LinkedIn campaign ad with ID: ${adId}`);
    // TODO: Implement campaign retrieval logic
    throw new Error('Method not implemented');
  }

  async findAllLinkedInCampaignAds(campaignId: string): Promise<any[]> {
    this.logger.log('Fetching all LinkedIn campaign ads');
    // TODO: Implement retrieval of all campaigns
    throw new Error('Method not implemented');
  }

  async getAdPreview(adId: string): Promise<{
    success: boolean;
    message: string;
    data: LinkedInAdPreviewResponse['elements'];
  }> {
    this.logger.log(`Fetching preview for ad ID: ${adId}}`);

    try {
      // Validate adId
      if (!/^\d+$/.test(adId)) {
        this.logger.error(`Invalid ad ID: ${adId}`);
        throw new Error('Invalid ad ID');
      }

      const ad = await this.prisma.ad.findUnique({
        where: { id: adId },
        select: { adAccountId: true },
      });
      if (!ad || !ad.adAccountId) {
        this.logger.error(`Ad ${adId} not found or missing adAccountId`);
        throw new Error(`Ad ${adId} not found`);
      }

      // Validate accountId
      if (!/^\d+$/.test(ad.adAccountId)) {
        this.logger.error(`Invalid account ID: ${ad.adAccountId}`);
        throw new Error('Invalid account ID');
      }

      // Construct URNs
      const creativeUrn = `urn:li:sponsoredCreative:${adId}`;
      const accountUrn = `urn:li:sponsoredAccount:${ad.adAccountId}`;

      // Get LinkedIn access token
      const accessToken = await this.linkedinService.getValidAccessToken();
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        'LinkedIn-Version': '202505',
        'X-RestLi-Protocol-Version': '2.0.0',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };

      // Fetch preview
      const url = `https://api.linkedin.com/rest/adPreviews?q=creative&creative=${encodeURIComponent(creativeUrn)}&account=${encodeURIComponent(accountUrn)}`;
      this.logger.log(`Sending request to LinkedIn API: ${url}`);

      const response = await axios.get<LinkedInAdPreviewResponse>(url, {
        headers,
      });

      if (response.status !== 200) {
        this.logger.error(`Unexpected response status: ${response.status}`);
        throw new Error(
          `Failed to fetch ad preview: Received status ${response.status}`,
        );
      }

      return {
        success: true,
        message: `Successfully fetched preview for ${response.data.elements.length} ad(s) with ID ${adId}`,
        data: response.data.elements,
      };
    } catch (error: any) {
      if (error.response) {
        this.logger.error(
          `LinkedIn API Error: ${error.response.status} - ${JSON.stringify(error.response.data)}`,
          {
            request: {
              url: error.config?.url,
              method: error.config?.method,
              headers: error.config?.headers,
            },
          },
        );
        if (error.response.status === 401) {
          throw new UnauthorizedException('Invalid or expired access token');
        }
        if (error.response.status === 403) {
          throw new ForbiddenException(
            'Missing required scopes (r_ads, rw_ads) or insufficient permissions',
          );
        }
        if (error.response.status === 429) {
          throw new Error('Rate limit exceeded');
        }
        if (error.response.status === 404) {
          throw new Error(`Ad preview not found for ad ID: ${adId}`);
        }
        if (error.response.status === 400) {
          throw new Error(
            `Invalid request: ${JSON.stringify(error.response.data)}`,
          );
        }
      }
      this.logger.error(
        `Failed to fetch ad preview for ${adId}: ${error.message}`,
      );
      throw new Error(`Failed to fetch ad preview: ${error.message}`);
    }
  }

  async fetchLinkedInPagePosts(
    orgUrn: string,
    adAccountId: string,
    campaignId: string,
  ): Promise<{
    success: boolean;
    message: string;
    data: AdEligiblePost[];
  }> {
    this.logger.log(
      `Fetching LinkedIn posts for organization ${orgUrn}, ad account ${adAccountId}, and campaign ${campaignId}`,
    );

    try {
      if (!orgUrn || !orgUrn.startsWith('urn:li:organization:')) {
        this.logger.error(`Invalid organization URN: ${orgUrn}`);
        throw new Error('Invalid organization URN');
      }
      if (!/^\d+$/.test(adAccountId)) {
        this.logger.error(`Invalid ad account ID: ${adAccountId}`);
        throw new Error('Invalid ad account ID');
      }
      if (!campaignId) {
        this.logger.error(`Invalid campaign ID: ${campaignId}`);
        throw new Error('Invalid campaign ID');
      }

      const campaign = await this.prisma.marketingCampaign.findFirst({
        where: { campaign_id: campaignId },
        select: { objective: true, format: true },
      });
      if (!campaign) {
        this.logger.error(`Campaign not found: ${campaignId}`);
        throw new NotFoundException(`Campaign not found: ${campaignId}`);
      }
      const { objective, format } = campaign;
      this.logger.log(`Campaign objective: ${objective}, adFormat: ${format}`);

      const formatToContentTypes: Partial<Record<Format, PostContentType[]>> = {
        [Format.STANDARD_UPDATE]: [PostContentType.TEXT, PostContentType.IMAGE],
        [Format.CAROUSEL]: [PostContentType.MULTI_IMAGE],
        [Format.SINGLE_VIDEO]: [PostContentType.VIDEO],
        [Format.TEXT_AD]: [PostContentType.TEXT],
        [Format.SPOTLIGHT]: [PostContentType.ARTICLE],
        [Format.SPONSORED_UPDATE_EVENT]: [PostContentType.ARTICLE],
        [Format.JOBS]: [PostContentType.ARTICLE],
      };

      const objectiveContentTypeRestrictions: Partial<
        Record<ObjectiveType, PostContentType[]>
      > = {
        [ObjectiveType.VIDEO_VIEWS]: [PostContentType.VIDEO],
      };

      let finalAllowedContentTypes: PostContentType[] = [
        PostContentType.TEXT,
        PostContentType.IMAGE,
        PostContentType.MULTI_IMAGE,
        PostContentType.VIDEO,
        PostContentType.DOCUMENT,
        PostContentType.ARTICLE,
      ];

      if (format && formatToContentTypes[format]) {
        finalAllowedContentTypes = formatToContentTypes[format];
      }

      if (
        objective &&
        Object.prototype.hasOwnProperty.call(
          objectiveContentTypeRestrictions,
          objective,
        )
      ) {
        finalAllowedContentTypes = finalAllowedContentTypes.filter((type) =>
          objectiveContentTypeRestrictions[objective]!.includes(type),
        );
      }

      this.logger.log(
        `Allowed content types: ${finalAllowedContentTypes.join(', ')}`,
      );

      const accessToken = await this.linkedinService.getValidAccessToken();
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        'LinkedIn-Version': '202505',
        'X-RestLi-Protocol-Version': '2.0.0',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };

      const eligiblePosts: AdEligiblePost[] = [];
      let start = 0;
      const count = 10;

      while (true) {
        const encodedOrgUrn = encodeURIComponent(orgUrn);
        const url = `https://api.linkedin.com/rest/posts?author=${encodedOrgUrn}&q=author&count=${count}&start=${start}&sortBy=LAST_MODIFIED`;
        this.logger.log(`Sending request to LinkedIn API: ${url}`);

        const response = await axios.get<LinkedInPost>(url, { headers });

        if (response.status !== 200) {
          this.logger.error(`Unexpected response status: ${response.status}`);
          throw new Error(
            `Failed to fetch posts: Received status ${response.status}`,
          );
        }

        for (const post of response.data.elements) {
          if (
            post.lifecycleState === 'PUBLISHED' &&
            post.visibility === 'PUBLIC' &&
            post.isReshareDisabledByAuthor === false &&
            !post.reshareContext
          ) {
            let contentType: PostContentType = PostContentType.TEXT;
            const content: AdEligiblePost['content'] = {};

            if (post.content?.multiImage?.images?.length) {
              contentType = PostContentType.MULTI_IMAGE;
              content.imageIds = post.content.multiImage.images.map(
                (img) => img.id,
              );
            } else if (post.content?.video?.id) {
              contentType = PostContentType.VIDEO;
              content.mediaId = post.content.video.id;
              content.mediaTitle = post.content.media?.title;
            } else if (post.content?.media?.id) {
              if (post.content.media.id.startsWith('urn:li:image:')) {
                contentType = PostContentType.IMAGE;
                content.mediaId = post.content.media.id;
                content.mediaTitle = post.content.media?.title;
              } else if (post.content.media.title) {
                contentType = PostContentType.DOCUMENT;
                content.mediaId = post.content.media.id;
                content.mediaTitle = post.content.media.title;
              }
            } else if (post.content?.article) {
              contentType = PostContentType.ARTICLE;
              content.article = {
                title: post.content.article.title,
                source: post.content.article.source,
                thumbnail: post.content.article.thumbnail,
                thumbnailAltText: post.content.article.thumbnailAltText,
              };
            } else if (post.content?.reference?.id) {
              contentType = PostContentType.ARTICLE;
              content.mediaId = post.content.reference.id;
            }

            this.logger.debug(`Post ${post.id} classified as ${contentType}`);

            if (finalAllowedContentTypes.includes(contentType)) {
              eligiblePosts.push({
                id: post.id,
                commentary: post.commentary || null,
                contentType,
                content,
                createdAt: post.createdAt || null,
                lastModifiedAt: post.lastModifiedAt
                  ? new Date(post.lastModifiedAt).getTime()
                  : null,
                visibility: post.visibility || null,
                lifecycleState: post.lifecycleState || null,
                contentLandingPage: post.contentLandingPage || null,
                isReshareDisabledByAuthor:
                  post.isReshareDisabledByAuthor ?? true,
                adContext: post.adContext
                  ? {
                      dscStatus: post.adContext.dscStatus || null,
                      dscName: post.adContext.dscName || null,
                      dscAdType: post.adContext.dscAdType || null,
                      isDsc: post.adContext.isDsc ?? false,
                      dscAdAccount: post.adContext.dscAdAccount || null,
                    }
                  : null,
              });
            }
          }
        }

        if (
          response.data.paging.links.length === 0 ||
          response.data.elements.length < count
        ) {
          break;
        }
        start += count;
      }

      return {
        success: true,
        message: `Successfully fetched ${eligiblePosts.length} ad-eligible posts for organization ${orgUrn} and campaign ${campaignId}`,
        data: eligiblePosts,
      };
    } catch (error: any) {
      if (error.response) {
        this.logger.error(
          `LinkedIn API Error: ${error.response.status} - ${JSON.stringify(error.response.data)}`,
          {
            request: {
              url: error.config?.url,
              method: error.config?.method,
              headers: error.config?.headers,
            },
          },
        );
        if (error.response.status === 401) {
          throw new UnauthorizedException('Invalid or expired access token');
        }
        if (error.response.status === 403) {
          throw new ForbiddenException(
            'Missing required scopes (r_organization_social, r_ads) or insufficient permissions',
          );
        }
        if (error.response.status === 429) {
          throw new Error('Rate limit exceeded');
        }
        if (error.response.status === 400) {
          throw new Error(
            `Invalid request: ${JSON.stringify(error.response.data)}`,
          );
        }
        if (error.response.status === 404) {
          throw new Error(`No posts found for organization: ${orgUrn}`);
        }
      }
      this.logger.error(
        `Failed to fetch posts for ${orgUrn}, campaign ${campaignId}: ${error.message}`,
      );
      throw new Error(`Failed to fetch posts: ${error.message}`);
    }
  }

  async getAllAdAccounts() {
    return this.prisma.adAccount.findMany();
  }

  async getImagesForAdAccount(adAccountId: string): Promise<{
    success: boolean;
    message: string;
    data: Array<{
      id: string;
      owner: string;
      status: string;
      downloadUrl?: string;
      downloadUrlExpiresAt?: number;
      mediaLibraryMetadata: {
        associatedAccount: string;
        mediaLibraryStatus: string;
        assetName: string;
      };
    }>;
  }> {
    this.logger.log(`Fetching images for ad account ID: ${adAccountId}`);

    try {
      // Validate adAccountId
      if (!/^\d+$/.test(adAccountId)) {
        this.logger.error(`Invalid ad account ID: ${adAccountId}`);
        throw new Error('Invalid ad account ID');
      }

      // Verify ad account exists
      const adAccount = await this.prisma.adAccount.findUnique({
        where: { id: adAccountId },
      });
      if (!adAccount) {
        this.logger.error(`Ad account not found: ${adAccountId}`);
        throw new NotFoundException(`Ad account not found: ${adAccountId}`);
      }

      const accountUrn = `urn:li:sponsoredAccount:${adAccountId}`;
      const allImages: Array<{
        id: string;
        owner: string;
        status: string;
        downloadUrl?: string;
        downloadUrlExpiresAt?: number;
        mediaLibraryMetadata: {
          associatedAccount: string;
          mediaLibraryStatus: string;
          assetName: string;
        };
      }> = [];

      // Get LinkedIn access token
      const accessToken = await this.linkedinService.getValidAccessToken();
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        'LinkedIn-Version': '202505',
        'X-RestLi-Protocol-Version': '2.0.0',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };

      let url: string | null =
        `https://api.linkedin.com/rest/images?q=associatedAccount&associatedAccount=${encodeURIComponent(accountUrn)}&start=0&count=10`;

      while (url) {
        this.logger.log(`Sending request to LinkedIn API: ${url}`);

        const response = await axios.get<{
          paging: {
            start: number;
            count: number;
            links: Array<{
              type: string;
              rel: string;
              href: string;
            }>;
            total: number;
          };
          elements: Array<{
            id: string;
            owner: string;
            status: string;
            downloadUrl?: string;
            downloadUrlExpiresAt?: number;
            mediaLibraryMetadata: {
              associatedAccount: string;
              mediaLibraryStatus: string;
              assetName: string;
            };
          }>;
        }>(url, { headers });

        if (response.status !== 200) {
          this.logger.error(
            `Failed to fetch images: ${response.status} - ${JSON.stringify(response.data, null, 2)}`,
            {
              request: { url, method: 'GET', headers },
            },
          );
          throw new Error(
            `Failed to fetch images: Received status ${response.status}`,
          );
        }

        const images = response.data.elements;
        allImages.push(...images);

        this.logger.debug(
          `Fetched ${images.length} images, total so far: ${allImages.length}, paging: ${JSON.stringify(response.data.paging, null, 2)}`,
        );

        // Find the next link
        const nextLink = response.data.paging.links.find(
          (link) => link.rel === 'next',
        );
        url = nextLink ? `https://api.linkedin.com${nextLink.href}` : null;
      }

      return {
        success: true,
        message: `Successfully fetched ${allImages.length} active images for ad account ${adAccountId}`,
        data: allImages,
      };
    } catch (error: any) {
      this.logger.error(
        `Failed to fetch images for ad account ID: ${adAccountId}: ${error.message}`,
        error.response
          ? {
              status: error.response.status,
              data: JSON.stringify(error.response.data, null, 2),
              request: {
                url: error.config?.url,
                method: error.config?.method,
                headers: error.config?.headers,
              },
            }
          : undefined,
      );

      if (error.response?.status === 401) {
        throw new UnauthorizedException('Invalid or expired access token');
      }
      if (error.response?.status === 403) {
        throw new ForbiddenException(
          'Missing required scopes (r_ads, rw_ads) or insufficient permissions',
        );
      }
      if (error.response?.status === 429) {
        throw new Error('Rate limit exceeded');
      }
      if (error.response?.status === 400 || error.response?.status === 404) {
        throw new Error(
          `Invalid request or no images found: ${error.response.data.message || JSON.stringify(error.response.data, null, 2)}`,
        );
      }
      throw new Error(`Failed to fetch images: ${error.message}`);
    }
  }

  async getVideosForAdAccount(adAccountId: string): Promise<{
    success: boolean;
    message: string;
    data: Array<{
      id: string;
      owner: string;
      status: string;
      downloadUrl?: string;
      downloadUrlExpiresAt?: number;
      thumbnail?: string;
      duration?: number;
      aspectRatioWidth?: number;
      aspectRatioHeight?: number;
      mediaLibraryMetadata: {
        associatedAccount: string;
        mediaLibraryStatus: string;
        assetName: string;
      };
    }>;
  }> {
    this.logger.log(`Fetching videos for ad account ID: ${adAccountId}`);

    try {
      // Validate adAccountId
      if (!/^\d+$/.test(adAccountId)) {
        this.logger.error(`Invalid ad account ID: ${adAccountId}`);
        throw new Error('Invalid ad account ID');
      }

      // Verify ad account exists
      const adAccount = await this.prisma.adAccount.findUnique({
        where: { id: adAccountId },
      });
      if (!adAccount) {
        this.logger.error(`Ad account not found: ${adAccountId}`);
        throw new NotFoundException(`Ad account not found: ${adAccountId}`);
      }

      const accountUrn = `urn:li:sponsoredAccount:${adAccountId}`;
      const allVideos: Array<{
        id: string;
        owner: string;
        status: string;
        downloadUrl?: string;
        downloadUrlExpiresAt?: number;
        thumbnail?: string;
        duration?: number;
        aspectRatioWidth?: number;
        aspectRatioHeight?: number;
        mediaLibraryMetadata: {
          associatedAccount: string;
          mediaLibraryStatus: string;
          assetName: string;
        };
      }> = [];

      // Get LinkedIn access token
      const accessToken = await this.linkedinService.getValidAccessToken();
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        'LinkedIn-Version': '202505',
        'X-RestLi-Protocol-Version': '2.0.0',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };

      let url: string | null =
        `https://api.linkedin.com/rest/videos?q=associatedAccount&associatedAccount=${encodeURIComponent(accountUrn)}&start=0&count=10`;

      while (url) {
        this.logger.log(`Sending request to LinkedIn API: ${url}`);

        const response = await axios.get<{
          paging: {
            start: number;
            count: number;
            links: Array<{
              type: string;
              rel: string;
              href: string;
            }>;
            total: number;
          };
          elements: Array<{
            id: string;
            owner: string;
            status: string;
            downloadUrl?: string;
            downloadUrlExpiresAt?: number;
            thumbnail?: string;
            duration?: number;
            aspectRatioWidth?: number;
            aspectRatioHeight?: number;
            mediaLibraryMetadata: {
              associatedAccount: string;
              mediaLibraryStatus: string;
              assetName: string;
            };
          }>;
        }>(url, { headers });

        if (response.status !== 200) {
          this.logger.error(
            `Failed to fetch videos: ${response.status} - ${JSON.stringify(response.data, null, 2)}`,
            {
              request: { url, method: 'GET', headers },
            },
          );
          throw new Error(
            `Failed to fetch videos: Received status ${response.status}`,
          );
        }

        const videos = response.data.elements;
        allVideos.push(...videos);

        this.logger.debug(
          `Fetched ${videos.length} videos, total so far: ${allVideos.length}, paging: ${JSON.stringify(response.data.paging, null, 2)}`,
        );

        // Find the next link
        const nextLink = response.data.paging.links.find(
          (link) => link.rel === 'next',
        );
        url = nextLink ? `https://api.linkedin.com${nextLink.href}` : null;
      }

      return {
        success: true,
        message: `Successfully fetched ${allVideos.length} active videos for ad account ${adAccountId}`,
        data: allVideos,
      };
    } catch (error: any) {
      this.logger.error(
        `Failed to fetch videos for ad account ID: ${adAccountId}: ${error.message}`,
        error.response
          ? {
              status: error.response.status,
              data: JSON.stringify(error.response.data, null, 2),
              request: {
                url: error.config?.url,
                method: error.config?.method,
                headers: error.config?.headers,
              },
            }
          : undefined,
      );

      if (error.response?.status === 401) {
        throw new UnauthorizedException('Invalid or expired access token');
      }
      if (error.response?.status === 403) {
        throw new ForbiddenException(
          'Missing required scopes (r_ads, rw_ads) or insufficient permissions',
        );
      }
      if (error.response?.status === 429) {
        throw new Error('Rate limit exceeded');
      }
      if (error.response?.status === 400 || error.response?.status === 404) {
        throw new Error(
          `Invalid request or no videos found: ${error.response.data.message || JSON.stringify(error.response.data, null, 2)}`,
        );
      }
      throw new Error(`Failed to fetch videos: ${error.message}`);
    }
  }

async updateLinkedInCreative(
  creativeId: string,
  adAccountId: string,
  campaignId: string,
  updateInputs: {
    intendedStatus?: 'ACTIVE' | 'PAUSED' | 'ARCHIVED' | 'CANCELLED';
    leadgenCallToAction?: {
      adFormUrn?: string;
      label?: string;
    };
    name?: string;
  },
): Promise<{
  success: boolean;
  message: string;
  data?: any;
}> {
  this.logger.log(
    `Updating creative ID: ${creativeId} for ad account ID: ${adAccountId}, campaign ID: ${campaignId}, inputs: ${JSON.stringify(updateInputs, null, 2)}`,
  );

  try {
    // Fetch creative from Prisma to check status
    const creative = await this.prisma.ad.findUnique({
      where: {
        campaignId_id: {
          campaignId: campaignId,
          id: creativeId,
        },
      },
      select: {
        reviewStatus: true,
        intendedStatus: true,
        leadgenCallToAction: true,
      },
    });

    if (!creative) {
      this.logger.error(
        `Creative not found: ${creativeId} for campaign ${campaignId}`,
      );
      throw new NotFoundException(`Creative ${creativeId} not found`);
    }

    // Fetch campaign to check objective
    const campaign = await this.prisma.marketingCampaign.findUnique({
      where: { campaign_id: campaignId },
      select: { objective: true },
    });

    if (!campaign) {
      this.logger.error(`Campaign not found: ${campaignId}`);
      throw new NotFoundException(`Campaign ${campaignId} not found`);
    }

    // Build patch payload
    const patchPayload: { patch: { $set: any } } = { patch: { $set: {} } };

    // Handle intendedStatus
    if (updateInputs.intendedStatus) {
      if (
        creative.reviewStatus === 'PENDING' &&
        updateInputs.intendedStatus === 'PAUSED'
      ) {
        this.logger.error(
          'Cannot set intendedStatus to PAUSED for a creative in review',
        );
        throw new Error('Cannot pause a creative in review');
      }
      patchPayload.patch.$set.intendedStatus = updateInputs.intendedStatus;
    }

    // Handle leadgenCallToAction (only for LEAD_GENERATION campaigns in DRAFT status)
    if (updateInputs.leadgenCallToAction) {
      if (campaign.objective !== 'LEAD_GENERATION') {
        this.logger.error(
          'leadgenCallToAction can only be updated for LEAD_GENERATION campaigns',
        );
        throw new Error(
          'leadgenCallToAction is only applicable for LEAD_GENERATION campaigns',
        );
      }
      if (creative.intendedStatus !== 'DRAFT') {
        this.logger.error(
          'leadgenCallToAction can only be updated for creatives in DRAFT status',
        );
        throw new Error(
          'leadgenCallToAction can only be updated in DRAFT status',
        );
      }

      const { adFormUrn, label } = updateInputs.leadgenCallToAction;
      if (adFormUrn) {
        if (!/^(urn:li:(leadGenForm|adForm):.+)$/.test(adFormUrn)) {
          this.logger.error(
            'Invalid adFormUrn format; must start with urn:li:leadGenForm: or urn:li:adForm:',
          );
          throw new Error('Invalid adFormUrn format');
        }
      }
      if (label) {
        const validLabels = [
          'APPLY',
          'DOWNLOAD',
          'VIEW_QUOTE',
          'LEARN_MORE',
          'SIGN_UP',
          'SUBSCRIBE',
          'REGISTER',
          'REQUEST_DEMO',
          'JOIN',
          'ATTEND',
          'UNLOCK_FULL_DOCUMENT',
        ];
        if (!validLabels.includes(label)) {
          this.logger.error(`Invalid leadgenCallToAction label: ${label}`);
          throw new Error(
            `leadgenCallToAction label must be one of: ${validLabels.join(', ')}`,
          );
        }
      }

      // Only include leadgenCallToAction if both fields are provided
      if (adFormUrn && label) {
        patchPayload.patch.$set.leadgenCallToAction = {
          destination: adFormUrn,
          label,
        };
      }
    }

    // Handle name
    if (updateInputs.name) {
      patchPayload.patch.$set.name = updateInputs.name;
    }

    // Check if there are any fields to update
    if (Object.keys(patchPayload.patch.$set).length === 0) {
      this.logger.error('No valid fields provided for update');
      throw new Error('At least one valid field must be provided for update');
    }

    // Restrict updates to intendedStatus for non-DRAFT creatives
    if (
      creative.intendedStatus !== 'DRAFT' &&
      Object.keys(patchPayload.patch.$set).some((key) => key !== 'intendedStatus')
    ) {
      this.logger.error(
        'Only intendedStatus can be updated for non-DRAFT creatives',
      );
      throw new Error(
        'Only intendedStatus can be updated for non-DRAFT creatives',
      );
    }

    // Send POST request
    const accessToken = await this.linkedinService.getValidAccessToken();
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'LinkedIn-Version': '202505',
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-RestLi-Protocol-Version': '2.0.0',
      'X-RestLi-Method': 'PARTIAL_UPDATE',
    };

    const updateUrl = `https://api.linkedin.com/rest/adAccounts/${adAccountId}/creatives/${encodeURIComponent(`urn:li:sponsoredCreative:${creativeId}`)}`;
    this.logger.log(
      `Sending POST request to update creative: ${updateUrl}, payload: ${JSON.stringify(patchPayload, null, 2)}`,
    );
    const response = await axios.post(updateUrl, patchPayload, { headers });

    if (response.status !== 204) {
      this.logger.error(
        `Failed to update creative: ${response.status} - ${JSON.stringify(response.data, null, 2)}`,
        {
          request: {
            url: updateUrl,
            method: 'POST',
            headers,
            payload: JSON.stringify(patchPayload, null, 2),
          },
        },
      );
      throw new Error(`Failed to update creative: ${response.status}`);
    }

    // Fetch updated creative from LinkedIn
    const fetchHeaders = {
      Authorization: `Bearer ${accessToken}`,
      'LinkedIn-Version': '202505',
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-RestLi-Protocol-Version': '2.0.0',
    };
    const fetchUrl = `https://api.linkedin.com/rest/adAccounts/${adAccountId}/creatives/${encodeURIComponent(`urn:li:sponsoredCreative:${creativeId}`)}`;
    this.logger.log(`Fetching updated creative from: ${fetchUrl}`);
    const fetchResponse = await axios.get(fetchUrl, { headers: fetchHeaders });

    if (fetchResponse.status !== 200) {
      this.logger.error(
        `Failed to fetch updated creative: ${fetchResponse.status} - ${JSON.stringify(fetchResponse.data, null, 2)}`,
        {
          request: {
            url: fetchUrl,
            method: 'GET',
            headers: fetchHeaders,
          },
        },
      );
      throw new Error(
        `Failed to fetch updated creative: ${fetchResponse.status}`,
      );
    }

    const fetchedAd = fetchResponse.data as {
      createdAt: string | number | Date;
      lastModifiedAt: string | number | Date;
      createdBy?: string;
      lastModifiedBy?: string;
      name?: string;
      intendedStatus?: string;
      leadgenCallToAction?: { destination: string; label: string };
      [key: string]: any;
    };

    // Prepare ad data for Prisma
    const adData: any = {
      createdAt: new Date(fetchedAd.createdAt),
      lastModifiedAt: new Date(fetchedAd.lastModifiedAt),
    };

    if (fetchedAd.intendedStatus) {
      adData.intendedStatus = fetchedAd.intendedStatus;
    }
    if (fetchedAd.name) {
      adData.name = fetchedAd.name;
    }
    if (fetchedAd.leadgenCallToAction) {
      adData.leadgenCallToAction = {
        destination: fetchedAd.leadgenCallToAction.destination,
        label: fetchedAd.leadgenCallToAction.label,
      };
    } else {
      adData.leadgenCallToAction = null;
    }

    // Upsert ad in Prisma
    await this.prisma.ad.upsert({
      where: {
        campaignId_id: {
          campaignId: campaignId,
          id: creativeId,
        },
      },
      create: {
        id: creativeId,
        campaignId: campaignId,
        adAccountId: adAccountId,
        ...adData,
        changeAuditStamps: {
          create: {
            created: {
              time: adData.createdAt,
              actor: fetchedAd.createdBy || 'SYSTEM',
            },
            lastModified: {
              time: adData.lastModifiedAt,
              actor: fetchedAd.lastModifiedBy || 'SYSTEM',
            },
          },
        },
      },
      update: {
        ...adData,
        changeAuditStamps: {
          update: {
            lastModified: {
              time: adData.lastModifiedAt,
              actor: fetchedAd.lastModifiedBy || 'SYSTEM',
            },
          },
        },
      },
    });

    this.logger.log(
      `Successfully updated and fetched creative ID: ${creativeId}`,
    );
    return {
      success: true,
      message: `Successfully updated and fetched creative ${creativeId} for campaign ${campaignId}`,
      data: adData,
    };
  } catch (error: any) {
    this.logger.error(
      `Error updating creative ${creativeId} for campaign ${campaignId}: ${error.message}`,
      error.response
        ? {
            status: error.response.status,
            data: JSON.stringify(error.response.data, null, 2),
            request: {
              url: error.config?.url,
              method: error.config?.method,
              headers: error.config?.headers,
              payload: error.config?.data
                ? JSON.parse(error.config.data)
                : undefined,
            },
          }
        : undefined,
    );

    if (error.response?.status === 401) {
      throw new UnauthorizedException('Invalid access token');
    }
    if (error.response?.status === 403) {
      throw new ForbiddenException(
        'Missing permissions (rw_ads, w_organization_social)',
      );
    }
    if (error.response?.status === 429) {
      throw new Error('Rate limit exceeded');
    }
    if (error.response?.status === 400 || error.response?.status === 422) {
      const errorDetails =
        error.response.data.errorDetails?.inputErrors || [];
      const errorMessages = errorDetails
        .map((e: any) => e.description)
        .join('; ');
      throw new Error(
        `Invalid request: ${error.response.data.message || 'Validation failed'} - ${errorMessages}`,
      );
    }
    throw new Error(`Failed to update creative: ${error.message}`);
  }
}
}
