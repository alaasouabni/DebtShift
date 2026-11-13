import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
  createParamDecorator,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { isAddressEqual, type Address } from 'viem';

import {
  AuthenticationService,
  type AuthenticatedWalletSession,
} from './authentication.service.js';

interface SessionRequest {
  readonly headers: { readonly cookie?: string };
  debtShiftSession?: AuthenticatedWalletSession;
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    @Inject(AuthenticationService) private readonly authentication: AuthenticationService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<SessionRequest>();
    request.debtShiftSession = await this.authentication.authenticate(request.headers.cookie);
    return true;
  }
}

export const CurrentSession = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedWalletSession => {
    const request = context.switchToHttp().getRequest<SessionRequest>();
    if (request.debtShiftSession === undefined) {
      throw new UnauthorizedException('Wallet session is required.');
    }
    return request.debtShiftSession;
  },
);

export function assertSessionWallet(session: AuthenticatedWalletSession, wallet: Address): void {
  if (!isAddressEqual(session.walletAddress, wallet)) {
    throw new ForbiddenException('Wallet session does not match the requested borrower.');
  }
}
