import { Body, Controller, Inject, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { RouteAnalysisService } from './route-analysis.service.js';

@ApiTags('analysis')
@Controller('analysis')
export class RouteAnalysisController {
  constructor(@Inject(RouteAnalysisService) private readonly analysis: RouteAnalysisService) {}

  @Post('routes')
  @ApiOperation({
    summary: 'Compare deterministic refinance routes and optionally explain the fixed result',
  })
  analyzeRoutes(@Body() body: unknown) {
    return this.analysis.analyze(body);
  }
}
