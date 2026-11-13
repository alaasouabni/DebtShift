import { Body, Controller, Inject, Post, UseGuards } from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { SESSION_COOKIE_NAME, type AuthenticatedWalletSession } from './authentication.service.js';
import { RouteAnalysisService } from './route-analysis.service.js';
import { CurrentSession, SessionGuard } from './session.guard.js';

@ApiTags('analysis')
@ApiCookieAuth(SESSION_COOKIE_NAME)
@UseGuards(SessionGuard)
@Controller('analysis')
export class RouteAnalysisController {
  constructor(@Inject(RouteAnalysisService) private readonly analysis: RouteAnalysisService) {}

  @Post('routes')
  @ApiOperation({
    summary: 'Compare deterministic refinance routes and optionally explain the fixed result',
  })
  analyzeRoutes(@Body() body: unknown, @CurrentSession() session: AuthenticatedWalletSession) {
    return this.analysis.analyze(body, session.walletAddress);
  }
}
