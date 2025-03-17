import { IsString, IsNumber, IsDateString, IsEnum, IsOptional } from 'class-validator';

export enum CampaignStatus {
  ACTIVE = 'ACTIVE',
  PAUSED = 'PAUSED',
  COMPLETED = 'COMPLETED',
}

export class CreateCampaignDto {
  @IsString()
  @IsOptional()
  campaign_id?: string; 

  @IsString()
  campaign_name: string;

  @IsString()
  @IsOptional()
  platform_id: string;

  @IsNumber()
  budget: number;

  @IsDateString()
  start_date: string;

  @IsDateString()
  @IsOptional()
  end_date?: string; 

  @IsEnum(CampaignStatus)
  status: CampaignStatus;
}