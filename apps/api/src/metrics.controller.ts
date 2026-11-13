import { Controller, Get, Header, Inject } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';

import { MetricsService } from './metrics.service.js';

@ApiTags('system')
@Controller()
export class MetricsController {
  constructor(@Inject(MetricsService) private readonly metrics: MetricsService) {}

  @Get('metrics')
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  @ApiOperation({ summary: 'Read low-cardinality Prometheus operational metrics' })
  @ApiProduces('text/plain')
  @ApiOkResponse({ description: 'Prometheus text exposition backed by PostgreSQL.' })
  render(): Promise<string> {
    return this.metrics.render();
  }
}
