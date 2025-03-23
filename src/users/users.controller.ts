import {
  Controller,
  Get,
  Patch,
  Delete,
  Param,
  Body,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
  UploadedFile
} from '@nestjs/common';
import { UsersService } from './users.service';
import { JwtAuthGuard } from 'src/guards/jwt-auth.guard';
import { UpdateUserDto } from './dto/update-user.dto';
import { FileInterceptor } from '@nestjs/platform-express';

interface AuthenticatedRequest extends Request {
  user: { userId: string; email: string };
}

@Controller('users')
export class UsersController {
  constructor(private readonly userService: UsersService) {}

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  async getUserProfile(@Param('id') id: string) {
    return this.userService.getUserProfile(id);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(FileInterceptor('image'))
  async updateUser(
    @Param('id') id: string,
    @Body() updateUserDto: UpdateUserDto,
    @Req() request: any,
    @UploadedFile() file: Express.Multer.File,
  ) {
    const requesterId = request.user?.user_id;
    return this.userService.updateUser(id, requesterId, updateUserDto, file);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  async deleteUser(
    @Param('id') id: string,
    @Req() request: any,
    @Body('password') password: string,
  ) {
    const requesterId = request.user?.user_id;
    const result = await this.userService.deleteUser(id, requesterId, password);
    request.clearCookie('accessToken');
    request.clearCookie('refreshToken');
    return request.status(200).json(result);
  }

  @Get('profile-completion/:userId')
  @UseGuards(JwtAuthGuard)
  async getProfileCompletion(@Param('userId') userId: string, @Req() req) {
    const percentage = await this.userService.getProfileCompletionPercentage(userId);
    return { completionPercentage: percentage };
  }


}
