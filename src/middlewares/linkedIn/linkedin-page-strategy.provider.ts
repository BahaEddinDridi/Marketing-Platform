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
    const config = await linkedInService.getLinkedInCredentials();
    const authConfigService = new LinkedInAuthConfigService(config.clientId, config.clientSecret);
    return new LinkedInPageStrategy(linkedInService, authConfigService, prisma);
  },
  inject: [LinkedInService, PrismaService],
};