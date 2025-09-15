import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';

@Injectable()
export class OrganizationService {
  constructor(private readonly prisma: PrismaService) {}

  async createOrganization(tenantId: string, email: string) {
    const domain = email.split('@')[1].toLowerCase();
    const org = await this.prisma.organization.create({
      data: {
        name: `${domain} Org`,
        tenantId,
        sharedMailbox: `marketing@${domain}`,
      },
    });
    return org;
  }

  async getOrganizationByTenantId(tenantId: string) {
    return this.prisma.organization.findFirst({ where: { tenantId } });
  }

  async getOrganization(orgId: string) {
  const organization = await this.prisma.organization.findUnique({
    where: { id: orgId },
    include: { leadConfig: true },
  });

  if (!organization) {
    return null;
  }

  // Format leadConfig.folders for frontend
  const formattedLeadConfig = organization.leadConfig
    ? {
        ...organization.leadConfig,
        folders: Object.fromEntries(
          Object.entries(organization.leadConfig.folders || {}).map(([email, folders]) => [
            email.toLowerCase(),
            Array.isArray(folders)
              ? folders.filter((f: any) => f && typeof f === 'object' && 'id' in f && 'name' in f)
              : [],
          ]),
        ),
      }
    : null;

  return {
    ...organization,
    leadConfig: formattedLeadConfig,
  };
}

  async updateOrganization(
    orgId: string,
    data: { name: string; sharedMailbox: string },
  ) {
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
    });
    if (!org)
      throw new HttpException('Organization not found', HttpStatus.NOT_FOUND);

    return this.prisma.organization.update({
      where: { id: orgId },
      data,
    });
  }

  async inviteUser(orgId: string, email: string, inviterRole: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
    });
    if (!org)
      throw new HttpException('Organization not found', HttpStatus.NOT_FOUND);

    const orgDomain = org.name.split(' ')[1].toLowerCase();
    if (!email.endsWith(`@${orgDomain}`)) {
      throw new HttpException(
        'Email domain must match organization',
        HttpStatus.BAD_REQUEST,
      );
    }

    const existingUser = await this.prisma.user.findUnique({
      where: { email },
    });
    if (existingUser) {
      throw new HttpException('User already exists', HttpStatus.CONFLICT);
    }
    console.log(`Inviting ${email} to org ${orgId} by ${inviterRole}`);
    return { message: `Invite sent to ${email}` };
  }

  async getOrganizationMembers(orgId: string) {
    const org = await this.prisma.organization.findUnique({
      where: { id: orgId },
    });
    if (!org)
      throw new HttpException('Organization not found', HttpStatus.NOT_FOUND);

    const members = await this.prisma.user.findMany({
      where: {
        orgId: orgId,
      },
      select: {
        user_id: true,
        firstName: true,
        lastName: true,
        email: true,
        profileImage: true,
        role: true,
        allowPersonalEmailSync: true,
        status: true,
        password: true,
      },
    });

    // Map members to include hasPassword flag
    return members.map((member) => ({
      user_id: member.user_id,
      firstName: member.firstName,
      lastName: member.lastName,
      email: member.email,
      profileImage: member.profileImage,
      role: member.role,
      allowPersonalEmailSync: member.allowPersonalEmailSync,
      status: member.status,
      hasPassword: !!member.password, 
    }));
  }
}
