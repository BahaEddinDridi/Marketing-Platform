import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
} from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { CreateAnalyticsDto } from './dto/create-analytics.dto';
import { UpdateAnalyticsDto } from './dto/update-analytics.dto';
import { JwtAuthGuard } from 'src/guards/jwt-auth.guard';

@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Post()
  @UseGuards(JwtAuthGuard)
  create(@Body() createAnalyticsDto: CreateAnalyticsDto) {
    return this.analyticsService.create(createAnalyticsDto);
  }

  @Get()
  @UseGuards(JwtAuthGuard)
  findAll() {
    return this.analyticsService.findAll();
  }

  @Get(':id')
  @UseGuards(JwtAuthGuard)
  findOne(@Param('id') id: string) {
    return this.analyticsService.findOne(id);
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard)
  update(
    @Param('id') id: string,
    @Body() updateAnalyticsDto: UpdateAnalyticsDto,
  ) {
    return this.analyticsService.update(id, updateAnalyticsDto);
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard)
  remove(@Param('id') id: string) {
    return this.analyticsService.remove(id);
  }
}
