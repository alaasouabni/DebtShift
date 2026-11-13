import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import {
  AuthenticationService,
  SESSION_COOKIE_NAME,
  type AuthenticatedWalletSession,
} from './authentication.service.js';
import { CurrentSession, SessionGuard } from './session.guard.js';

interface HeaderResponse {
  setHeader(name: string, value: string): void;
}

@ApiTags('authentication')
@Controller('auth')
export class AuthenticationController {
  constructor(
    @Inject(AuthenticationService) private readonly authentication: AuthenticationService,
  ) {}

  @Post('challenge')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Create a short-lived one-time EIP-4361 wallet challenge' })
  createChallenge(@Body() body: unknown) {
    return this.authentication.createChallenge(body);
  }

  @Post('verify')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Verify wallet control and set an opaque HttpOnly session cookie' })
  async verify(@Body() body: unknown, @Res({ passthrough: true }) response: HeaderResponse) {
    const result = await this.authentication.verifyChallenge(body);
    response.setHeader('Set-Cookie', result.cookie);
    return { session: publicSession(result.session) };
  }

  @Get('session')
  @UseGuards(SessionGuard)
  @ApiCookieAuth(SESSION_COOKIE_NAME)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Read the active wallet session' })
  session(@CurrentSession() session: AuthenticatedWalletSession) {
    return { session: publicSession(session) };
  }

  @Post('logout')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  @ApiCookieAuth(SESSION_COOKIE_NAME)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Revoke the active wallet session and clear its cookie' })
  async logout(
    @CurrentSession() session: AuthenticatedWalletSession,
    @Res({ passthrough: true }) response: HeaderResponse,
  ) {
    await this.authentication.revoke(session.sessionHash);
    response.setHeader('Set-Cookie', this.authentication.clearSessionCookie());
    return { revoked: true };
  }
}

function publicSession(session: AuthenticatedWalletSession) {
  return {
    wallet: session.walletAddress,
    chainId: session.chainId,
    expiresAt: session.expiresAt,
  };
}
