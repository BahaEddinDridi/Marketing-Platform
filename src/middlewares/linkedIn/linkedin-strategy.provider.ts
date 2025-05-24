import { Provider } from '@nestjs/common';

import { PrismaService } from 'src/prisma/prisma.service';
import { LinkedInService } from 'src/auth/linkedIn/linkedIn.service';
import { LinkedInAuthConfigService } from './linkedin-auth-config.service';
import { LinkedInStrategy } from 'src/strategies/linkedIn/linkedin.strategy';

export const LinkedInStrategyProvider: Provider = {
  provide: 'LINKEDIN_STRATEGY',
  useFactory: async (
    linkedInService: LinkedInService,
    prisma: PrismaService,
  ) => {
   try {
      const config = await linkedInService.getLinkedInCredentials();
      const authConfigService = new LinkedInAuthConfigService(config.clientId, config.clientSecret);
      return new LinkedInStrategy(linkedInService, authConfigService, prisma);
    } catch (error) {
      console.warn('Skipping LinkedInStrategy initialization: No credentials available');
      return null; // Skip strategy initialization
    }
  },
  inject: [LinkedInService, PrismaService],
};