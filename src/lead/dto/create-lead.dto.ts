import { IsString, IsInt } from 'class-validator';

export class CreateLeadDto {
  @IsString()
  name: string;

  @IsInt()
  phone: number;

  @IsString()
  company: string;
}
