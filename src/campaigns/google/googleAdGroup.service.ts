import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GoogleAdGroupRotation,
  GoogleAdGroupStatus,
  Prisma,
} from '@prisma/client';
import { GoogleAdsApi, ResourceNames, enums } from 'google-ads-api';
import { GoogleService } from 'src/auth/google/google.service';
import { PrismaService } from 'src/prisma/prisma.service';
import axios from 'axios';
import { Express } from 'express';

export interface GoogleResponsiveDisplayAdFormData {
  status: 'ENABLED' | 'PAUSED';
  marketing_images: (string | Express.Multer.File)[];
  square_marketing_images: (string | Express.Multer.File)[];
  headlines: { text: string }[];
  long_headline: string;
  descriptions: { text: string }[];
  business_name: string;
  final_urls: string[];
}

interface GeoTarget {
  value: string;
  text: string;
}

interface Language {
  value: string;
  text: string;
}

interface CampaignJson {
  include: GeoTarget[] | Language[];
  exclude: GeoTarget[] | Language[];
}
export interface AdGroupFormData {
  name: string;
  status: GoogleAdGroupStatus;
  ad_rotation_mode: GoogleAdGroupRotation;
  cpc_bid_micros?: number;
  keywords?: { value: string }[]; // Optional for display campaigns
  match_type?: 'EXACT' | 'PHRASE' | 'BROAD'; // Optional for display campaigns
  user_interests?: { value: string }[]; // Optional for display campaigns
}

export interface KeywordSuggestion {
  text: string;
  avgMonthlySearches: number;
  competition: string;
  competitionIndex: number;
  score: number;
}

export interface ResponsiveSearchAdFormData {
  status: GoogleAdGroupStatus;
  headlines: { text: string; pinned_field?: number }[];
  descriptions: { text: string; pinned_field?: number }[];
  final_urls: string[];
}

@Injectable()
export class GoogleAdsService {
  private readonly logger = new Logger(GoogleAdsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly googleService: GoogleService,
    private readonly configService: ConfigService,
  ) {}

  async createAdGroup(
    campaignId: string,
    adGroupData: AdGroupFormData,
  ): Promise<string> {
    this.logger.log(`Creating ad group for campaign ${campaignId}`);

    // Step 1: Fetch campaign details
    const campaign = await this.prisma.googleCampaign.findUnique({
      where: { campaign_id: campaignId },
      select: {
        campaign_id: true,
        customer_account_id: true,
        advertising_channel_type: true,
        bidding_strategy_type: true,
      },
    });
    if (!campaign) {
      this.logger.error(`Campaign with ID ${campaignId} not found`);
      throw new NotFoundException(`Campaign with ID ${campaignId} not found`);
    }

    const customerAccountId = campaign.customer_account_id;
    const channelType = campaign.advertising_channel_type;
    const biddingStrategyType = campaign.bidding_strategy_type;

    // Step 2: Get credentials and platform details
    const creds = await this.googleService.getGoogleCredentials();
    const platform = await this.prisma.marketingPlatform.findFirst({
      where: { orgId: 'single-org', platform_name: 'Google' },
    });
    if (!platform) {
      this.logger.error('Google marketing platform not found');
      throw new InternalServerErrorException(
        'Google marketing platform not found',
      );
    }

    const platformCreds = await this.prisma.platformCredentials.findFirst({
      where: { type: 'AUTH', user_id: null, platform_id: platform.platform_id },
    });
    if (!platformCreds || !platformCreds.refresh_token) {
      this.logger.error('No valid Google platform credentials found');
      throw new ForbiddenException(
        'No valid Google platform credentials found',
      );
    }

    const googleAccount = await this.prisma.googleAccount.findFirst({
      where: { orgId: 'single-org' },
    });
    if (!googleAccount || !googleAccount.mccId) {
      this.logger.error('Google account or MCC ID not found');
      throw new InternalServerErrorException(
        'Google account or MCC ID not found',
      );
    }

    // Get valid access token
    const accessToken = await this.googleService.getValidAccessToken(
      creds.clientId,
      creds.clientSecret,
      platformCreds.refresh_token,
      platform.platform_id,
    );

    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'developer-token': creds.developerToken,
      'login-customer-id': googleAccount.mccId,
      'Content-Type': 'application/json',
    };

    // Step 3: Build ad group payload based on campaign type
    const campaignResourceName = ResourceNames.campaign(
      customerAccountId,
      campaignId,
    );
    const adGroupPayload: any = {
      name: adGroupData.name || `Ad Group ${Date.now()}`,
      campaign: campaignResourceName,
      status: adGroupData.status || 'ENABLED',
      ad_rotation_mode: adGroupData.ad_rotation_mode || 'ROTATE_FOREVER',
    };

    if (channelType === 'SEARCH') {
      // For Search campaigns
      if (biddingStrategyType === 'MANUAL_CPC') {
        adGroupPayload.cpc_bid_micros = adGroupData.cpc_bid_micros || 1000000;
      }
      // Other bidding strategies (e.g., TARGET_CPA, MAXIMIZE_CONVERSIONS) don't require cpc_bid_micros
    } else if (channelType === 'DISPLAY') {
      adGroupPayload.type = 'DISPLAY_STANDARD';
      if (biddingStrategyType === 'MANUAL_CPC') {
        adGroupPayload.cpc_bid_micros = adGroupData.cpc_bid_micros || 1000000;
      }
    } else {
      this.logger.error(`Unsupported campaign channel type: ${channelType}`);
      throw new InternalServerErrorException(
        `Unsupported campaign channel type: ${channelType}`,
      );
    }

