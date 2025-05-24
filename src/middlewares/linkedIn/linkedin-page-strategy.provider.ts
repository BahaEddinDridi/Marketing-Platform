import { Provider } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { LinkedInService } from 'src/auth/linkedIn/linkedIn.service';
import { LinkedInAuthConfigService } from './linkedin-auth-config.service';
import { LinkedInPageStrategy } from 'src/strategies/linkedIn/linkedin-page.strategy';

export const LinkedInPageStrategyProvider: Provider = {
  provide: 'LINKEDIN_PAGE_STRATEGY',
  useFactory: async (
    linkedInService: LinkedInService,
    prisma: PrismaService,
  ) => {
    try {
      const config = await linkedInService.getLinkedInCredentials();
      const authConfigService = new LinkedInAuthConfigService(config.clientId, config.clientSecret);
      return new LinkedInPageStrategy(linkedInService, authConfigService, prisma);
    } catch (error) {
      console.warn('Skipping LinkedInPageStrategy initialization: No credentials available');
      return null; // Skip strategy initialization
    }
  },
  inject: [LinkedInService, PrismaService],
};