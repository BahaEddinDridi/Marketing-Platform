import {
  Controller,
  Get,
  Param,
  Logger,
  HttpException,
  Query,
  UseGuards,
  Post,
  Body,
  UseInterceptors,
  HttpStatus,
  Req,
  UploadedFile,
  UploadedFiles,
  Patch,
} from '@nestjs/common';
import { LinkedInAdsService } from './linkedinAds.service';
import { JwtAuthGuard } from 'src/guards/jwt-auth.guard';
import {
  AnyFilesInterceptor,
  FileInterceptor,
  FilesInterceptor,
} from '@nestjs/platform-express';
import { diskStorage, memoryStorage } from 'multer';

@Controller('linkedin-ads')
export class LinkedInAdsController {
  private readonly logger = new Logger(LinkedInAdsController.name);

  constructor(private readonly linkedInAdsService: LinkedInAdsService) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(
    AnyFilesInterceptor({
      storage: memoryStorage(),
      limits: { files: 10 }, // Max 10 files (for CAROUSEL)
    }),
  )
  async createCampaignAd(
    @Req() request: Request,
    @Body() body: { campaignId: string; adFormat: string; adInputs: string },
    @UploadedFiles() files?: Express.Multer.File[],
  ) {
    try {
      let adInputs: any;
      try {
        adInputs = JSON.parse(body.adInputs || '{}');
      } catch (e) {
        this.logger.error(`Invalid adInputs JSON: ${e.message}`);
        throw new HttpException(
          'Invalid adInputs JSON',
          HttpStatus.BAD_REQUEST,
        );
      }

      switch (body.adFormat) {
        case 'TEXT_AD':
          // Validate TEXT_AD inputs
          if (!adInputs.headline || !adInputs.description || !adInputs.landingPage) {
            this.logger.error('TEXT_AD requires headline, description, and landingPage');
            throw new HttpException(
              'TEXT_AD requires headline, description, and landingPage',
              HttpStatus.BAD_REQUEST,
            );
          }
          // Attach optional image
          if (files?.length === 1 && files[0].fieldname === 'image') {
            adInputs.image = files[0].buffer;
          } else if (files && files.length > 1) {
            this.logger.error('TEXT_AD accepts only one image');
            throw new HttpException('TEXT_AD accepts only one image', HttpStatus.BAD_REQUEST);
          }
          break;

        case 'CAROUSEL':
        if (
          !adInputs.cards ||
          !Array.isArray(adInputs.cards) ||
          adInputs.cards.length < 2 ||
          adInputs.cards.length > 10
        ) {
          this.logger.error('Carousel must have 2–10 cards');
          throw new HttpException('Carousel must have 2–10 cards', HttpStatus.BAD_REQUEST);
        }
        let imageFileIndex = 0;
        adInputs.cards = adInputs.cards.map((card: any, index: number) => {
          if (card.imageUrn) {
            if (card.image) {
              this.logger.error(`Carousel card ${index} cannot have both image and imageUrn`);
              throw new HttpException(
                `Carousel card ${index} cannot have both image and imageUrn`,
                HttpStatus.BAD_REQUEST,
              );
            }
            return { ...card, image: undefined };
          } else {
            const imageFile = files?.[imageFileIndex];
            if (!imageFile || imageFile.fieldname !== 'cardImages[]') {
              this.logger.error(`Carousel card ${index} requires an image file`);
              throw new HttpException(
                `Carousel card ${index} requires an image file`,
                HttpStatus.BAD_REQUEST,
              );
            }
            imageFileIndex++;
            return { ...card, image: imageFile.buffer };
          }
        });
        if (imageFileIndex !== (files?.filter(f => f.fieldname === 'cardImages[]').length || 0)) {
          this.logger.error('Number of uploaded images does not match number of cards requiring images');
          throw new HttpException(
            'Number of uploaded images does not match number of cards requiring images',
            HttpStatus.BAD_REQUEST,
          );
        }
        break;

        case 'STANDARD_UPDATE':

          if (files?.length === 1 && files[0].fieldname === 'image' && !adInputs.imageUrn) {
          adInputs.image = files[0].buffer;
        } else if (!adInputs.imageUrn && (!files || files.length !== 1 || files[0].fieldname !== 'image')) {
          this.logger.error('STANDARD_UPDATE requires either one image with fieldname "image" or an imageUrn');
          throw new HttpException(
            'STANDARD_UPDATE requires either one image with fieldname "image" or an imageUrn',
            HttpStatus.BAD_REQUEST,
          );
        } else if (adInputs.imageUrn && files?.length) {
          this.logger.error('STANDARD_UPDATE cannot have both imageUrn and uploaded image');
          throw new HttpException(
            'STANDARD_UPDATE cannot have both imageUrn and uploaded image',
            HttpStatus.BAD_REQUEST,
          );
        }
          
          break;

        case 'SINGLE_VIDEO':
        const videoFile = files?.find(f => f.fieldname === 'video');
        const thumbnailFile = files?.find(f => f.fieldname === 'thumbnail');
        if (videoFile && !adInputs.videoUrn) {
          adInputs.video = videoFile.buffer;
          if (thumbnailFile) {
            adInputs.thumbnail = thumbnailFile.buffer;
          }
          if (
            (files?.length ?? 0) > 2 ||
            ((files?.length ?? 0) === 2 && !thumbnailFile) ||
            ((files?.length ?? 0) === 1 && !videoFile)
          ) {
            this.logger.error('SINGLE_VIDEO requires exactly one video with fieldname "video" and an optional thumbnail with fieldname "thumbnail"');
            throw new HttpException(
              'SINGLE_VIDEO requires exactly one video with fieldname "video" and an optional thumbnail with fieldname "thumbnail"',
              HttpStatus.BAD_REQUEST,
            );
          }
        } else if (adInputs.videoUrn) {
          if (files?.length) {
            this.logger.error('SINGLE_VIDEO cannot have both videoUrn and uploaded files');
            throw new HttpException(
              'SINGLE_VIDEO cannot have both videoUrn and uploaded files',
              HttpStatus.BAD_REQUEST,
            );
          }
        } else {
          this.logger.error('SINGLE_VIDEO requires either one video with fieldname "video" or a videoUrn');
          throw new HttpException(
            'SINGLE_VIDEO requires either one video with fieldname "video" or a videoUrn',
            HttpStatus.BAD_REQUEST,
          );
        }
        break;

        case 'SPOTLIGHT':
        // Attach image if uploaded, or use imageUrn
        if (files?.length === 1 && files[0].fieldname === 'image' && !adInputs.imageUrn) {
          adInputs.image = files[0].buffer;
        } else if (!adInputs.imageUrn && (!files || files.length !== 1 || files[0].fieldname !== 'image')) {
          this.logger.error('SPOTLIGHT requires either one image with fieldname "image" or an imageUrn');
          throw new HttpException(
            'SPOTLIGHT requires either one image with fieldname "image" or an imageUrn',
            HttpStatus.BAD_REQUEST,
          );
        } else if (adInputs.imageUrn && files?.length) {
          this.logger.error('SPOTLIGHT cannot have both imageUrn and uploaded image');
          throw new HttpException(
            'SPOTLIGHT cannot have both imageUrn and uploaded image',
            HttpStatus.BAD_REQUEST,
          );
        }
        break;
        default:
          this.logger.error(`Unsupported ad format: ${body.adFormat}`);
          throw new HttpException(`Unsupported ad format: ${body.adFormat}`, HttpStatus.BAD_REQUEST);
      }

      // Call service
      const result = await this.linkedInAdsService.createLinkedInCampaignAd(
        body.campaignId,
        adInputs,
      );

      return {
        success: result.success,
        message: result.message,
        data: result.data,
      };
    } catch (error: any) {
      this.logger.error(
        `Failed to create campaign ad for ${body.campaignId}: ${error.message}`,
      );
      throw new HttpException(
        error.message || 'Failed to create campaign ad',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Patch('ads/:creativeId')
  @UseGuards(JwtAuthGuard)
  async updateCreative(
    @Req() request: Request,
    @Param('creativeId') creativeId: string,
    @Body() body: {
      adAccountId: string;
      campaignId: string;
      intendedStatus?: 'ACTIVE' | 'PAUSED' | 'ARCHIVED' | 'CANCELLED';
      leadgenCallToAction?: { adFormUrn?: string; label?: string };
      name?: string;
    },
  ) {
    try {
      const result = await this.linkedInAdsService.updateLinkedInCreative(
        creativeId,
        body.adAccountId,
        body.campaignId,
        {
          intendedStatus: body.intendedStatus,
          leadgenCallToAction: body.leadgenCallToAction,
          name: body.name,
        },
      );
      return {
        success: result.success,
        message: result.message,
        data: result.data,
      };
    } catch (error: any) {
      this.logger.error(`Failed to update creative ${creativeId}: ${error.message}`);
      throw new HttpException(
        error.message || 'Failed to update creative',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
  
  @Get('ads/:adId/preview')
  @UseGuards(JwtAuthGuard)
  async getAdPreview(@Param('adId') adId: string) {
    try {
      const result = await this.linkedInAdsService.getAdPreview(adId);
      return {
        success: result.success,
        message: result.message,
        data: result.data,
      };
    } catch (error) {
      this.logger.error(
        `Failed to fetch ad preview for ${adId}: ${error.message}`,
      );
      throw new HttpException(error.message, error.status || 500);
    }
  }

  @Get('posts')
  @UseGuards(JwtAuthGuard)
  async getOrganizationPosts(
    @Query('orgUrn') orgUrn: string,
    @Query('adAccountId') adAccountId: string,
    @Query('campaignId') campaignId: string,
  ) {
    try {
      this.logger.log(
        `Fetching posts for orgUrn: ${orgUrn}, adAccountId: ${adAccountId}`,
      );
      const result = await this.linkedInAdsService.fetchLinkedInPagePosts(
        orgUrn,
        adAccountId,
        campaignId,
      );
      return {
        success: result.success,
        message: result.message,
        data: result.data,
      };
    } catch (error) {
      this.logger.error(
        `Failed to fetch posts for ${orgUrn}: ${error.message}`,
      );
      throw new HttpException(error.message, error.status || 500);
    }
  }

  @Get('ad-accounts')
  @UseGuards(JwtAuthGuard)
  async getAllAdAccounts() {
    try {
      const adAccounts = await this.linkedInAdsService.getAllAdAccounts();
      return {
        success: true,
        message: 'Fetched all ad accounts successfully',
        data: adAccounts,
      };
    } catch (error) {
      this.logger.error(`Failed to fetch ad accounts: ${error.message}`);
      throw new HttpException(error.message, error.status || 500);
    }
  }

  @Get('ad-accounts/:adAccountId/images')
  @UseGuards(JwtAuthGuard)
  async getImagesForAdAccount(@Param('adAccountId') adAccountId: string) {
    try {
      this.logger.log(`Fetching images for ad account: ${adAccountId}`);
      const result = await this.linkedInAdsService.getImagesForAdAccount(adAccountId);
      return {
        success: result.success,
        message: result.message,
        data: result.data,
      };
    } catch (error: any) {
      this.logger.error(
        `Failed to fetch images for ad account ${adAccountId}: ${error.message}`,
      );
      throw new HttpException(
        error.message || 'Failed to fetch images',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  @Get('ad-accounts/:adAccountId/videos')
  @UseGuards(JwtAuthGuard)
  async getVideosForAdAccount(@Param('adAccountId') adAccountId: string) {
    try {
      this.logger.log(`Fetching videos for ad account: ${adAccountId}`);
      const result = await this.linkedInAdsService.getVideosForAdAccount(adAccountId);
      return {
        success: result.success,
        message: result.message,
        data: result.data,
      };
    } catch (error: any) {
      this.logger.error(
        `Failed to fetch videos for ad account ${adAccountId}: ${error.message}`,
      );
      throw new HttpException(
        error.message || 'Failed to fetch videos',
        error.status || HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }
}
