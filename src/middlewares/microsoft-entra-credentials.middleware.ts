import { Injectable, NestMiddleware, InternalServerErrorException } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { PrismaService } from '../prisma/prisma.service'; // Adjust path

@Injectable()
export class MicrosoftEntraCredentialsMiddleware implements NestMiddleware {
  constructor(private readonly prisma: PrismaService) {}

  async use(req: Request, res: Response, next: NextFunction) {
    const org = await this.prisma.organization.findUnique({
      where: { id: 'single-org' },
      select: { microsoftEntraCreds: true },
    });

    if (!org || !org.microsoftEntraCreds) {
      throw new InternalServerErrorException('Microsoft Entra credentials not found in database');
    }

    const { clientId, clientSecret, tenantId } = org.microsoftEntraCreds as {
      clientId: string;
      clientSecret: string;
      tenantId: string;
    };

    if (!clientId || !clientSecret || !tenantId) {
      throw new InternalServerErrorException('Invalid Microsoft Entra credentials in database');
    }

    req.microsoftEntraCreds = { clientId, clientSecret, tenantId };
    next();
  }
}


declare global {
  namespace Express {
    interface Request {
      microsoftEntraCreds?: {
        clientId: string;
        clientSecret: string;
        tenantId: string;
      };
    }
  }
}