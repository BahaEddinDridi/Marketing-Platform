import { Injectable } from '@nestjs/common';

export interface LinkedInOAuthConfig {
  clientID: string;
  clientSecret: string;
}

@Injectable()
export class LinkedInAuthConfigService {
  constructor(
    public readonly clientID: string,
    public readonly clientSecret: string,
  ) {}
}