import { IsString, IsNumber, IsDateString, IsOptional } from 'class-validator';

export class CreateAnalyticsDto {
  @IsString()
  @IsOptional()
  performance_id?: string;

  @IsString()
  campaign_id: string;

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
  cost: number;

  @IsNumber()
  roi: number;

  @IsDateString()
  date: string; 
}