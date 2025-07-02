import {
  Injectable,
  Logger,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { LinkedInService } from 'src/auth/linkedIn/linkedIn.service';
import axios from 'axios';
import pLimit from 'p-limit';
import { JsonValue } from '@prisma/client/runtime/library';

export interface CreateAudienceTemplateInput {
  name: string;
  description?: string;
  account: string;
  targetingCriteria: {
    industries?: {
      include: { value: string; text: string }[];
      exclude: { value: string; text: string }[];
    };
    locations?: {
      include: { value: string; text: string }[];
      exclude: { value: string; text: string }[];
    };
    seniorities?: {
      include: { value: string; text: string }[];
      exclude: { value: string; text: string }[];
    };
    staffCountRanges?: {
      include: { value: string; text: string }[];
      exclude: { value: string; text: string }[];
    };
    titles?: {
      include: { value: string; text: string }[];
      exclude: { value: string; text: string }[];
    };
    interfaceLocales?: {
      include: { value: string; text: string }[];
      exclude: { value: string; text: string }[];
    };
  };
}

@Injectable()
export class LinkedInAudienceService {
  private readonly logger = new Logger(LinkedInAudienceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly linkedinService: LinkedInService,
  ) {}

  async createAudienceTemplate(
    input: CreateAudienceTemplateInput,
  ): Promise<{ success: boolean; message: string; data: any }> {
    this.logger.log(
      `Creating audience template: ${input.name} for account: ${input.account}`,
    );
    this.logger.debug(
      `Input targeting criteria: ${JSON.stringify(input.targetingCriteria)}`,
    );
    try {
      const adAccount = await this.prisma.adAccount.findUnique({
        where: { id: input.account, organizationId: 'single-org' },
      });
      if (!adAccount) {
        this.logger.warn(`Ad account not found for ID: ${input.account}`);
        return { success: false, message: 'Ad account not found', data: {} };
      }

      const accountUrn = `urn:li:sponsoredAccount:${input.account}`;

      const targetingCriteriaPayload: any = {
        include: { and: [] },
        exclude: { or: {} },
      };

      const facetUrnMap: { [key: string]: string } = {
        industries: 'urn:li:adTargetingFacet:industries',
        locations: 'urn:li:adTargetingFacet:locations',
        seniorities: 'urn:li:adTargetingFacet:seniorities',
        staffCountRanges: 'urn:li:adTargetingFacet:staffCountRanges',
        titles: 'urn:li:adTargetingFacet:titles',
        interfaceLocales: 'urn:li:adTargetingFacet:interfaceLocales',
      };

      for (const [facetKey, config] of Object.entries(
        input.targetingCriteria,
      )) {
        if (config?.include?.length) {
          const facetUrn = facetUrnMap[facetKey];
          if (!facetUrn) {
            this.logger.warn(`Skipping unknown facet: ${facetKey}`);
            continue;
          }
          targetingCriteriaPayload.include.and.push({
            or: {
              [facetUrn]: config.include.map((item) => item.value),
            },
          });
        }

        // Process exclude criteria
        if (config?.exclude?.length) {
          const facetUrn = facetUrnMap[facetKey];
          if (!facetUrn) {
            this.logger.warn(
              `Skipping unknown facet for exclusion: ${facetKey}`,
            );
            continue;
          }
          targetingCriteriaPayload.exclude.or[facetUrn] = config.exclude.map(
            (item) => item.value,
          );
        }
      }

      // Remove empty include or exclude if not populated
      if (!targetingCriteriaPayload.include.and.length) {
        delete targetingCriteriaPayload.include;
      }
      if (!Object.keys(targetingCriteriaPayload.exclude.or).length) {
        delete targetingCriteriaPayload.exclude;
      }

      // Build the full LinkedIn API payload
      const apiPayload = {
        name: input.name,
        description: input.description || '',
        account: accountUrn,
        targetingCriteria: targetingCriteriaPayload,
      };

      // Step 3: Fetch LinkedIn access token
      const accessToken = await this.linkedinService.getValidAccessToken();
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        'LinkedIn-Version': '202505',
        'X-RestLi-Protocol-Version': '2.0.0',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };

      const fullUrl = `https://api.linkedin.com/rest/adTargetTemplates`;
      this.logger.log(`Calling LinkedIn API to create template: ${fullUrl}`);
      const response = await axios.post<any>(fullUrl, apiPayload, { headers });

      const templateId = response.headers['x-restli-id'];
      if (!templateId) {
        this.logger.error(
          'x-restli-id header missing in LinkedIn API response',
        );
        throw new Error('Failed to retrieve template ID from LinkedIn API');
      }

      const platform = await this.prisma.marketingPlatform.findFirst({
        where: { orgId: 'single-org', platform_name: 'LinkedIn' },
      });
      if (!platform) {
        this.logger.error('LinkedIn platform not found for organization');
        throw new Error('LinkedIn platform not configured');
      }

      const metadata = await this.prisma.linkedInMetadata.findUnique({
        where: {
          org_id_platform_id: {
            org_id: 'single-org',
            platform_id: platform.platform_id,
          },
        },
      });
      if (!metadata) {
        this.logger.error(
          `LinkedIn metadata not found for org: ${adAccount.organizationId}`,
        );
        throw new Error('LinkedIn metadata not configured');
      }

      const isMetadataArray = (
        data: JsonValue,
      ): data is { value: string; name: string }[] => {
        return (
          Array.isArray(data) &&
          data.every(
            (item) =>
              typeof item === 'object' &&
              item !== null &&
              'value' in item &&
              'name' in item &&
              typeof item.value === 'string' &&
              typeof item.name === 'string',
          )
        );
      };

      const metadataMaps: { [key: string]: Map<string, string> } = {
        industries: new Map(
          isMetadataArray(metadata.targeting_industries)
            ? metadata.targeting_industries.map((item) => [
                item.value,
                item.name,
              ])
            : [],
        ),
        titles: new Map(
          isMetadataArray(metadata.targeting_titles)
            ? metadata.targeting_titles.map((item) => [item.value, item.name])
            : [],
        ),
        seniorities: new Map(
          isMetadataArray(metadata.targeting_seniorities)
            ? metadata.targeting_seniorities.map((item) => [
                item.value,
                item.name,
              ])
            : [],
        ),
        staffCountRanges: new Map(
          isMetadataArray(metadata.targeting_staff_count_ranges)
            ? metadata.targeting_staff_count_ranges.map((item) => [
                item.value,
                item.name,
              ])
            : [],
        ),
        interfaceLocales: new Map(
          isMetadataArray(metadata.targeting_locales)
            ? metadata.targeting_locales.map((item) => [item.value, item.name])
            : [],
        ),
        locations: new Map(
          isMetadataArray(metadata.targeting_locations)
            ? metadata.targeting_locations.map((item) => [
                item.value,
                item.name,
              ])
            : [],
        ),
      };

      const transformedData: any = {};
      if (apiPayload.targetingCriteria) {
        const transformFacet = (facetData: any[], facetUrn: string): any[] => {
          if (!Array.isArray(facetData)) return [];
          const facetKey = facetUrn.split(':').pop() || facetUrn;
          const map = metadataMaps[facetKey];
          if (!map) {
            this.logger.warn(`No metadata map for facet: ${facetKey}`);
            return facetData;
          }
          return facetData.map((urn: string) => ({
            urn,
            name: map.get(urn) || 'Unknown',
          }));
        };

        const transformedCriteria = {
          include: apiPayload.targetingCriteria.include
            ? {
                and: apiPayload.targetingCriteria.include.and.map(
                  (andClause: any) => ({
                    or: Object.fromEntries(
                      Object.entries(andClause.or).map(([facetUrn, urns]) => [
                        facetUrn,
                        transformFacet(urns as any[], facetUrn),
                      ]),
                    ),
                  }),
                ),
              }
            : undefined,
          exclude: apiPayload.targetingCriteria.exclude
            ? {
                or: Object.fromEntries(
                  Object.entries(apiPayload.targetingCriteria.exclude.or).map(
                    ([facetUrn, urns]) => [
                      facetUrn,
                      transformFacet(urns as any[], facetUrn),
                    ],
                  ),
                ),
              }
            : undefined,
        };

        transformedData.targetingCriteria = transformedCriteria;
      }

      // Step 7: Prepare data for database
      const dbTemplate = {
        id: templateId.toString(),
        adAccountId: input.account,
        account: accountUrn,
        targetingCriteria:
          transformedData.targetingCriteria || apiPayload.targetingCriteria,
        name: input.name,
        description: input.description || null,
        approximateMemberCount: null, // Not available from API response
        created: new Date(),
        lastModified: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Step 8: Save to database
      await this.prisma.audienceTemplates.create({
        data: dbTemplate,
      });

      this.logger.log(
        `Successfully created and saved audience template: ${dbTemplate.id}`,
      );

      return {
        success: true,
        message: `Successfully created audience template: ${dbTemplate.name}`,
        data: dbTemplate,
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
              data: error.config?.data,
            },
          },
        );
        if (error.response.status === 401) {
          throw new UnauthorizedException('Invalid or expired access token');
        }
        if (error.response.status === 403) {
          throw new ForbiddenException('Missing required scopes (r_ads)');
        }
        if (error.response.status === 429) {
          throw new Error('Rate limit exceeded');
        }
        if (error.response.status === 400) {
          throw new Error(
            `Invalid API payload: ${JSON.stringify(error.response.data)}`,
          );
        }
      }
      this.logger.error(`Failed to create audience template: ${error.message}`);
      throw new Error('Failed to create audience template');
    }
  }

  async updateAudienceTemplate(
    templateId: string,
    input: CreateAudienceTemplateInput,
  ): Promise<{ success: boolean; message: string; data: any }> {
    this.logger.log(
      `Updating audience template: ${templateId} with name: ${input.name} for account: ${input.account}`,
    );
    this.logger.debug(
      `Input targeting criteria: ${JSON.stringify(input.targetingCriteria)}`,
    );

    try {
      // Step 1: Validate the ad account
      const adAccount = await this.prisma.adAccount.findUnique({
        where: { id: input.account, organizationId: 'single-org' },
      });
      if (!adAccount) {
        this.logger.warn(`Ad account not found for ID: ${input.account}`);
        return { success: false, message: 'Ad account not found', data: {} };
      }

      // Step 2: Validate the template exists in the database
      const existingTemplate = await this.prisma.audienceTemplates.findUnique({
        where: { id: templateId },
      });
      if (!existingTemplate) {
        this.logger.warn(`Audience template not found for ID: ${templateId}`);
        return {
          success: false,
          message: 'Audience template not found',
          data: {},
        };
      }

      const accountUrn = `urn:li:sponsoredAccount:${input.account}`;

      // Step 3: Build targeting criteria payload
      const targetingCriteriaPayload: any = {
        include: { and: [] },
        exclude: { or: {} },
      };

      const facetUrnMap: { [key: string]: string } = {
        industries: 'urn:li:adTargetingFacet:industries',
        locations: 'urn:li:adTargetingFacet:locations',
        seniorities: 'urn:li:adTargetingFacet:seniorities',
        staffCountRanges: 'urn:li:adTargetingFacet:staffCountRanges',
        titles: 'urn:li:adTargetingFacet:titles',
        interfaceLocales: 'urn:li:adTargetingFacet:interfaceLocales',
      };

      for (const [facetKey, config] of Object.entries(
        input.targetingCriteria,
      )) {
        if (config?.include?.length) {
          const facetUrn = facetUrnMap[facetKey];
          if (!facetUrn) {
            this.logger.warn(`Skipping unknown facet: ${facetKey}`);
            continue;
          }
          targetingCriteriaPayload.include.and.push({
            or: {
              [facetUrn]: config.include.map((item) => item.value),
            },
          });
        }

        if (config?.exclude?.length) {
          const facetUrn = facetUrnMap[facetKey];
          if (!facetUrn) {
            this.logger.warn(
              `Skipping unknown facet for exclusion: ${facetKey}`,
            );
            continue;
          }
          targetingCriteriaPayload.exclude.or[facetUrn] = config.exclude.map(
            (item) => item.value,
          );
        }
      }

      if (!targetingCriteriaPayload.include.and.length) {
        delete targetingCriteriaPayload.include;
      }
      if (!Object.keys(targetingCriteriaPayload.exclude.or).length) {
        delete targetingCriteriaPayload.exclude;
      }

      // Step 4: Fetch LinkedIn metadata
      const platform = await this.prisma.marketingPlatform.findFirst({
        where: { orgId: 'single-org', platform_name: 'LinkedIn' },
      });
      if (!platform) {
        this.logger.error('LinkedIn platform not found for organization');
        throw new Error('LinkedIn platform not configured');
      }

      const metadata = await this.prisma.linkedInMetadata.findUnique({
        where: {
          org_id_platform_id: {
            org_id: 'single-org',
            platform_id: platform.platform_id,
          },
        },
      });
      if (!metadata) {
        this.logger.error(
          `LinkedIn metadata not found for org: ${adAccount.organizationId}`,
        );
        throw new Error('LinkedIn metadata not configured');
      }

      const isMetadataArray = (
        data: JsonValue,
      ): data is { value: string; name: string }[] => {
        return (
          Array.isArray(data) &&
          data.every(
            (item) =>
              typeof item === 'object' &&
              item !== null &&
              'value' in item &&
              'name' in item &&
              typeof item.value === 'string' &&
              typeof item.name === 'string',
          )
        );
      };

      const metadataMaps: { [key: string]: Map<string, string> } = {
        industries: new Map(
          isMetadataArray(metadata.targeting_industries)
            ? metadata.targeting_industries.map((item) => [
                item.value,
                item.name,
              ])
            : [],
        ),
        titles: new Map(
          isMetadataArray(metadata.targeting_titles)
            ? metadata.targeting_titles.map((item) => [item.value, item.name])
            : [],
        ),
        seniorities: new Map(
          isMetadataArray(metadata.targeting_seniorities)
            ? metadata.targeting_seniorities.map((item) => [
                item.value,
                item.name,
              ])
            : [],
        ),
        staffCountRanges: new Map(
          isMetadataArray(metadata.targeting_staff_count_ranges)
            ? metadata.targeting_staff_count_ranges.map((item) => [
                item.value,
                item.name,
              ])
            : [],
        ),
        interfaceLocales: new Map(
          isMetadataArray(metadata.targeting_locales)
            ? metadata.targeting_locales.map((item) => [item.value, item.name])
            : [],
        ),
        locations: new Map(
          isMetadataArray(metadata.targeting_locations)
            ? metadata.targeting_locations.map((item) => [
                item.value,
                item.name,
              ])
            : [],
        ),
      };

      // Step 5: Transform targeting criteria for database
      const transformedData: any = {};
      if (targetingCriteriaPayload) {
        const transformFacet = (facetData: any[], facetUrn: string): any[] => {
          if (!Array.isArray(facetData)) return [];
          const facetKey = facetUrn.split(':').pop() || facetUrn;
          const map = metadataMaps[facetKey];
          if (!map) {
            this.logger.warn(
              `No metadata map for ${facetKey} facet: ${facetKey}`,
            );
            return facetData;
          }
          return facetData.map((urn: string) => ({
            urn,
            name: map.get(urn) || 'Unknown',
          }));
        };

        const transformedCriteria = {
          include: targetingCriteriaPayload.include
            ? {
                and: targetingCriteriaPayload.include.and.map(
                  (andClause: any) => ({
                    or: Object.fromEntries(
                      Object.entries(andClause.or).map(([facetUrn, urns]) => [
                        facetUrn,
                        transformFacet(urns as any[], facetUrn),
                      ]),
                    ),
                  }),
                ),
              }
            : undefined,
          exclude: targetingCriteriaPayload.exclude
            ? {
                or: Object.fromEntries(
                  Object.entries(targetingCriteriaPayload.exclude.or).map(
                    ([facetUrn, urns]) => [
                      facetUrn,
                      transformFacet(urns as any[], facetUrn),
                    ],
                  ),
                ),
              }
            : undefined,
        };

        transformedData.targetingCriteria = transformedCriteria;
      }

      // Step 6: Build the LinkedIn API payload for partial update
      const apiPayload = {
        patch: {
          $set: {
            name: input.name,
            description: input.description || '',
            targetingCriteria: targetingCriteriaPayload,
          },
        },
      };

      // Step 7: Fetch LinkedIn access token
      const accessToken = await this.linkedinService.getValidAccessToken();
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        'LinkedIn-Version': '202505',
        'X-RestLi-Protocol-Version': '2.0.0',
        'X-Restli-Method': 'PARTIAL_UPDATE',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };

      const fullUrl = `https://api.linkedin.com/rest/adTargetTemplates/${encodeURIComponent(templateId)}`;
      this.logger.log(`Calling LinkedIn API to update template: ${fullUrl}`);
      await axios.post(fullUrl, apiPayload, { headers });

      // Step 8: Prepare data for database update
      const dbTemplate = {
        adAccountId: input.account,
        account: accountUrn,
        targetingCriteria:
          transformedData.targetingCriteria ||
          apiPayload.patch.$set.targetingCriteria,
        name: input.name,
        description: input.description || null,
        lastModified: new Date(),
        updatedAt: new Date(),
      };

      // Step 9: Update database
      const updatedTemplate = await this.prisma.audienceTemplates.update({
        where: { id: templateId },
        data: dbTemplate,
      });

      this.logger.log(`Successfully updated audience template: ${templateId}`);

      return {
        success: true,
        message: `Successfully updated audience template: ${input.name}`,
        data: {
          ...updatedTemplate,
          approximateMemberCount: updatedTemplate.approximateMemberCount
            ? updatedTemplate.approximateMemberCount.toString()
            : null,
        },
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
              data: error.config?.data,
            },
          },
        );
        if (error.response.status === 401) {
          throw new UnauthorizedException('Invalid or expired access token');
        }
        if (error.response.status === 403) {
          throw new ForbiddenException('Missing required scopes (r_ads)');
        }
        if (error.response.status === 429) {
          throw new Error('Rate limit exceeded');
        }
        if (error.response.status === 400) {
          throw new Error(
            `Invalid API payload: ${JSON.stringify(error.response.data)}`,
          );
        }
        if (error.response.status === 404) {
          throw new Error(
            `Audience template not found on LinkedIn: ${templateId}`,
          );
        }
      }
      this.logger.error(`Failed to update audience template: ${error.message}`);
      throw new Error('Failed to update audience template');
    }
  }

