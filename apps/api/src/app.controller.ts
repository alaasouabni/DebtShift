import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';

import { healthResponseSchema, toOpenApiSchema } from './http-contracts.js';

interface HealthResponse {
  readonly service: 'debtshift-api';
  readonly status: 'ok';
  readonly timestamp: string;
}

@ApiTags('system')
@Controller()
export class AppController {
  @Get('health')
  @ApiOperation({ summary: 'Read process health' })
  @ApiOkResponse({
    description: 'The API process is healthy.',
    schema: toOpenApiSchema(healthResponseSchema),
  })
  getHealth(): HealthResponse {
    return {
      service: 'debtshift-api',
      status: 'ok',
      timestamp: new Date().toISOString(),
    };
  }
}