    // Step 4: Create ad group via Google Ads API
    const adGroupEndpoint = `https://googleads.googleapis.com/v20/customers/${customerAccountId}/adGroups:mutate`;
    const adGroupOperation = { create: adGroupPayload };

    let adGroupResourceName: string;
    try {
      const response = await axios.post<any>(
        adGroupEndpoint,
        { operations: [adGroupOperation] },
        { headers },
      );
      if (response.status !== 200) {
        throw new Error(
          `Ad group creation failed with status ${response.status}`,
        );
      }
      adGroupResourceName = response.data.results[0].resourceName;
      this.logger.log(`Created ad group: ${adGroupResourceName}`);
    } catch (error: any) {
      this.logger.error(`Ad group creation failed: ${error.message}`, {
        stack: error.stack,
        details: JSON.stringify(error.response?.data || {}),
      });
      throw new InternalServerErrorException('Failed to create ad group');
    }

    // Step 5: Create ad group criteria (keywords) for Search campaigns
    if (
      channelType === 'SEARCH' &&
      adGroupData.keywords &&
      adGroupData.keywords.length > 0
    ) {
      const criteriaEndpoint = `https://googleads.googleapis.com/v20/customers/${customerAccountId}/adGroupCriteria:mutate`;
      const criteriaOperations: any[] = adGroupData.keywords.map((keyword) => ({
        create: {
          ad_group: adGroupResourceName,
          type: enums.CriterionType.KEYWORD,
          keyword: {
            text: keyword.value,
            match_type:
              enums.KeywordMatchType[adGroupData.match_type || 'BROAD'],
          },
        },
      }));

      try {
        const response = await axios.post(
          criteriaEndpoint,
          { operations: criteriaOperations },
          { headers },
        );
        if (response.status !== 200) {
          throw new Error(
            `Keyword criteria creation failed with status ${response.status}`,
          );
        }
        this.logger.log(
          `Created ${criteriaOperations.length} keyword criteria for ad group ${adGroupResourceName}`,
        );
      } catch (error: any) {
        this.logger.error(
          `Keyword criteria creation failed: ${error.message}`,
          {
            stack: error.stack,
            details: JSON.stringify(error.response?.data || {}),
          },
        );
        throw new InternalServerErrorException(
          'Failed to create ad group keyword criteria',
        );
      }
    } else if (
      channelType === 'DISPLAY' &&
      adGroupData.user_interests &&
      adGroupData.user_interests.length > 0
    ) {
      this.logger.log('user interest:', adGroupData.user_interests);
      const criteriaEndpoint = `https://googleads.googleapis.com/v20/customers/${customerAccountId}/adGroupCriteria:mutate`;
      const criteriaOperations: any[] = adGroupData.user_interests.map(
        (interest) => ({
          create: {
            ad_group: adGroupResourceName,
            type: enums.CriterionType.USER_INTEREST,
            user_interest: {
              userInterestCategory: `customers/${customerAccountId}/userInterests/${interest.value}`,
            },
          },
        }),
      );

      try {
        const response = await axios.post(
          criteriaEndpoint,
          { operations: criteriaOperations },
          { headers },
        );
        if (response.status !== 200) {
          throw new Error(
            `User interest criteria creation failed with status ${response.status}`,
          );
        }
        this.logger.log(
          `Created ${criteriaOperations.length} user interest criteria for ad group ${adGroupResourceName}`,
        );
      } catch (error: any) {
        this.logger.error(
          `User interest criteria creation failed: ${error.message}`,
          {
            stack: error.stack,
            details: JSON.stringify(error.response?.data || {}),
          },
        );
        throw new InternalServerErrorException(
          'Failed to create ad group user interest criteria',
        );
      }
    }

    // Step 6: Save ad group to database
    const adGroupId = adGroupResourceName.split('/').pop() ?? '';
    if (!adGroupId) {
      throw new InternalServerErrorException(
        'Failed to extract ad group ID from resource name',
      );
    }

    const adGroupDbData: Prisma.GoogleAdGroupCreateInput = {
      ad_group_id: adGroupId,
      campaign: { connect: { campaign_id: campaignId } },
      name: adGroupData.name,
      status: adGroupData.status || 'PAUSED',
      ad_rotation_mode: adGroupData.ad_rotation_mode || 'ROTATE_FOREVER',
      cpc_bid_micros:
        biddingStrategyType === 'MANUAL_CPC'
          ? adGroupData.cpc_bid_micros || 1000000
          : null,
      targeting_settings: {
        ...(channelType === 'SEARCH' &&
          adGroupData.keywords &&
          adGroupData.keywords.length > 0 && {
            keywords: adGroupData.keywords.map((k) => ({
              text: k.value,
              match_type: adGroupData.match_type || 'BROAD',
            })),
          }),
        ...(channelType === 'DISPLAY' &&
          adGroupData.user_interests &&
          adGroupData.user_interests.length > 0 && {
            user_interests: adGroupData.user_interests.map((interest) => ({
              user_interest_id: interest.value,
            })),
          }),
      },
      data: adGroupPayload,
    };

