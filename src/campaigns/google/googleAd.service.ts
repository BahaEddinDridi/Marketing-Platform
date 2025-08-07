import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/prisma/prisma.service';
import { GoogleService } from 'src/auth/google/google.service';
import Groq from 'groq-sdk';

export interface GeneratedText {
  text: string;
  score?: number;
}

@Injectable()
export class GoogleAdsAIService {
  private readonly logger = new Logger(GoogleAdsAIService.name);
  private readonly groqClient: Groq;

  constructor(
    private readonly prisma: PrismaService,
    private readonly googleService: GoogleService,
    private readonly configService: ConfigService,
  ) {
    const groqApiKey = this.configService.get<string>('GROQ_API_KEY');
    if (!groqApiKey) {
      this.logger.error('Groq API key not found in environment variables');
      throw new InternalServerErrorException('Groq API key not configured');
    }
    this.groqClient = new Groq({ apiKey: groqApiKey });
    this.logger.log('Groq client initialized successfully');
  }

  async generateHeadlines(
    campaignId: string,
    count: number = 5,
    context?: {
      keywords?: string[];
      businessDescription?: string;
      campaignType?: 'SEARCH' | 'DISPLAY';
    },
  ): Promise<GeneratedText[]> {
    this.logger.log(`Generating ${count} headlines for campaign ${campaignId}`);

    const campaign = await this.prisma.googleCampaign.findUnique({
      where: { campaign_id: campaignId },
      select: { advertising_channel_type: true },
    });
    if (!campaign) {
      this.logger.error(`Campaign with ID ${campaignId} not found`);
      throw new NotFoundException(`Campaign with ID ${campaignId} not found`);
    }

    if (count <= 0 || count > 15) {
      this.logger.error(`Invalid headline count: ${count}`);
      throw new BadRequestException('Headline count must be between 1 and 15');
    }

    const campaignType =
      context?.campaignType || campaign.advertising_channel_type || 'SEARCH';
    const maxLength = 30;
    const prompt = this.buildHeadlinePrompt(
      campaignType,
      context?.keywords || [],
      context?.businessDescription || '',
      count,
      maxLength,
    );

    try {
      const results = await this.generateTextWithAI(
        prompt,
        count,
        maxLength,
        'headline',
      );
      this.logger.log(
        `Generated ${results.length} headlines for campaign ${campaignId}`,
      );
      this.logger.log('Generated headlines:', results);
      return results.map((text, index) => ({
        text,
        score: 0.9 - index * 0.05,
      }));
    } catch (error: any) {
      this.logger.error(`Headline generation failed: ${error.message}`, {
        stack: error.stack,
      });
      throw new InternalServerErrorException('Failed to generate headlines');
    }
  }

  async generateDescriptions(
    campaignId: string,
    count: number = 3,
    context?: {
      keywords?: string[];
      businessDescription?: string;
      campaignType?: 'SEARCH' | 'DISPLAY';
    },
  ): Promise<GeneratedText[]> {
    this.logger.log(
      `Generating ${count} descriptions for campaign ${campaignId}`,
    );

    const campaign = await this.prisma.googleCampaign.findUnique({
      where: { campaign_id: campaignId },
      select: { advertising_channel_type: true },
    });
    if (!campaign) {
      this.logger.error(`Campaign with ID ${campaignId} not found`);
      throw new NotFoundException(`Campaign with ID ${campaignId} not found`);
    }

    if (count <= 0 || count > 10) {
      this.logger.error(`Invalid description count: ${count}`);
      throw new BadRequestException(
        'Description count must be between 1 and 10',
      );
    }

    const campaignType =
      context?.campaignType || campaign.advertising_channel_type || 'SEARCH';
    const maxLength = 90;
    const prompt = this.buildDescriptionPrompt(
      campaignType,
      context?.keywords || [],
      context?.businessDescription || '',
      count,
      maxLength,
    );

    try {
      const results = await this.generateTextWithAI(
        prompt,
        count,
        maxLength,
        'description',
      );
      this.logger.log(
        `Generated ${results.length} descriptions for campaign ${campaignId}`,
      );
      this.logger.log('Generated descriptions:', results);
      return results.map((text, index) => ({
        text,
        score: 0.9 - index * 0.05,
      }));
    } catch (error: any) {
      this.logger.error(`Description generation failed: ${error.message}`, {
        stack: error.stack,
      });
      throw new InternalServerErrorException('Failed to generate descriptions');
    }
  }

