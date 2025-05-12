import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { AuthService } from 'src/auth/auth.service';

export interface MicrosoftOAuthConfig {
  clientID: string;
  clientSecret: string;
  tenantID: string;
}

@Injectable()
export class MicrosoftAuthConfigService {
  constructor(private readonly authService: AuthService) {}

  async getConfig(): Promise<MicrosoftOAuthConfig> {
    const creds = await this.authService.getEntraCredentials();

    return {
      clientID: creds.clientId,
      clientSecret: creds.clientSecret,
      tenantID: creds.tenantId,
    };
  }
}