    try {
      await this.prisma.googleAdGroup.create({
        data: adGroupDbData,
      });
      this.logger.log(`Saved ad group ${adGroupId} to database`);
    } catch (error: any) {
      this.logger.error(`Database save failed: ${error.message}`, {
        stack: error.stack,
        code: error.code,
      });
      throw new InternalServerErrorException(
        'Failed to save ad group to database',
      );
    }

    return adGroupResourceName;
  }

  async getKeywordSuggestions(
    campaignId: string,
    url?: string,
    keywords?: string[],
  ): Promise<KeywordSuggestion[]> {
    this.logger.log(
      `Fetching keyword suggestions for campaign ${campaignId}, `,
      url,
      keywords,
    );

    // Step 1: Fetch campaign details
    const campaign = await this.prisma.googleCampaign.findUnique({
      where: { campaign_id: campaignId },
      select: {
        customer_account_id: true,
        geo_targets: true,
        languages: true,
      },
    });
    if (!campaign) {
      this.logger.error(`Campaign with ID ${campaignId} not found`);
      throw new NotFoundException(`Campaign with ID ${campaignId} not found`);
    }

    const customerAccountId = campaign.customer_account_id;
    const geoTargetsJson = campaign.geo_targets as CampaignJson | null;
    const languagesJson = campaign.languages as CampaignJson | null;
    const geoTargetConstants =
      geoTargetsJson?.include?.map(
        (geo: GeoTarget) => `geoTargetConstants/${geo.value}`,
      ) || [];
    const language =
      languagesJson && languagesJson.include && languagesJson.include.length > 0
        ? `languageConstants/${languagesJson.include[0].value}`
        : 'languageConstants/1000'; // Default to English (1000) if none provided
    // Step 2: Get credentials and platform details
    const creds = await this.googleService.getGoogleCredentials();
    const platform = await this.prisma.marketingPlatform.findFirst({
      where: { orgId: 'single-org', platform_name: 'Google' },
    });
    if (!platform) {
      this.logger.error('Google marketing platform not found');
      throw new InternalServerErrorException(
        'Google marketing platform not found',
      );
    }

    const platformCreds = await this.prisma.platformCredentials.findFirst({
      where: { type: 'AUTH', user_id: null, platform_id: platform.platform_id },
    });
    if (!platformCreds || !platformCreds.refresh_token) {
      this.logger.error('No valid Google platform credentials found');
      throw new ForbiddenException(
        'No valid Google platform credentials found',
      );
    }

    const googleAccount = await this.prisma.googleAccount.findFirst({
      where: { orgId: 'single-org' },
    });
    if (!googleAccount || !googleAccount.mccId) {
      this.logger.error('Google account or MCC ID not found');
      throw new InternalServerErrorException(
        'Google account or MCC ID not found',
      );
    }

    // Get valid access token
    const accessToken = await this.googleService.getValidAccessToken(
      creds.clientId,
      creds.clientSecret,
      platformCreds.refresh_token,
      platform.platform_id,
    );

    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'developer-token': creds.developerToken,
      'login-customer-id': googleAccount.mccId,
      'Content-Type': 'application/json',
    };

    // Step 3: Build payload based on provided parameters
    const payload: any = {
      customer_id: customerAccountId,
      language,
      geoTargetConstants,
      page_size: 1000,
    };

    if (url && keywords && keywords.length > 0) {
      payload.keywordAndUrlSeed = {
        url,
        keywords,
      };
    } else if (keywords && keywords.length > 0) {
      payload.keywordSeed = {
        keywords,
      };
    } else if (url) {
      payload.urlSeed = {
        url,
      };
    } else {
      this.logger.error('At least one of URL or keywords must be provided');
      throw new InternalServerErrorException(
        'At least one of URL or keywords must be provided',
      );
    }

    // Step 4: Call Google Ads API Keyword Planner
    const keywordPlannerEndpoint = `https://googleads.googleapis.com/v20/customers/${customerAccountId}:generateKeywordIdeas`;
    let response;
    try {
      response = await axios.post(keywordPlannerEndpoint, payload, { headers });
      if (response.status !== 200) {
        throw new Error(
          `Keyword suggestions request failed with status ${response.status}`,
        );
      }
      this.logger.log(`Fetched keyword suggestions for campaign ${campaignId}`);
      this.logger.log(
        `Received ${response.data.results.length} keyword suggestions`,
      );
    } catch (error: any) {
      this.logger.error(
        `Keyword suggestions request failed: ${error.message}`,
        {
          stack: error.stack,
          details: JSON.stringify(error.response?.data || {}),
        },
      );
      throw new InternalServerErrorException(
        'Failed to fetch keyword suggestions',
      );
    }

    // Step 5: Process and rank keyword suggestions
    const keywordSuggestions: KeywordSuggestion[] = response.data.results
      .filter((result: any) => result.keywordIdeaMetrics) // Ensure keywordIdeaMetrics exists
      .map((result: any) => {
        const metrics = result.keywordIdeaMetrics;
        const avgMonthlySearches = parseInt(
          metrics.avgMonthlySearches || '0',
          10,
        );
        const competitionIndex = parseInt(metrics.competitionIndex || '0', 10);
        const score = avgMonthlySearches / (competitionIndex + 1);

        return {
          text: result.text,
          avgMonthlySearches,
          competition: metrics.competition || 'UNKNOWN',
          competitionIndex,
          score,
        };
      })
      .sort((a: KeywordSuggestion, b: KeywordSuggestion) => b.score - a.score) // Sort by score descending
      .slice(0, 20); // Take top 20

    this.logger.log('keywords', keywordSuggestions);
    return keywordSuggestions;
  }

  async createResponsiveSearchAd(
    adGroupId: string,
    customerAccountId: string,
    adData: ResponsiveSearchAdFormData,
  ): Promise<string> {
    this.logger.log(`Creating responsive search ad for ad group ${adGroupId}`);
    this.logger.log(`Creating responsive search ad for ad group form:`, adData);

    // Step 1: Validate ad group and campaign details
    const adGroup = await this.prisma.googleAdGroup.findUnique({
      where: { ad_group_id: adGroupId },
      select: {
        ad_group_id: true,
        campaign: {
          select: {
            campaign_id: true,
            customer_account_id: true,
            advertising_channel_type: true,
          },
        },
      },
    });

    if (!adGroup) {
      this.logger.error(`Ad group with ID ${adGroupId} not found`);
      throw new NotFoundException(`Ad group with ID ${adGroupId} not found`);
    }

    if (adGroup.campaign.customer_account_id !== customerAccountId) {
      this.logger.error(
        `Customer account ID ${customerAccountId} does not match ad group's customer account`,
      );
      throw new ForbiddenException(
        'Customer account ID does not match ad group',
      );
    }

    if (adGroup.campaign.advertising_channel_type !== 'SEARCH') {
      this.logger.error(
        `Responsive Search Ads are only supported for SEARCH campaigns, found ${adGroup.campaign.advertising_channel_type}`,
      );
      throw new InternalServerErrorException(
        'Responsive Search Ads are only supported for SEARCH campaigns',
      );
    }

    // Step 2: Get credentials and platform details
    const creds = await this.googleService.getGoogleCredentials();
    const platform = await this.prisma.marketingPlatform.findFirst({
      where: { orgId: 'single-org', platform_name: 'Google' },
    });
    if (!platform) {
      this.logger.error('Google marketing platform not found');
      throw new InternalServerErrorException(
        'Google marketing platform not found',
      );
    }

    const platformCreds = await this.prisma.platformCredentials.findFirst({
      where: { type: 'AUTH', user_id: null, platform_id: platform.platform_id },
    });
    if (!platformCreds || !platformCreds.refresh_token) {
      this.logger.error('No valid Google platform credentials found');
      throw new ForbiddenException(
        'No valid Google platform credentials found',
      );
    }

    const googleAccount = await this.prisma.googleAccount.findFirst({
      where: { orgId: 'single-org' },
    });
    if (!googleAccount || !googleAccount.mccId) {
      this.logger.error('Google account or MCC ID not found');
      throw new InternalServerErrorException(
        'Google account or MCC ID not found',
      );
    }

    const accessToken = await this.googleService.getValidAccessToken(
      creds.clientId,
      creds.clientSecret,
      platformCreds.refresh_token,
      platform.platform_id,
    );

    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'developer-token': creds.developerToken,
      'login-customer-id': googleAccount.mccId,
      'Content-Type': 'application/json',
    };

    // Step 3: Build Responsive Search Ad payload
    const adGroupResourceName = ResourceNames.adGroup(
      customerAccountId,
      adGroupId,
    );

    const adPayload: any = {
      ad_group: adGroupResourceName,
      status: adData.status || 'PAUSED',
      ad: {
        responsive_search_ad: {
          headlines: adData.headlines.map((headline) => ({
            text: headline.text,
            ...(headline.pinned_field && {
              pinned_field: `HEADLINE_${headline.pinned_field}`,
            }),
          })),
          descriptions: adData.descriptions.map((description) => ({
            text: description.text,
            ...(description.pinned_field && {
              pinned_field: `DESCRIPTION_${description.pinned_field}`,
            }),
          })),
        },
        final_urls: adData.final_urls,
      },
    };

    // Step 4: Create ad via Google Ads API
    const adEndpoint = `https://googleads.googleapis.com/v20/customers/${customerAccountId}/adGroupAds:mutate`;
    const adOperation = { create: adPayload };

    let adResourceName: string;
    try {
      const response = await axios.post<any>(
        adEndpoint,
        { operations: [adOperation] },
        { headers },
      );
      if (response.status !== 200) {
        throw new Error(`Ad creation failed with status ${response.status}`);
      }
      adResourceName = response.data.results[0].resourceName;
      this.logger.log(`Created responsive search ad: ${adResourceName}`);
    } catch (error: any) {
      this.logger.error(`Ad creation failed: ${error.message}`, {
        stack: error.stack,
        details: JSON.stringify(error.response?.data || {}),
      });
      throw new InternalServerErrorException(
        'Failed to create responsive search ad',
      );
    }

    // Step 5: Save ad to database
    const adId = adResourceName.split('/').pop() ?? '';
    if (!adId) {
      throw new InternalServerErrorException(
        'Failed to extract ad ID from resource name',
      );
    }

    const adDbData: Prisma.GoogleAdCreateInput = {
      ad_id: adId,
      ad_group: { connect: { ad_group_id: adGroupId } },
      status: adData.status || 'PAUSED',
      ad_content: {
        responsive_search_ad: {
          headlines: adData.headlines.map((h) => ({
            text: h.text,
            pinned_field: h.pinned_field ? `HEADLINE_${h.pinned_field}` : null,
          })),
          descriptions: adData.descriptions.map((d) => ({
            text: d.text,
            pinned_field: d.pinned_field
              ? `DESCRIPTION_${d.pinned_field}`
              : null,
          })),
          final_urls: adData.final_urls,
        },
      },
      data: adPayload,
    };

    try {
      await this.prisma.googleAd.create({
        data: adDbData,
      });
      this.logger.log(`Saved responsive search ad ${adId} to database`);
    } catch (error: any) {
      this.logger.error(`Database save failed: ${error.message}`, {
        stack: error.stack,
        code: error.code,
      });
      throw new InternalServerErrorException(
        'Failed to save responsive search ad to database',
      );
    }

    return adResourceName;
  }

  async searchImageAssets(customerId: string): Promise<{
    message: string;
    squareImages: Array<{
      resource_name: string;
      id: string;
      file_size: number | null;
      height_pixels: number | null;
      width_pixels: number | null;
      url: string | null;
      mime_type: string | null;
    }>;
    marketingImages: Array<{
      resource_name: string;
      id: string;
      file_size: number | null;
      height_pixels: number | null;
      width_pixels: number | null;
      url: string | null;
      mime_type: string | null;
    }>;
  }> {
    this.logger.log(`Searching image assets for customer ID: ${customerId}`);

    // Step 1: Get credentials and platform details
    const creds = await this.googleService.getGoogleCredentials();
    const platform = await this.prisma.marketingPlatform.findFirst({
      where: { orgId: 'single-org', platform_name: 'Google' },
    });
    if (!platform) {
      throw new InternalServerErrorException(
        'Google marketing platform not found',
      );
    }

    const platformCreds = await this.prisma.platformCredentials.findFirst({
      where: { platform_id: platform.platform_id, type: 'AUTH', user_id: null },
    });
    if (!platformCreds || !platformCreds.refresh_token) {
      throw new ForbiddenException(
        'No valid Google platform credentials found',
      );
    }

    const googleAccount = await this.prisma.googleAccount.findFirst({
      where: { orgId: 'single-org' },
    });
    if (!googleAccount) {
      throw new InternalServerErrorException('Google account not found');
    }

    // Step 2: Initialize Google Ads API client
    const client = new GoogleAdsApi({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      developer_token: creds.developerToken,
    });

    const customer = client.Customer({
      customer_id: customerId,
      refresh_token: platformCreds.refresh_token,
      login_customer_id: googleAccount.mccId,
    });

    // Step 3: Query image assets
    try {
      const response = await customer.query(`
      SELECT
        asset.resource_name,
        asset.id,
        asset.name,
        asset.image_asset.file_size,
        asset.image_asset.full_size.height_pixels,
        asset.image_asset.full_size.width_pixels,
        asset.image_asset.full_size.url,
        asset.image_asset.mime_type
      FROM asset
      WHERE asset.type = 'IMAGE'
      LIMIT 20
    `);

      const images: any[] = [];
      for await (const row of response) {
        images.push(row.asset);
      }

      this.logger.log(
        `Fetched ${images.length} image assets for customer ID: ${customerId}`,
      );

      // Step 4: Format and filter images
      const squareImages: Array<{
        resource_name: string;
        id: string;
        name: string;
        file_size: number | null;
        height_pixels: number | null;
        width_pixels: number | null;
        url: string | null;
        mime_type: string | null;
      }> = [];

      const marketingImages: Array<{
        resource_name: string;
        id: string;
        name: string;
        file_size: number | null;
        height_pixels: number | null;
        width_pixels: number | null;
        url: string | null;
        mime_type: string | null;
      }> = [];

      images.forEach((asset) => {
        const formattedImage = {
          resource_name: asset.resource_name || null,
          id: asset.id.toString(),
          name: asset.name,
          file_size: asset.image_asset?.file_size
            ? parseInt(asset.image_asset.file_size, 10)
            : null,
          height_pixels: asset.image_asset?.full_size?.height_pixels || null,
          width_pixels: asset.image_asset?.full_size?.width_pixels || null,
          url: asset.image_asset?.full_size?.url || null,
          mime_type: asset.image_asset?.mime_type || null,
        };

        this.logger.log('images', images);
        // Skip images without valid dimensions
        if (
          formattedImage.height_pixels &&
          formattedImage.width_pixels &&
          formattedImage.height_pixels > 0 &&
          formattedImage.width_pixels > 0
        ) {
          const aspectRatio =
            formattedImage.width_pixels / formattedImage.height_pixels;

          // Check for square images (aspect ratio = 1)
          if (aspectRatio === 1) {
            squareImages.push(formattedImage);
          }
          // Check for marketing images (aspect ratio ≈ 1.91, within 0.1 tolerance)
          else if (Math.abs(aspectRatio - 1.91) < 0.1) {
            marketingImages.push(formattedImage);
          }
        }
      });

      this.logger.log(
        `Filtered ${squareImages.length} square images and ${marketingImages.length} marketing images for customer ID: ${customerId}`,
      );

      return {
        message: 'Image assets retrieved and filtered successfully',
        squareImages,
        marketingImages,
      };
    } catch (error: any) {
      this.logger.error(
        `Failed to search image assets for customer ${customerId}: ${JSON.stringify(error, null, 2)}`,
        error.stack || 'No stack trace available',
      );
      if (error.response?.status === 401) {
        throw new UnauthorizedException('Invalid or expired access token');
      }
      if (error.response?.status === 403) {
        throw new ForbiddenException('Missing required scopes (adwords)');
      }
      if (error.response?.status === 429) {
        throw new Error('Rate limit exceeded');
      }
      throw new InternalServerErrorException(
        `Failed to search image assets: ${error.message || 'Unknown error'}`,
      );
    }
  }

  async uploadImageAsset(
    customerId: string,
    file: Express.Multer.File,
    assetName: string,
  ): Promise<string> {
    this.logger.log(
      `Uploading image asset for customer ID: ${customerId}, file: ${file.originalname}`,
    );

    // Step 1: Get credentials and platform details
    const creds = await this.googleService.getGoogleCredentials();
    const platform = await this.prisma.marketingPlatform.findFirst({
      where: { orgId: 'single-org', platform_name: 'Google' },
    });
    if (!platform) {
      this.logger.error('Google marketing platform not found');
      throw new InternalServerErrorException(
        'Google marketing platform not found',
      );
    }

    const platformCreds = await this.prisma.platformCredentials.findFirst({
      where: { platform_id: platform.platform_id, type: 'AUTH', user_id: null },
    });
    if (!platformCreds || !platformCreds.refresh_token) {
      this.logger.error('No valid Google platform credentials found');
      throw new ForbiddenException(
        'No valid Google platform credentials found',
      );
    }

    const googleAccount = await this.prisma.googleAccount.findFirst({
      where: { orgId: 'single-org' },
    });
    if (!googleAccount || !googleAccount.mccId) {
      this.logger.error('Google account or MCC ID not found');
      throw new InternalServerErrorException(
        'Google account or MCC ID not found',
      );
    }

    const accessToken = await this.googleService.getValidAccessToken(
      creds.clientId,
      creds.clientSecret,
      platformCreds.refresh_token,
      platform.platform_id,
    );

    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'developer-token': creds.developerToken,
      'login-customer-id': googleAccount.mccId,
      'Content-Type': 'application/json',
    };
    const mimeMap = {
      'image/jpeg': 'IMAGE_JPEG',
      'image/jpg': 'IMAGE_JPEG',
      'image/png': 'IMAGE_PNG',
    };
    // Step 2: Convert file buffer to base64
    const base64Image = file.buffer.toString('base64');

    // Step 3: Build asset payload
    const assetPayload = {
      type: 'IMAGE',
      image_asset: {
        data: base64Image,
        file_size: file.size,
        mime_type: mimeMap[file.mimetype] || 'IMAGE_JPEG',
        full_size: {
          height_pixels: null,
          width_pixels: null,
          url: null,
        },
      },
      name: assetName || file.originalname,
    };

    // Step 4: Create asset via Google Ads API
    const assetEndpoint = `https://googleads.googleapis.com/v20/customers/${customerId}/assets:mutate`;
    const assetOperation = { create: assetPayload };

    try {
      const response = await axios.post<any>(
        assetEndpoint,
        { operations: [assetOperation] },
        { headers },
      );
      if (response.status !== 200) {
        throw new Error(`Asset creation failed with status ${response.status}`);
      }
      const assetResourceName = response.data.results[0].resourceName;
      this.logger.log(`Created image asset: ${assetResourceName}`);
      return assetResourceName;
    } catch (error: any) {
      this.logger.error(`Image asset creation failed: ${error.message}`, {
        stack: error.stack,
        details: JSON.stringify(error.response?.data || {}),
      });
      throw new InternalServerErrorException('Failed to create image asset');
    }
  }

  async createResponsiveDisplayAd(
    adGroupId: string,
    customerAccountId: string,
    adData: GoogleResponsiveDisplayAdFormData,
  ): Promise<string> {
    this.logger.log(`Creating responsive display ad for ad group ${adGroupId}`);

    // Step 1: Validate ad group and campaign details
    const adGroup = await this.prisma.googleAdGroup.findUnique({
      where: { ad_group_id: adGroupId },
      select: {
        ad_group_id: true,
        campaign: {
          select: {
            campaign_id: true,
            customer_account_id: true,
            advertising_channel_type: true,
          },
        },
      },
    });

    if (!adGroup) {
      this.logger.error(`Ad group with ID ${adGroupId} not found`);
      throw new NotFoundException(`Ad group with ID ${adGroupId} not found`);
    }

    if (adGroup.campaign.customer_account_id !== customerAccountId) {
      this.logger.error(
        `Customer account ID ${customerAccountId} does not match ad group's customer account`,
      );
      throw new ForbiddenException(
        'Customer account ID does not match ad group',
      );
    }

    if (adGroup.campaign.advertising_channel_type !== 'DISPLAY') {
      this.logger.error(
        `Responsive Display Ads are only supported for DISPLAY campaigns, found ${adGroup.campaign.advertising_channel_type}`,
      );
      throw new InternalServerErrorException(
        'Responsive Display Ads are only supported for DISPLAY campaigns',
      );
    }

    // Step 2: Get credentials and platform details
    const creds = await this.googleService.getGoogleCredentials();
    const platform = await this.prisma.marketingPlatform.findFirst({
      where: { orgId: 'single-org', platform_name: 'Google' },
    });
    if (!platform) {
      this.logger.error('Google marketing platform not found');
      throw new InternalServerErrorException(
        'Google marketing platform not found',
      );
    }

    const platformCreds = await this.prisma.platformCredentials.findFirst({
      where: { platform_id: platform.platform_id, type: 'AUTH', user_id: null },
    });
    if (!platformCreds || !platformCreds.refresh_token) {
      this.logger.error('No valid Google platform credentials found');
      throw new ForbiddenException(
        'No valid Google platform credentials found',
      );
    }

    const googleAccount = await this.prisma.googleAccount.findFirst({
      where: { orgId: 'single-org' },
    });
    if (!googleAccount || !googleAccount.mccId) {
      this.logger.error('Google account or MCC ID not found');
      throw new InternalServerErrorException(
        'Google account or MCC ID not found',
      );
    }

    const accessToken = await this.googleService.getValidAccessToken(
      creds.clientId,
      creds.clientSecret,
      platformCreds.refresh_token,
      platform.platform_id,
    );

    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'developer-token': creds.developerToken,
      'login-customer-id': googleAccount.mccId,
      'Content-Type': 'application/json',
    };

    // Step 3: Process images (upload File objects, keep resource_name strings)
    const marketingImageResourceNames: string[] = [];
    for (const image of adData.marketing_images) {
      if (typeof image === 'string') {
        marketingImageResourceNames.push(image);
      } else if ('originalname' in image && 'buffer' in image && image.originalname && image.buffer) {
        this.logger.debug('Marketing image:', {
          originalname: image.originalname,
          size: image.size,
          mimetype: image.mimetype,
        });
        const assetResourceName = await this.uploadImageAsset(
          customerAccountId,
          image,
          `Marketing Image ${Date.now()}`,
        );
        marketingImageResourceNames.push(assetResourceName);
      } else {
        this.logger.warn('Invalid marketing image input:', image);
        throw new BadRequestException('Invalid marketing image format: missing originalname or buffer');
      }
    }

    const squareImageResourceNames: string[] = [];
    for (const image of adData.square_marketing_images) {
      if (typeof image === 'string') {
        squareImageResourceNames.push(image);
      } else if ('originalname' in image && 'buffer' in image && image.originalname && image.buffer) {
        this.logger.debug('Square image:', {
          originalname: image.originalname,
          size: image.size,
          mimetype: image.mimetype,
        });
        const assetResourceName = await this.uploadImageAsset(
          customerAccountId,
          image,
          `Square Image ${Date.now()}`,
        );
        squareImageResourceNames.push(assetResourceName);
      } else {
        this.logger.warn('Invalid square marketing image input:', image);
        throw new BadRequestException('Invalid square marketing image format: missing originalname or buffer');
      }
    }
    // Step 4: Build Responsive Display Ad payload
    const adGroupResourceName = ResourceNames.adGroup(
      customerAccountId,
      adGroupId,
    );

    const adPayload: any = {
      ad_group: adGroupResourceName,
      status: adData.status || 'PAUSED',
      ad: {
        responsive_display_ad: {
          marketing_images: marketingImageResourceNames.map((resourceName) => ({
            asset: resourceName,
          })),
          square_marketing_images: squareImageResourceNames.map(
            (resourceName) => ({
              asset: resourceName,
            }),
          ),
          headlines: adData.headlines.map((headline) => ({
            text: headline.text,
          })),
          long_headline: {
            text: adData.long_headline,
          },
          descriptions: adData.descriptions.map((description) => ({
            text: description.text,
          })),
          business_name: adData.business_name,
        },
        final_urls: adData.final_urls,
      },
      
    };

    // Step 5: Create ad via Google Ads API
    const adEndpoint = `https://googleads.googleapis.com/v20/customers/${customerAccountId}/adGroupAds:mutate`;
    const adOperation = { create: adPayload };

    let adResourceName: string;
    try {
      const response = await axios.post<any>(
        adEndpoint,
        { operations: [adOperation] },
        { headers },
      );
      if (response.status !== 200) {
        throw new Error(`Ad creation failed with status ${response.status}`);
      }
      adResourceName = response.data.results[0].resourceName;
      this.logger.log(`Created responsive display ad: ${adResourceName}`);
    } catch (error: any) {
      this.logger.error(`Ad creation failed: ${error.message}`, {
        stack: error.stack,
        details: JSON.stringify(error.response?.data || {}),
      });
      throw new InternalServerErrorException(
        'Failed to create responsive display ad',
      );
    }

    // Step 6: Save ad to database
    const adId = adResourceName.split('/').pop() ?? '';
    if (!adId) {
      throw new InternalServerErrorException(
        'Failed to extract ad ID from resource name',
      );
    }

    const adDbData: Prisma.GoogleAdCreateInput = {
      ad_id: adId,
      ad_group: { connect: { ad_group_id: adGroupId } },
      status: adData.status || 'PAUSED',
      ad_content: {
        responsive_display_ad: {
          marketing_images: marketingImageResourceNames.map((resourceName) => ({
            asset: resourceName,
          })),
          square_marketing_images: squareImageResourceNames.map(
            (resourceName) => ({
              asset: resourceName,
            }),
          ),
          headlines: adData.headlines.map((headline) => ({
            text: headline.text,
          })),
          long_headline: {
            text: adData.long_headline,
          },
          descriptions: adData.descriptions.map((description) => ({
            text: description.text,
          })),
          business_name: adData.business_name,
          final_urls: adData.final_urls,
        },
      },
      data: adPayload,
    };

    try {
      await this.prisma.googleAd.create({
        data: adDbData,
      });
      this.logger.log(`Saved responsive display ad ${adId} to database`);
    } catch (error: any) {
      this.logger.error(`Database save failed: ${error.message}`, {
        stack: error.stack,
        code: error.code,
      });
      throw new InternalServerErrorException(
        'Failed to save responsive display ad to database',
      );
    }

    return adResourceName;
  }


