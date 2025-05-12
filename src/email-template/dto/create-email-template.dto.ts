// create-email-template.dto.ts
import { IsString, IsNotEmpty, IsOptional, IsBoolean } from 'class-validator';

export class CreateEmailTemplateDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  subject: string;

  @IsString()
  @IsNotEmpty()
  body: string;

  @IsBoolean()
  @IsOptional()
  isActive?: boolean;
}

