import { Body, Controller, Inject, Post, UseGuards } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import { SESSION_COOKIE_NAME, type AuthenticatedWalletSession } from './authentication.service.js';
import {
  errorResponseSchema,
  routeAnalysisRequestSchema,
  routeAnalysisResponseSchema,
  toOpenApiSchema,
} from './http-contracts.js';
import { RouteAnalysisService } from './route-analysis.service.js';
import { CurrentSession, SessionGuard } from './session.guard.js';

@ApiTags('analysis')
@ApiCookieAuth(SESSION_COOKIE_NAME)
@ApiUnauthorizedResponse({ schema: toOpenApiSchema(errorResponseSchema) })
@UseGuards(SessionGuard)
@Controller('analysis')
export class RouteAnalysisController {
  constructor(@Inject(RouteAnalysisService) private readonly analysis: RouteAnalysisService) {}

  @Post('routes')
  @ApiOperation({
    summary: 'Compare deterministic refinance routes and optionally explain the fixed result',
  })
  @ApiBody({ schema: toOpenApiSchema(routeAnalysisRequestSchema) })
  @ApiCreatedResponse({ schema: toOpenApiSchema(routeAnalysisResponseSchema) })
  @ApiBadRequestResponse({ schema: toOpenApiSchema(errorResponseSchema) })
  @ApiForbiddenResponse({ schema: toOpenApiSchema(errorResponseSchema) })
  analyzeRoutes(@Body() body: unknown, @CurrentSession() session: AuthenticatedWalletSession) {
    return this.analysis.analyze(body, session.walletAddress);
  }
}
