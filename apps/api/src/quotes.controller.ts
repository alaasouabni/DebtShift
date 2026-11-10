import { Body, Controller, Inject, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { TransportService } from './transport.service.js';

@ApiTags('quotes')
@Controller('quotes')
export class QuotesController {
  constructor(@Inject(TransportService) private readonly transport: TransportService) {}

  @Post()
  @ApiOperation({ summary: 'Create an environment-gated transport quote' })
  createQuote(@Body() body: unknown) {
    return this.transport.getQuote(body);
  }
}
