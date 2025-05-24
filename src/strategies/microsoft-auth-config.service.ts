// src/strategies/microsoft-auth-config.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { AuthService } from 'src/auth/auth.service';

export interface MicrosoftOAuthConfig {
  clientID: string;
  clientSecret: string;
  tenantID: string;
}

@Injectable()
export class MicrosoftAuthConfigService {
  private readonly logger = new Logger(MicrosoftAuthConfigService.name);

  constructor(private readonly authService: AuthService) {}

  async getConfig(): Promise<MicrosoftOAuthConfig | null> {
    try {
      const creds = await this.authService.getEntraCredentials();
      return {
        clientID: creds.clientId,
        clientSecret: creds.clientSecret,
        tenantID: creds.tenantId,
      };
    } catch (error) {
      this.logger.warn('No Microsoft Entra credentials found in database, skipping configuration');
      return null; // Return null instead of throwing an error
    }
  }
}