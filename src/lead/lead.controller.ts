import { Controller, Get, Post, Body, Patch, Param, Delete, UseGuards, Req, Res, UnauthorizedException  } from '@nestjs/common';
import { LeadService } from './lead.service';
import { CreateLeadDto } from './dto/create-lead.dto';
import { UpdateLeadDto } from './dto/update-lead.dto';
import { JwtAuthGuard } from 'src/guards/jwt-auth.guard';
import { AuthGuard } from '@nestjs/passport';

@Controller('lead')
export class LeadController {
  constructor(private readonly leadService: LeadService) {
    console.log('LeadController: Initialized');
  }

  @Post()
  @UseGuards(JwtAuthGuard)
  create(@Body() createLeadDto: CreateLeadDto) {
    return this.leadService.create(createLeadDto);
  }

  @Get()
  findAll() {
    return this.leadService.findAll();
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  findOne(@Param('id') id: string) {
    return this.leadService.findOne(id); 
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  update(@Param('id') id: string, @Body() updateLeadDto: UpdateLeadDto) {
    return this.leadService.update(id, updateLeadDto); 
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  remove(@Param('id') id: string) {
    return this.leadService.remove(id);
  }

  @Get('fetch')
  @UseGuards(JwtAuthGuard)
  async fetchEmails(@Req() req) {
    console.log('LeadController: Entering fetchEmails', { user: req.user });
    if (!req.user?.user_id) {
      console.log('LeadController: No user_id in req.user');
      throw new UnauthorizedException('User not authenticated');
    }
    try {
      const result = await this.leadService.fetchEmails(req.user.user_id);
      console.log('LeadController: Result:', result);
      return result || { error: 'No data returned from service' }; // Ensure a response
    } catch (error) {
      console.error('LeadController: Error:', error.message);
      throw error;
    }
  }

  @Get('test-fetch')
  @UseGuards(JwtAuthGuard)
  async initiateTestFetch(@Req() req) {
    console.log('LeadController: Initiating test fetch', { user: req.user });
    if (!req.user?.user_id) {
      console.log('LeadController: No user_id in req.user');
      throw new UnauthorizedException('User not authenticated');
    }
    const redirectUrl = 'http://localhost:5000/auth/microsoft/test';
    console.log('LeadController: Returning redirectUrl:', redirectUrl);
    return { redirectUrl };
  }

}
