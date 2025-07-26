import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  Query,
  BadRequestException,
} from '@nestjs/common';
import { AnalyticsService } from './analytics.service';
import { CreateAnalyticsDto } from './dto/create-analytics.dto';
import { UpdateAnalyticsDto } from './dto/update-analytics.dto';
import { JwtAuthGuard } from 'src/guards/jwt-auth.guard';

@Controller('analytics')
export class AnalyticsController {
  constructor(private readonly analyticsService: AnalyticsService) {}

  @Get('dashboard')
  @UseGuards(JwtAuthGuard)
  async getDashboardData(
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('sections') sections?: string,
    @Query('limit') limit: string = '5',
    @Query('offset') offset: string = '0',
  ) {
    if (!startDate || !endDate) {
      throw new BadRequestException('startDate and endDate are required');
    }

    // Validate and parse query parameters
    const parsedLimit = parseInt(limit, 10);
    const parsedOffset = parseInt(offset, 10);
    if (isNaN(parsedLimit) || parsedLimit < 0) {
      throw new BadRequestException('limit must be a non-negative integer');
    }
    if (isNaN(parsedOffset) || parsedOffset < 0) {
      throw new BadRequestException('offset must be a non-negative integer');
    }
    const sectionList = sections ? sections.split(',') : [];

    return this.analyticsService.getDashboardData(
      new Date(startDate),
      new Date(endDate),
      sectionList
    );
  }

  @Get('platform-configs')
  @UseGuards(JwtAuthGuard)
  async getPlatformConfigs() {
    return this.analyticsService.getPlatformConfigs();
  }
  
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
