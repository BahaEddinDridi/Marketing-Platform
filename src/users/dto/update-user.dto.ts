import { IsString, IsOptional, IsDateString, Matches, Length } from 'class-validator';

export class UpdateUserDto {
  @IsString()
  @IsOptional()
  @Length(1, 50, { message: 'First name must be between 1 and 50 characters' })
  firstName?: string;

  @IsString()
  @IsOptional()
  @Length(1, 50, { message: 'Last name must be between 1 and 50 characters' })
  lastName?: string;

  @IsString()
  @IsOptional()
  @Matches(/^\+[1-9]\d{1,14}$/, {
    message: 'Phone number must be in international format (e.g., +1234567890)',
  })
  phoneNumber?: string;

  @IsString()
  @IsOptional()
  @Length(1, 100, { message: 'Street must be between 1 and 100 characters' })
  street?: string;

  @IsString()
  @IsOptional()
  @Length(1, 50, { message: 'City must be between 1 and 50 characters' })
  city?: string;

  @IsString()
  @IsOptional()
  @Length(1, 50, { message: 'State must be between 1 and 50 characters' })
  state?: string;

  @IsString()
  @IsOptional()
  @Matches(/^\d{5}(-\d{4})?$/, {
    message: 'Zip code must be in the format 12345 or 12345-6789',
  })
  zipCode?: string;

  @IsString()
  @IsOptional()
  @Length(1, 50, { message: 'Country must be between 1 and 50 characters' })
  country?: string;

  @IsDateString()
  @IsOptional()
  birthdate?: string;

  @IsString()
  @IsOptional()
  @Length(1, 50, { message: 'Occupation must be between 1 and 50 characters' })
  occupation?: string;
}