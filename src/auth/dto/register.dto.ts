import { 
    IsEmail, 
    IsNotEmpty, 
    MinLength, 
    MaxLength, 
    Matches 
  } from 'class-validator';
  
  export class RegisterDto {
    @IsNotEmpty({ message: 'First name is required' })
    @MinLength(2, { message: 'First name must be at least 2 characters long' })
    @MaxLength(50, { message: 'First name must be at most 50 characters long' })
    firstName: string;
  
    @IsNotEmpty({ message: 'Last name is required' })
    @MinLength(2, { message: 'Last name must be at least 2 characters long' })
    @MaxLength(50, { message: 'Last name must be at most 50 characters long' })
    lastName: string;
  
    @IsNotEmpty({ message: 'Email is required' })
    @IsEmail({}, { message: 'Invalid email format' })
    email: string;
  
    @IsNotEmpty({ message: 'Password is required' })
    @MinLength(8, { message: 'Password must be at least 8 characters long' })
    @MaxLength(30, { message: 'Password must be at most 30 characters long' })
    @Matches(/[A-Z]/, { message: 'Password must contain at least one uppercase letter' })
    @Matches(/[a-z]/, { message: 'Password must contain at least one lowercase letter' })
    @Matches(/\d/, { message: 'Password must contain at least one number' })
    password: string;
  }
  