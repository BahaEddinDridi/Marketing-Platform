import { Controller, Get, Patch, Delete, Param, Body, Req, Res, UseGuards } from '@nestjs/common';
import { UsersService } from './users.service';
import { JwtAuthGuard } from 'src/guards/jwt-auth.guard';
import { UpdateUserDto } from './dto/update-user.dto';

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
  async updateUser(
    @Param('id') id: string,
    @Body() updateUserDto: UpdateUserDto,
    @Req() request: any,
  ) {
    const requesterId = request.user?.user_id;
    return this.userService.updateUser(id, requesterId, updateUserDto);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  async deleteUser(@Param('id') id: string, @Req() req: AuthenticatedRequest, @Req() request: any,) {
    const requesterId = request.user?.user_id;
    const result = await this.userService.deleteUser(id, requesterId);
    request.clearCookie('accessToken');
    request.clearCookie('refreshToken');
    return request.status(200).json(result);
  }
}
