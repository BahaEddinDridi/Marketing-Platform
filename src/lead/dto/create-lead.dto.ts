import { IsString, IsOptional, IsEmail, IsEnum } from 'class-validator';

export enum LeadStatus {
  NEW = 'NEW',
  CONTACTED = 'CONTACTED',
  IN_PROGRESS = 'IN_PROGRESS',
  CONVERTED = 'CONVERTED',
  CLOSED = 'CLOSED',
}

export class CreateLeadDto {
  lead_id: string;  

  @IsString()
  name: string;

  @IsString()
  @IsOptional()
  phone?: string;  

  @IsString()
  @IsOptional()
  company?: string;

  @IsString()
  @IsOptional()
  job_title?: string; 

  @IsEnum(LeadStatus)
  status: LeadStatus;

  @IsEmail()
  email: string;

  @IsString()
  source_platform: string; 
}
