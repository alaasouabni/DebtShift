import { Body, Controller, Inject, Post, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { SESSION_COOKIE_NAME } from './authentication.service.js';
import { SessionGuard } from './session.guard.js';
import { TransportService } from './transport.service.js';

@ApiTags('quotes')
@ApiCookieAuth(SESSION_COOKIE_NAME)
@UseGuards(SessionGuard)
@Controller('quotes')
export class QuotesController {
  constructor(@Inject(TransportService) private readonly transport: TransportService) {}

  @Post()
  @ApiOperation({ summary: 'Create an environment-gated transport quote' })
  createQuote(@Body() body: unknown) {
    return this.transport.getQuote(body);
  }
}
