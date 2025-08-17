import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Param,
  ParseArrayPipe,
  Patch,
  Post,
  Query,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  GoogleAdsFormData,
  GoogleCampaignsService,
} from './googleCampaign.service';
import { JwtAuthGuard } from 'src/guards/jwt-auth.guard';
import { GoogleCampaignBudgetService } from './googleCampaignBudget.service';
import {
  AdGroupFormData,
  GoogleAdsService,
  GoogleResponsiveDisplayAdFormData,
  ResponsiveSearchAdFormData,
} from './googleAdGroup.service';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { GoogleAdsAIService } from './googleAd.service';

@Controller('campaigns/google')
export class GoogleCampaignController {
  private readonly logger = new Logger(GoogleCampaignController.name);

  constructor(
    private readonly googleCampaignsService: GoogleCampaignsService,
    private readonly googleCampaignBudgetService: GoogleCampaignBudgetService,
    private readonly googleAdsService: GoogleAdsService,
        private readonly googleAdsAIService: GoogleAdsAIService,

  ) {}

  @Get('/list')
  @UseGuards(JwtAuthGuard)
  async listGoogleCampaigns(
    @Query('search') search?: string,
        @Query('status', new ParseArrayPipe({ items: String, optional: true, separator: ',' })) status?: string[],
        @Query('advertisingChannelType', new ParseArrayPipe({ items: String, optional: true, separator: ',' })) advertisingChannelType?: string[],
        @Query('startDateFrom') startDateFrom?: string,
        @Query('startDateTo') startDateTo?: string,
        @Query('endDateFrom') endDateFrom?: string,
        @Query('endDateTo') endDateTo?: string,
        @Query('page') page?: number,
        @Query('limit') limit?: number,
        @Query('sortBy') sortBy?: string,
        @Query('sortOrder') sortOrder?: 'asc' | 'desc',
  ) {
    return this.googleCampaignsService.listCampaignsWithAdGroupsAndAds({
      search,
      status: status && status.length > 0 ? status : undefined,
      advertisingChannelType: advertisingChannelType && advertisingChannelType.length > 0 ? advertisingChannelType : undefined,
      startDateFrom: startDateFrom ? new Date(startDateFrom) : undefined,
      startDateTo: startDateTo ? new Date(startDateTo) : undefined,
      endDateFrom: endDateFrom ? new Date(endDateFrom) : undefined,
      endDateTo: endDateTo ? new Date(endDateTo) : undefined,
      page,
      limit,
      sortBy,
      sortOrder,
    });
  }

  @Get('/list/:campaignId')
  @UseGuards(JwtAuthGuard)
  async getGoogleCampaignById(@Param('campaignId') campaignId: string) {
    return this.googleCampaignsService.getCampaignById(campaignId);
  }

  @Get('/budgets/:googleAccountId/:customerId')
  @UseGuards(JwtAuthGuard)
  async listCampaignBudgets(
    @Param('googleAccountId') googleAccountId: string,
    @Param('customerId') customerId: string,
  ) {
    return this.googleCampaignBudgetService.fetchCampaignBudgets(
      googleAccountId,
      customerId,
    );
  }
  @Get('/geo-targets/:customerId')
  @UseGuards(JwtAuthGuard)
  async searchGeoTargetConstants(
    @Param('customerId') customerId: string,
    @Query('query') query: string,
  ) {
    if (!query) {
      throw new InternalServerErrorException('Query parameter is required');
    }
    return this.googleCampaignBudgetService.searchGeoTargetConstants(
      customerId,
      query,
    );
  }

  @Get('/languages/:customerId')
  @UseGuards(JwtAuthGuard)
  async searchLanguageConstants(
    @Param('customerId') customerId: string,
    @Query('query') query: string,
  ) {
    if (!query) {
      throw new InternalServerErrorException('Query parameter is required');
    }
    console.log('query in controller', query);
    return this.googleCampaignBudgetService.searchLanguageConstants(
      customerId,
      query,
    );
  }

  @Get('/user-interests/:customerId')
  @UseGuards(JwtAuthGuard)
  async searchUserInterests(
    @Param('customerId') customerId: string,
    @Query('query') query: string,
  ) {
    if (!query) {
      throw new InternalServerErrorException('Query parameter is required');
    }
    return this.googleCampaignBudgetService.searchUserInterests(
      customerId,
      query,
    );
  }

  @Post('/create')
  @UseGuards(JwtAuthGuard)
  async createGoogleCampaign(@Body() formData: GoogleAdsFormData) {
    try {
      const campaignResourceName =
        await this.googleCampaignsService.createCampaignWithBudget(
          formData,
          'single-org',
        );
      return { success: true, campaignResourceName };
    } catch (error: any) {
      throw new InternalServerErrorException(
        `Failed to create campaign: ${error.message || 'Unknown error'}`,
      );
    }
  }

