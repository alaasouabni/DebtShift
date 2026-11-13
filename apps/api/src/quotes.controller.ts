import { Body, Controller, Inject, Post, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { SESSION_COOKIE_NAME } from './authentication.service.js';
import {
  errorResponseSchema,
  quoteRequestSchema,
  quoteResponseSchema,
  toOpenApiSchema,
} from './http-contracts.js';
import { SessionGuard } from './session.guard.js';
import { TransportService } from './transport.service.js';

@ApiTags('quotes')
@ApiCookieAuth(SESSION_COOKIE_NAME)
@ApiUnauthorizedResponse({ schema: toOpenApiSchema(errorResponseSchema) })
@UseGuards(SessionGuard)
@Controller('quotes')
export class QuotesController {
  constructor(@Inject(TransportService) private readonly transport: TransportService) {}

  @Post()
  @ApiOperation({ summary: 'Create an environment-gated transport quote' })
  @ApiBody({ schema: toOpenApiSchema(quoteRequestSchema) })
  @ApiCreatedResponse({ schema: toOpenApiSchema(quoteResponseSchema) })
  @ApiBadRequestResponse({ schema: toOpenApiSchema(errorResponseSchema) })
  createQuote(@Body() body: unknown) {
    return this.transport.getQuote(body);
  }
}