async getImageAssetDetails(assetResourceName: string): Promise<{
  name: string | null;
  url: string | null;
}> {
  this.logger.log(`Fetching image asset details for ${assetResourceName}`);

  // Extract customer ID from resource name
  const customerIdMatch = assetResourceName.match(/^customers\/(\d+)\/assets\/\d+$/);
  if (!customerIdMatch) {
    this.logger.error(`Invalid asset resource name: ${assetResourceName}`);
    throw new BadRequestException('Invalid asset resource name');
  }
  const customerId = customerIdMatch[1];

  // Get credentials and platform details
  const creds = await this.googleService.getGoogleCredentials();
  const platform = await this.prisma.marketingPlatform.findFirst({
    where: { orgId: 'single-org', platform_name: 'Google' },
  });
  if (!platform) {
    this.logger.error('Google marketing platform not found');
    throw new InternalServerErrorException('Google marketing platform not found');
  }

  const platformCreds = await this.prisma.platformCredentials.findFirst({
    where: { platform_id: platform.platform_id, type: 'AUTH', user_id: null },
  });
  if (!platformCreds || !platformCreds.refresh_token) {
    this.logger.error('No valid Google platform credentials found');
    throw new ForbiddenException('No valid Google platform credentials found');
  }

  const googleAccount = await this.prisma.googleAccount.findFirst({
    where: { orgId: 'single-org' },
  });
  if (!googleAccount || !googleAccount.mccId) {
    this.logger.error('Google account or MCC ID not found');
    throw new InternalServerErrorException('Google account or MCC ID not found');
  }

  // Initialize Google Ads API client
  const client = new GoogleAdsApi({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    developer_token: creds.developerToken,
  });

  const customer = client.Customer({
    customer_id: customerId,
    refresh_token: platformCreds.refresh_token,
    login_customer_id: googleAccount.mccId,
  });

  // Define interface for asset response
  interface AssetResponse {
    name?: string | null;
    image_asset?: {
      full_size?: {
        url?: string | null;
      } | null;
    } | null;
  }

  // Query asset details
  try {
    const response = await customer.query(`
      SELECT asset.name, asset.image_asset.full_size.url
      FROM asset
      WHERE asset.resource_name = '${assetResourceName}'
      AND asset.type = 'IMAGE'
    `);

    const results: AssetResponse[] = [];
    for await (const row of response) {
      results.push(row.asset as AssetResponse);
    }

    if (results.length === 0) {
      this.logger.error(`No image asset found for ${assetResourceName}`);
      throw new NotFoundException(`Image asset not found for ${assetResourceName}`);
    }

    const asset = results[0];
    this.logger.log(`Fetched image asset details for ${assetResourceName}`);
    return {
      name: asset.name || null,
      url: asset.image_asset?.full_size?.url || null,
    };
  } catch (error: any) {
    this.logger.error(`Failed to fetch image asset details: ${error.message}`, {
      stack: error.stack,
      details: JSON.stringify(error.response?.data || {}),
    });
    if (error.response?.status === 401) {
      throw new UnauthorizedException('Invalid or expired access token');
    }
    if (error.response?.status === 403) {
      throw new ForbiddenException('Missing required scopes (adwords)');
    }
    if (error.response?.status === 429) {
      throw new Error('Rate limit exceeded');
    }
    throw new InternalServerErrorException('Failed to fetch image asset details');
  }
}
}
