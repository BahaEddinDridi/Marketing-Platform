import { IsString, IsNumber, IsDateString, IsEnum, IsOptional } from 'class-validator';
import { CampaignStatus } from './create-campaign.dto'; 

export class UpdateCampaignDto {
  @IsString()
  @IsOptional()
  campaign_id?: string;

  @IsString()
  @IsOptional()
  campaign_name?: string;

  @IsString()
  @IsOptional()
  platform_id?: string;

  @IsNumber()
  @IsOptional()
  budget?: number;

  @IsDateString()
  @IsOptional()
  start_date?: string;

  @IsDateString()
  @IsOptional()
  end_date?: string;

  @IsEnum(CampaignStatus)
  @IsOptional()
  status?: CampaignStatus;
}