  private buildHeadlinePrompt(
    campaignType: string,
    keywords: string[],
    businessDescription: string,
    count: number,
    maxLength: number,
  ): string {
    const campaignContext =
      campaignType === 'SEARCH'
        ? 'responsive search ads with concise, keyword-driven phrases'
        : 'responsive display ads with engaging, visually appealing phrases';
    const keywordText =
      keywords.length > 0
        ? `Include these keywords where relevant: ${keywords.join(', ')}.`
        : 'Use general terms relevant to the business.';
    const businessText = businessDescription
      ? `Business: ${businessDescription}.`
      : 'Business: A generic company offering innovative solutions.';
    const lengthConstraint =
      campaignType === 'SEARCH'
        ? `Be between 15 and ${maxLength} characters (including spaces and punctuation).`
        : `Be no longer than ${maxLength} characters (including spaces and punctuation).`;
    return `You are an expert ad copywriter. Generate exactly ${count} unique Google Ads headlines for ${campaignContext}. Each headline must follow these strict rules:
- Be professional, persuasive, and relevant.
- Be no longer than ${maxLength} characters, including spaces and punctuation.
- Do not exceed the character limit — not even by 1 character.
- Include no numbering, introductions, or explanations.
- ${keywordText}
- ${businessText}

Only return the headlines, each on its own line. No extra lines or commentary.

Example output:
Odoo CRM: Streamline Sales!
Boost Efficiency with Odoo
Innovate Faster with OpenAI`;
  }

  private buildDescriptionPrompt(
    campaignType: string,
    keywords: string[],
    businessDescription: string,
    count: number,
    maxLength: number,
  ): string {
    const campaignContext =
      campaignType === 'SEARCH'
        ? 'responsive search ads with clear, action-oriented descriptions'
        : 'responsive display ads with engaging, informative descriptions';
    const keywordText =
      keywords.length > 0
        ? `Include these keywords where relevant: ${keywords.join(', ')}.`
        : 'Use general terms relevant to the business.';
    const businessText = businessDescription
      ? `Business: ${businessDescription}.`
      : 'Business: A generic company offering innovative solutions.';
    return `As an expert ad copywriter, generate exactly ${count} unique Google Ads descriptions for ${campaignContext}. Each description must:
- Be professional, persuasive, and include a call to action (e.g., "Learn more", "Sign up").
- Be no longer than ${maxLength} characters (including spaces and punctuation).
- ${keywordText}
- ${businessText}
Output only the ${count} descriptions, one per line, without any introductions, explanations, numbering, or extra text. Example:
Odoo CRM: Streamline your sales process. Sign up!
OpenAI-powered CRM for efficiency. Learn more!
Boost your business with Odoo CRM. Try now!`;
  }

  private async generateTextWithAI(
    prompt: string,
    count: number,
    maxLength: number,
    type: 'headline' | 'description',
  ): Promise<string[]> {
    try {
      const response = await this.groqClient.chat.completions.create({
        model: 'llama3-70b-8192', // Keep the working model
        messages: [
          {
            role: 'system',
            content:
              'You are an expert ad copywriter. Follow the user’s instructions exactly, producing only the requested number of ad copies, one per line, with no additional text, introductions, or numbering.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        max_tokens: maxLength + 20,
        temperature: 0.6,
        top_p: 0.9,
      });

      this.logger.log(
        `Raw Groq response for ${type}s:`,
        JSON.stringify(response, null, 2),
      );

      const smartTrim = (text: string, maxLength: number): string => {
        if (text.length <= maxLength) return text;
        const words = text.split(' ');
        let result = '';
        for (const word of words) {
          if ((result + ' ' + word).trim().length > maxLength) break;
          result = (result + ' ' + word).trim();
        }
        return result;
      };

      let generatedTexts: string[] = [];
      if (response.choices && Array.isArray(response.choices)) {
        const content = response.choices[0]?.message?.content?.trim() || '';
        generatedTexts = content
          .split('\n')
          .map((text) => {
            const trimmed = text.trim();
            return type === 'headline'
              ? smartTrim(trimmed, maxLength)
              : trimmed.slice(0, maxLength).trim();
          })
          .filter(
            (text) =>
              text.length > 0 &&
              text.length <= (type === 'headline' ? 35 : maxLength),
          ) // Allow up to 35 for headlines
          .slice(0, count);
        // Log character lengths for debugging
        generatedTexts.forEach((text, index) =>
          this.logger.log(
            `${type} ${index + 1} length: ${text.length} characters`,
          ),
        );
      } else {
        this.logger.warn(
          `Unexpected response format from Groq API for ${type}s`,
          response,
        );
        generatedTexts = [];
      }

      // Ensure unique texts and meet count requirement
      const uniqueTexts = [...new Set(generatedTexts)];
      if (uniqueTexts.length < count) {
        this.logger.warn(
          `Generated only ${uniqueTexts.length} valid ${type}s, adding fallbacks`,
        );
      }
      while (uniqueTexts.length < count) {
        const fallbackText =
          `Generated ${type.charAt(0).toUpperCase() + type.slice(1)} ${
            uniqueTexts.length + 1
          }`.slice(0, maxLength);
        uniqueTexts.push(fallbackText);
        this.logger.warn(`Added fallback text: ${fallbackText}`);
      }

      return uniqueTexts.slice(0, count);
    } catch (error: any) {
      this.logger.error(`Groq API error for ${type}s: ${error.message}`, {
        stack: error.stack,
        details: error.response?.data
          ? JSON.stringify(error.response.data)
          : 'No response data',
      });
      if (error.response?.status === 401) {
        throw new UnauthorizedException('Invalid Groq API key');
      }
      if (error.response?.status === 429) {
        throw new InternalServerErrorException('Groq rate limit exceeded');
      }
      throw new InternalServerErrorException(
        `Failed to generate ${type}s with Groq API`,
      );
    }
  }
}