async deleteAudienceTemplate(
    templateId: string,
  ): Promise<{ success: boolean; message: string; data: any }> {
    this.logger.log(`Deleting audience template: ${templateId}`);

    try {
      // Step 1: Validate the template exists in the database
      const existingTemplate = await this.prisma.audienceTemplates.findUnique({
        where: { id: templateId },
      });
      if (!existingTemplate) {
        this.logger.warn(`Audience template not found for ID: ${templateId}`);
        return {
          success: false,
          message: 'Audience template not found',
          data: null,
        };
      }

      // Step 2: Fetch LinkedIn access token
      const accessToken = await this.linkedinService.getValidAccessToken();
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        'LinkedIn-Version': '202505',
        'X-RestLi-Protocol-Version': '2.0.0',
        Accept: 'application/json',
      };

      // Step 3: Call LinkedIn API to delete the template
      const fullUrl = `https://api.linkedin.com/rest/adTargetTemplates/${encodeURIComponent(templateId)}`;
      this.logger.log(`Calling LinkedIn API to delete template: ${fullUrl}`);
      await axios.delete(fullUrl, { headers });

      // Step 4: Delete the template from the database
      await this.prisma.audienceTemplates.delete({
        where: { id: templateId },
      });

      this.logger.log(`Successfully deleted audience template: ${templateId}`);

      return {
        success: true,
        message: `Successfully deleted audience template: ${templateId}`,
        data: { id: templateId },
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
          throw new ForbiddenException('Missing required scopes (r_ads)');
        }
        if (error.response.status === 404) {
          // If not found on LinkedIn, still delete from database to keep it in sync
          this.logger.warn(`Template ${templateId} not found on LinkedIn, deleting from database`);
          await this.prisma.audienceTemplates.delete({
            where: { id: templateId },
            // If already deleted from DB, this will throw, but we catch it below
          }).catch((dbError) => {
            this.logger.warn(`Template ${templateId} already deleted from database: ${dbError.message}`);
          });
          return {
            success: true,
            message: `Template not found on LinkedIn, removed from database: ${templateId}`,
            data: { id: templateId },
          };
        }
        if (error.response.status === 429) {
          throw new Error('Rate limit exceeded');
        }
      }
      this.logger.error(`Failed to delete audience template: ${error.message}`);
      throw new Error('Failed to delete audience template');
    }
  }


  async fetchAudienceTemplates(
    orgId: string = 'single-org',
  ): Promise<{ success: boolean; message: string; data: any[] }> {
    this.logger.log(`Fetching audience templates for organization: ${orgId}`);

    try {
      // Step 1: Fetch all ad accounts for the organization
      const adAccounts = await this.prisma.adAccount.findMany({
        where: { organizationId: orgId },
        select: { id: true, accountUrn: true },
      });
      if (!adAccounts.length) {
        this.logger.warn(`No ad accounts found for organization: ${orgId}`);
        return { success: false, message: 'No ad accounts found', data: [] };
      }
      this.logger.log(
        `Found ${adAccounts.length} ad accounts for organization: ${orgId}`,
      );

      // Step 2: Fetch LinkedIn metadata
      const platform = await this.prisma.marketingPlatform.findFirst({
        where: { orgId, platform_name: 'LinkedIn' },
      });
      if (!platform) {
        this.logger.error('LinkedIn platform not found for organization');
        throw new Error('LinkedIn platform not configured');
      }

      const metadata = await this.prisma.linkedInMetadata.findUnique({
        where: {
          org_id_platform_id: {
            org_id: orgId,
            platform_id: platform.platform_id,
          },
        },
      });
      if (!metadata) {
        this.logger.error(`LinkedIn metadata not found for org: ${orgId}`);
        throw new Error('LinkedIn metadata not configured');
      }

      // Create lookup maps for URNs to names (include locations)
      const isMetadataArray = (
        data: JsonValue,
      ): data is { value: string; name: string }[] => {
        return (
          Array.isArray(data) &&
          data.every(
            (item) =>
              typeof item === 'object' &&
              item !== null &&
              'value' in item &&
              'name' in item &&
              typeof item.value === 'string' &&
              typeof item.name === 'string',
          )
        );
      };

      const metadataMaps: { [key: string]: Map<string, string> } = {
        industries: new Map(
          isMetadataArray(metadata.targeting_industries)
            ? metadata.targeting_industries.map((item) => [
                item.value,
                item.name,
              ])
            : [],
        ),
        titles: new Map(
          isMetadataArray(metadata.targeting_titles)
            ? metadata.targeting_titles.map((item) => [item.value, item.name])
            : [],
        ),
        seniorities: new Map(
          isMetadataArray(metadata.targeting_seniorities)
            ? metadata.targeting_seniorities.map((item) => [
                item.value,
                item.name,
              ])
            : [],
        ),
        staffCountRanges: new Map(
          isMetadataArray(metadata.targeting_staff_count_ranges)
            ? metadata.targeting_staff_count_ranges.map((item) => [
                item.value,
                item.name,
              ])
            : [],
        ),
        interfaceLocales: new Map(
          isMetadataArray(metadata.targeting_locales)
            ? metadata.targeting_locales.map((item) => [item.value, item.name])
            : [],
        ),
        locations: new Map(
          isMetadataArray(metadata.targeting_locations)
            ? metadata.targeting_locations.map((item) => [
                item.value,
                item.name,
              ])
            : [],
        ),
      };

      // Step 3: Fetch audience templates from LinkedIn API for each ad account
      const accessToken = await this.linkedinService.getValidAccessToken();
      const headers = {
        Authorization: `Bearer ${accessToken}`,
        'LinkedIn-Version': '202505',
        'X-RestLi-Protocol-Version': '2.0.0',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      };

      const limit = pLimit(5); // Throttle API requests to avoid rate limits
      const audienceTemplates: any[] = [];

      const fetchTemplatesForAccount = async (adAccount: {
        id: string;
        accountUrn: string;
      }) => {
        this.logger.log(
          `Fetching audience templates for ad account: ${adAccount.accountUrn}`,
        );
        const encodedAccountUrn = encodeURIComponent(adAccount.accountUrn);
        const queryString = `q=account&account=${encodedAccountUrn}&filter=(targetingCriterias:List())&sortField=ID&sortOrder=ASCENDING`;

        const fullUrl = `https://api.linkedin.com/rest/adTargetTemplates?${queryString}`;
        this.logger.log(`Calling LinkedIn API with URL: ${fullUrl}`);
        try {
          const response = await axios.get<{
            elements: any[];
            paging: { total: number; start: number; count: number };
          }>(fullUrl, {
            headers,
          });

          const templates = response.data.elements || [];
          this.logger.log(
            `Fetched ${templates.length} audience templates for ad account ${adAccount.id}`,
          );
          audienceTemplates.push(
            ...templates.map((template) => ({
              ...template,
              adAccountId: adAccount.id,
            })),
          );
        } catch (error: any) {
          if (error.response) {
            this.logger.error(
              `LinkedIn API Error for ad account ${adAccount.id}: ${error.response.status} - ${JSON.stringify(error.response.data)}`,
              {
                request: {
                  url: error.config?.url,
                  method: error.config?.method,
                  params: error.config?.params,
                  headers: error.config?.headers,
                },
              },
            );
            if (error.response.status === 401) {
              throw new UnauthorizedException(
                'Invalid or expired access token',
              );
            }
            if (error.response.status === 403) {
              throw new ForbiddenException('Missing required scopes (r_ads)');
            }
            if (error.response.status === 429) {
              throw new Error('Rate limit exceeded');
            }
          }
          this.logger.error(
            `Failed to fetch audience templates for ad account ${adAccount.id}: ${error.message}`,
          );
          // Continue with other accounts instead of failing the entire operation
        }
      };

      await Promise.all(
        adAccounts.map((adAccount) =>
          limit(() => fetchTemplatesForAccount(adAccount)),
        ),
      );

      interface TransformedData {
        targetingCriteria?: {
          include?: {
            and: Array<{
              or: { [key: string]: Array<{ urn: string; name: string }> };
            }>;
          };
        };
      }

      // Step 4: Map URNs to names for all facets, including locations
      const mappedTemplates = audienceTemplates.map((template) => {
        const transformedData: TransformedData = {};
        if (template.targetingCriteria) {
          const transformFacet = (facetData: any, facetUrn: string): any => {
            const facetKey = facetUrn.split(':').pop() || facetUrn; // e.g., "industries", "locations"
            const map = metadataMaps[facetKey];
            if (!map) {
              this.logger.warn(`No metadata map for facet: ${facetKey}`);
              return facetData; // Return unchanged if no metadata
            }
            return facetData.map((urn: string) => ({
              urn,
              name: map.get(urn) || 'Unknown',
            }));
          };

          const transformedCriteria = {
            include: template.targetingCriteria.include
              ? {
                  and: template.targetingCriteria.include.and.map(
                    (andClause: any) => ({
                      or: Object.fromEntries(
                        Object.entries(andClause.or).map(([facetUrn, urns]) => [
                          facetUrn, // Keep full URN, e.g., "urn:li:adTargetingFacet:locations"
                          transformFacet(urns, facetUrn),
                        ]),
                      ),
                    }),
                  ),
                }
              : undefined,
          };

          transformedData.targetingCriteria = transformedCriteria;
        }

        return {
          id: template.id.toString(), // Use LinkedIn API's id directly
          adAccountId: template.adAccountId,
          account: template.account,
          targetingCriteria:
            transformedData.targetingCriteria || template.targetingCriteria,
          name: template.name || 'Unnamed Template',
          description: template.description || null,
          approximateMemberCount: template.approximateMemberCount || null,
          created: template.created?.time
            ? new Date(template.created.time)
            : new Date(),
          lastModified: template.lastModified?.time
            ? new Date(template.lastModified.time)
            : new Date(),
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      });

      // Step 5: Save audience templates to database
      for (const template of mappedTemplates) {
        await this.prisma.audienceTemplates.upsert({
          where: { id: template.id },
          update: {
            adAccountId: template.adAccountId,
            account: template.account,
            targetingCriteria: template.targetingCriteria,
            name: template.name,
            description: template.description,
            approximateMemberCount: template.approximateMemberCount,
            created: template.created,
            lastModified: template.lastModified,
            updatedAt: template.updatedAt,
          },
          create: template,
        });
      }

      this.logger.log(
        `Saved ${mappedTemplates.length} audience templates to database`,
      );

      return {
        success: true,
        message: `Successfully fetched and saved ${mappedTemplates.length} audience templates`,
        data: mappedTemplates,
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
              params: error.config?.params,
            },
          },
        );
        if (error.response.status === 401) {
          throw new UnauthorizedException('Invalid or expired access token');
        }
        if (error.response.status === 403) {
          throw new ForbiddenException('Missing required scopes (r_ads)');
        }
        if (error.response.status === 429) {
          throw new Error('Rate limit exceeded');
        }
      }
      this.logger.error(`Failed to fetch audience templates: ${error.message}`);
      throw new Error('Failed to fetch and save audience templates');
    }
  }

  async getAudienceTemplatesByAccountId(
    adAccountId: string,
  ): Promise<{ success: boolean; message: string; data: any[] }> {
    this.logger.log(
      `Fetching audience templates for ad account ID: ${adAccountId}`,
    );

    try {
      // Step 1: Validate ad account exists
      const adAccount = await this.prisma.adAccount.findUnique({
        where: { id: adAccountId },
        select: { id: true, organizationId: true },
      });
      if (!adAccount) {
        this.logger.warn(`Ad account not found for ID: ${adAccountId}`);
        return { success: false, message: 'Ad account not found', data: [] };
      }

      // Step 2: Fetch audience templates from database
      const templates = await this.prisma.audienceTemplates.findMany({
        where: { adAccountId },
        select: {
          id: true,
          adAccountId: true,
          account: true,
          targetingCriteria: true,
          name: true,
          description: true,
          approximateMemberCount: true,
          created: true,
          lastModified: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      // Step 3: Transform BigInt to string for JSON serialization
      const serializedTemplates = templates.map((template) => ({
        ...template,
        approximateMemberCount: template.approximateMemberCount
          ? template.approximateMemberCount.toString()
          : null,
      }));

      this.logger.log(
        `Fetched ${templates.length} audience templates for ad account ID: ${adAccountId}`,
      );

      return {
        success: true,
        message: `Successfully fetched ${templates.length} audience templates`,
        data: serializedTemplates,
      };
    } catch (error: any) {
      this.logger.error(
        `Failed to fetch audience templates for ad account ID: ${adAccountId}: ${error.message}`,
      );
      throw new Error('Failed to fetch audience templates');
    }
  }

  async getAllAudienceTemplates(): Promise<{
    success: boolean;
    message: string;
    data: any[];
  }> {
    this.logger.log(`Fetching all audience templates`);

    try {
      // Step 1: Fetch all audience templates from database
      const templates = await this.prisma.audienceTemplates.findMany({
        select: {
          id: true,
          adAccountId: true,
          account: true,
          targetingCriteria: true,
          name: true,
          description: true,
          approximateMemberCount: true,
          created: true,
          lastModified: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      // Step 2: Transform BigInt to string for JSON serialization
      const serializedTemplates = templates.map((template) => ({
        ...template,
        approximateMemberCount: template.approximateMemberCount
          ? template.approximateMemberCount.toString()
          : null,
      }));

      this.logger.log(`Fetched ${templates.length} total audience templates`);

      return {
        success: true,
        message: `Successfully fetched ${templates.length} audience templates`,
        data: serializedTemplates,
      };
    } catch (error: any) {
      this.logger.error(`Failed to fetch audience templates: ${error.message}`);
      throw new Error('Failed to fetch audience templates');
    }
  }
}
