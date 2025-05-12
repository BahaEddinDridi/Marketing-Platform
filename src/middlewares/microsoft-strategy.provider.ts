import { Provider } from '@nestjs/common';
import { MicrosoftStrategy } from '../strategies/microsoft.strategy';
import { MicrosoftAuthConfigService } from '../strategies/microsoft-auth-config.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { AuthService } from 'src/auth/auth.service';

export const MicrosoftStrategyProvider: Provider = {
  provide: 'MICROSOFT_STRATEGY',
  useFactory: async (
    authService: AuthService,
    authConfigService: MicrosoftAuthConfigService,
    prisma: PrismaService,
  ) => {
    const config = await authConfigService.getConfig();
    return new MicrosoftStrategy(authService, config, prisma);
  },
  inject: [AuthService, MicrosoftAuthConfigService, PrismaService],
};
