import { Provider } from '@nestjs/common';
import { MicrosoftLeadsStrategy } from '../strategies/microsoft-leads.strategy';
import { MicrosoftAuthConfigService } from '../strategies/microsoft-auth-config.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { AuthService } from 'src/auth/auth.service';

export const MicrosoftLeadsStrategyProvider: Provider = {
  provide: 'MICROSOFT_LEADS_STRATEGY',
  useFactory: async (
    authService: AuthService,
    configService: MicrosoftAuthConfigService,
    prisma: PrismaService,
  ) => {
    const config = await configService.getConfig();
    if (!config) {
      console.warn('Skipping MicrosoftStrategy initialization: No credentials available');
      return null; // Skip strategy initialization
    }
    return new MicrosoftLeadsStrategy(authService, config, prisma);
  },
  inject: [AuthService, MicrosoftAuthConfigService, PrismaService],
};