  @Patch('/update/:campaignId')
  @UseGuards(JwtAuthGuard)
  async updateGoogleCampaign(
    @Param('campaignId') campaignId: string,
    @Body() formData: Partial<GoogleAdsFormData>,
  ) {
    try {
      const campaignResourceName =
        await this.googleCampaignsService.updateCampaign(
          campaignId,
          formData.customerAccountId ?? '',
          formData,
          'single-org',
        );
      return { success: true, campaignResourceName };
    } catch (error: any) {
      throw new InternalServerErrorException(
        `Failed to update campaign: ${error.message || 'Unknown error'}`,
      );
    }
  }

  @Delete('/delete/:campaignId')
  @UseGuards(JwtAuthGuard)
  async deleteGoogleCampaign(@Param('campaignId') campaignId: string) {
    try {
      await this.googleCampaignsService.deleteCampaign(campaignId);
      return {
        success: true,
        message: `Campaign ${campaignId} deleted successfully`,
      };
    } catch (error: any) {
      throw new InternalServerErrorException(
        `Failed to delete campaign: ${error.message || 'Unknown error'}`,
      );
    }
  }

  @Post('/ad-groups/create')
  @UseGuards(JwtAuthGuard)
  async createGoogleAdGroup(
    @Body() formData: AdGroupFormData,
    @Query('campaignId') campaignId: string,
  ) {
    try {
      const adGroupResourceName = await this.googleAdsService.createAdGroup(
        campaignId,
        formData,
      );
      return { success: true, adGroupResourceName };
    } catch (error: any) {
      throw new InternalServerErrorException(
        `Failed to create ad group: ${error.message || 'Unknown error'}`,
      );
    }
  }

  @Get('/ad-groups/keyword-suggestions/:campaignId')
  @UseGuards(JwtAuthGuard)
  async getKeywordSuggestions(
    @Param('campaignId') campaignId: string,
    @Query('url') url?: string,
    @Query('keywords') keywords?: string, // Comma-separated string
  ) {
    try {
      const keywordArray = keywords
        ? keywords.split(',').map((k) => k.trim())
        : undefined;
      const suggestions = await this.googleAdsService.getKeywordSuggestions(
        campaignId,
        url,
        keywordArray,
      );
      return { success: true, suggestions };
    } catch (error: any) {
      throw new InternalServerErrorException(
        `Failed to fetch keyword suggestions: ${error.message || 'Unknown error'}`,
      );
    }
  }

  @Post('/ad-groups/responsive-search-ad/create')
  @UseGuards(JwtAuthGuard)
  async createResponsiveSearchAd(
    @Body() formData: ResponsiveSearchAdFormData,
    @Query('adGroupId') adGroupId: string,
    @Query('customerAccountId') customerAccountId: string,
  ) {
    try {
      const adResourceName =
        await this.googleAdsService.createResponsiveSearchAd(
          adGroupId,
          customerAccountId,
          formData,
        );
      return { success: true, adResourceName };
    } catch (error: any) {
      throw new InternalServerErrorException(
        `Failed to create responsive search ad: ${error.message || 'Unknown error'}`,
      );
    }
  }

  @Get('/image-assets/:customerId')
  @UseGuards(JwtAuthGuard)
  async searchImageAssets(@Param('customerId') customerId: string) {
    try {
      return await this.googleAdsService.searchImageAssets(customerId);
    } catch (error: any) {
      throw new InternalServerErrorException(
        `Failed to fetch image assets: ${error.message || 'Unknown error'}`,
      );
    }
  }

  @Post('/ad-groups/responsive-display-ad/create')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(
    AnyFilesInterceptor({
      storage: memoryStorage(),
      limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
    }),
  )
  async createResponsiveDisplayAd(
    @Body() formData: GoogleResponsiveDisplayAdFormData,
    @Query('adGroupId') adGroupId: string,
    @Query('customerAccountId') customerAccountId: string,
    @UploadedFiles() files: Express.Multer.File[],
  ) {
    try {
      this.logger.debug(
        'Received files:',
        files.map((f) => ({
          fieldname: f.fieldname,
          originalname: f.originalname,
          size: f.size,
        })),
      );

      const parsedFormData: GoogleResponsiveDisplayAdFormData = {
        ...formData,
        headlines:
          typeof formData.headlines === 'string'
            ? JSON.parse(formData.headlines)
            : formData.headlines,
        descriptions:
          typeof formData.descriptions === 'string'
            ? JSON.parse(formData.descriptions)
            : formData.descriptions,
        final_urls:
          typeof formData.final_urls === 'string'
            ? JSON.parse(formData.final_urls)
            : formData.final_urls,
        marketing_images: [],
        square_marketing_images: [],
      };

      files.forEach((file) => {
        if (file.fieldname.startsWith('marketing_images')) {
          parsedFormData.marketing_images.push(file);
        } else if (file.fieldname.startsWith('square_marketing_images')) {
          parsedFormData.square_marketing_images.push(file);
        }
      });

      if (typeof formData.marketing_images === 'string') {
        parsedFormData.marketing_images.push(
          ...JSON.parse(formData.marketing_images),
        );
      } else if (Array.isArray(formData.marketing_images)) {
        parsedFormData.marketing_images.push(
          ...formData.marketing_images.filter(
            (item): item is string => typeof item === 'string',
          ),
        );
      }

      if (typeof formData.square_marketing_images === 'string') {
        parsedFormData.square_marketing_images.push(
          ...JSON.parse(formData.square_marketing_images),
        );
      } else if (Array.isArray(formData.square_marketing_images)) {
        parsedFormData.square_marketing_images.push(
          ...formData.square_marketing_images.filter(
            (item): item is string => typeof item === 'string',
          ),
        );
      }

      this.logger.debug('Parsed formData:', parsedFormData);

      const adResourceName =
        await this.googleAdsService.createResponsiveDisplayAd(
          adGroupId,
          customerAccountId,
          parsedFormData,
        );
      return { success: true, adResourceName };
    } catch (error: any) {
      throw new InternalServerErrorException(
        `Failed to create responsive display ad: ${error.message || 'Unknown error'}`,
      );
    }
  }

