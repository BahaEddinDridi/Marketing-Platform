import { Injectable, Logger } from '@nestjs/common';

export interface LinkedInOAuthConfig {
  clientID: string;
  clientSecret: string;
}

@Injectable()
export class LinkedInAuthConfigService {
  private readonly logger = new Logger(LinkedInAuthConfigService.name);
  constructor(
    public readonly clientID: string,
    public readonly clientSecret: string,
  ) {
    if (!clientID || !clientSecret) {
      this.logger.warn('LinkedInAuthConfigService initialized with missing credentials');
    }
  }
}