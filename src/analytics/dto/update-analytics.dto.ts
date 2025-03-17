import { IsString, IsNumber, IsDateString, IsOptional } from 'class-validator';

export class UpdateAnalyticsDto {
  @IsString()
  @IsOptional()
  performance_id?: string;

  @IsString()
  @IsOptional()
  campaign_id?: string;

  @IsNumber()
  @IsOptional()
  clicks?: number;

  @IsNumber()
  @IsOptional()
  impressions?: number;

  @IsNumber()
  @IsOptional()
  conversions?: number;

  @IsNumber()
  @IsOptional()
  cost?: number;

  @IsNumber()
  @IsOptional()
  roi?: number;

  @IsDateString()
  @IsOptional()
  date?: string;
}