  @Post('/config')
  @UseGuards(JwtAuthGuard)
  async createOrUpdateGoogleCampaignConfig(
    @Body()
    config: {
      syncInterval: string;
      autoSyncEnabled: boolean;
      googleAccountsIds: string[];
    },
    @Query('orgId') orgId: string = 'single-org',
  ) {
    try {
      const configRecord =
        await this.googleCampaignsService.createOrUpdateGoogleCampaignConfig(
          orgId,
          config,
        );
      return { success: true, config: configRecord };
    } catch (error: any) {
      this.logger.error(
        `Failed to create/update GoogleCampaignConfig: ${error.message}`,
      );
      throw new InternalServerErrorException(
        `Failed to create/update Google campaign configuration: ${error.message || 'Unknown error'}`,
      );
    }
  }

  @Get('/config/:orgId')
  @UseGuards(JwtAuthGuard)
  async getGoogleCampaignConfigByOrgId(
    @Param('orgId') orgId: string = 'single-org',
  ) {
    try {
      const configRecord =
        await this.googleCampaignsService.getGoogleCampaignConfigByOrgId(orgId);
      return { success: true, config: configRecord };
    } catch (error: any) {
      this.logger.error(
        `Failed to fetch GoogleCampaignConfig: ${error.message}`,
      );

      throw new InternalServerErrorException(
        `Failed to fetch Google campaign configuration: ${error.message || 'Unknown error'}`,
      );
    }
  }

  @Get('/image-asset/:assetResourceName')
  @UseGuards(JwtAuthGuard)
  async getImageAssetDetails(
    @Param('assetResourceName') assetResourceName: string,
  ) {
    try {
      const assetDetails =
        await this.googleAdsService.getImageAssetDetails(assetResourceName);
      return { success: true, assetDetails };
    } catch (error: any) {
      this.logger.error(
        `Failed to fetch image asset details: ${error.message}`,
      );
      throw new InternalServerErrorException(
        `Failed to fetch image asset details: ${error.message || 'Unknown error'}`,
      );
    }
  }


  @Get('/headlines/:campaignId')
  @UseGuards(JwtAuthGuard)
  async generateHeadlines(
    @Param('campaignId') campaignId: string,
    @Query('count') count: string = '5',
    @Query('keywords') keywords?: string,
    @Query('businessDescription') businessDescription?: string,
    @Query('campaignType') campaignType?: 'SEARCH' | 'DISPLAY',
  ) {
    try {
      const countNum = parseInt(count, 10);
      if (isNaN(countNum) || countNum <= 0 || countNum > 15) {
        throw new BadRequestException('Count must be a number between 1 and 15');
      }

      const keywordArray = keywords
        ? keywords.split(',').map((k) => k.trim())
        : undefined;

      const headlines = await this.googleAdsAIService.generateHeadlines(
        campaignId,
        countNum,
        {
          keywords: keywordArray,
          businessDescription,
          campaignType,
        },
      );
      return { success: true, headlines };
    } catch (error: any) {
      this.logger.error(`Failed to generate headlines: ${error.message}`);
      throw new InternalServerErrorException(
        `Failed to generate headlines: ${error.message || 'Unknown error'}`,
      );
    }
  }

  @Get('/descriptions/:campaignId')
  @UseGuards(JwtAuthGuard)
  async generateDescriptions(
    @Param('campaignId') campaignId: string,
    @Query('count') count: string = '5',
    @Query('keywords') keywords?: string,
    @Query('businessDescription') businessDescription?: string,
    @Query('campaignType') campaignType?: 'SEARCH' | 'DISPLAY',
  ) {
    try {
      const countNum = parseInt(count, 10);
      if (isNaN(countNum) || countNum <= 0 || countNum > 10) {
        throw new BadRequestException('Count must be a number between 1 and 10');
      }

      const keywordArray = keywords
        ? keywords.split(',').map((k) => k.trim())
        : undefined;

      const descriptions = await this.googleAdsAIService.generateDescriptions(
        campaignId,
        countNum,
        {
          keywords: keywordArray,
          businessDescription,
          campaignType,
        },
      );
      return { success: true, descriptions };
    } catch (error: any) {
      this.logger.error(`Failed to generate descriptions: ${error.message}`);
      throw new InternalServerErrorException(
        `Failed to generate descriptions: ${error.message || 'Unknown error'}`,
      );
    }
  }
}
