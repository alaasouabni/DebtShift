import { createHash, randomBytes, randomUUID } from 'node:crypto';

import {
  consumeWalletAuthChallenge,
  getWalletAuthChallenge,
  revokeWalletSession,
  storeWalletAuthChallenge,
  touchActiveWalletSession,
} from '@debtshift/database';
import { BadRequestException, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPublicClient, getAddress, http, verifyMessage, type Address, type Hex } from 'viem';
import {
  createSiweMessage,
  parseSiweMessage,
  validateSiweMessage,
  verifySiweMessage,
} from 'viem/siwe';

import { DatabaseService } from './database.service.js';
import {
  walletChallengeRequestSchema,
  walletChallengeVerificationRequestSchema,
} from './http-contracts.js';

export const SESSION_COOKIE_NAME = 'debtshift_session';
const challengeLifetimeMs = 5 * 60 * 1_000;
const sessionLifetimeMs = 8 * 60 * 60 * 1_000;
const signInStatement =
  'Sign in to DebtShift. This proves wallet control and does not authorize a refinance or transaction.';
const sessionTokenPattern = /^[a-zA-Z0-9_-]{43}$/;

export interface AuthenticatedWalletSession {
  readonly sessionHash: string;
  readonly walletAddress: Address;
  readonly chainId: number;
  readonly expiresAt: string;
}

@Injectable()
export class AuthenticationService {
  readonly #database: DatabaseService;
  readonly #chainId: number;
  readonly #domain: string;
  readonly #webPublicUrl: string;
  readonly #apiPublicUrl: string;
  readonly #secureCookie: boolean;
  readonly #sourceClient;

  constructor(
    @Inject(DatabaseService) database: DatabaseService,
    @Inject(ConfigService) config: ConfigService,
  ) {
    this.#database = database;
    this.#chainId = config.getOrThrow<number>('SOURCE_CHAIN_ID');
    this.#webPublicUrl = config.getOrThrow<string>('WEB_PUBLIC_URL');
    this.#apiPublicUrl = config.getOrThrow<string>('API_PUBLIC_URL');
    this.#domain = new URL(this.#webPublicUrl).host;
    this.#secureCookie = new URL(this.#apiPublicUrl).protocol === 'https:';
    this.#sourceClient = createPublicClient({
      transport: http(config.getOrThrow<string>('SOURCE_RPC_URL')),
    });
  }

  async createChallenge(input: unknown) {
    const parsed = walletChallengeRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw new BadRequestException('Wallet must be a valid checksummed or lowercase EVM address.');
    }
    const { wallet } = parsed.data;
    const challengeId = randomUUID();
    const nonce = randomBytes(16).toString('hex');
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + challengeLifetimeMs);
    const message = createSiweMessage({
      address: wallet,
      chainId: this.#chainId,
      domain: this.#domain,
      nonce,
      uri: this.#webPublicUrl,
      version: '1',
      issuedAt,
      expirationTime: expiresAt,
      requestId: challengeId,
      resources: [`${this.#apiPublicUrl.replace(/\/$/, '')}/v1`],
      statement: signInStatement,
    });
    await storeWalletAuthChallenge(this.#database.db, {
      challengeId,
      walletAddress: wallet.toLowerCase(),
      chainId: this.#chainId.toString(),
      nonce,
      message,
      expiresAt,
    });
    return {
      challengeId,
      wallet,
      chainId: this.#chainId,
      message,
      expiresAt: expiresAt.toISOString(),
    };
  }

  async verifyChallenge(input: unknown) {
    const parsed = walletChallengeVerificationRequestSchema.safeParse(input);
    if (!parsed.success)
      throw new BadRequestException(parsed.error.issues.map(({ message }) => message));

    const challenge = await getWalletAuthChallenge(this.#database.db, parsed.data.challengeId);
    const now = new Date();
    if (
      challenge === undefined ||
      challenge.consumedAt !== null ||
      challenge.expiresAt.getTime() <= now.getTime() ||
      challenge.chainId !== this.#chainId.toString()
    ) {
      throw new UnauthorizedException('Authentication challenge is invalid or expired.');
    }

    const walletAddress = getAddress(challenge.walletAddress);
    const signature = parsed.data.signature as Hex;
    const message = parseSiweMessage(challenge.message);
    const expectedResource = `${this.#apiPublicUrl.replace(/\/$/, '')}/v1`;
    const fieldsValid =
      message.chainId === this.#chainId &&
      message.uri === this.#webPublicUrl &&
      message.version === '1' &&
      message.requestId === challenge.challengeId &&
      message.statement === signInStatement &&
      message.expirationTime?.getTime() === challenge.expiresAt.getTime() &&
      message.resources?.length === 1 &&
      message.resources[0] === expectedResource &&
      validateSiweMessage({
        address: walletAddress,
        domain: this.#domain,
        message,
        nonce: challenge.nonce,
        time: now,
      });
    const eoaValid = fieldsValid
      ? await verifyMessage({
          address: walletAddress,
          message: challenge.message,
          signature,
        }).catch(() => false)
      : false;
    const signatureValid =
      eoaValid ||
      (fieldsValid
        ? await verifySiweMessage(this.#sourceClient, {
            address: walletAddress,
            domain: this.#domain,
            message: challenge.message,
            nonce: challenge.nonce,
            signature,
            time: now,
          }).catch(() => false)
        : false);
    if (!signatureValid)
      throw new UnauthorizedException('Wallet authentication signature is invalid.');

    const token = randomBytes(32).toString('base64url');
    const sessionHash = hashSessionToken(token);
    const expiresAt = new Date(now.getTime() + sessionLifetimeMs);
    let session;
    try {
      session = await consumeWalletAuthChallenge(this.#database.db, {
        challengeId: challenge.challengeId,
        sessionHash,
        walletAddress: challenge.walletAddress,
        chainId: challenge.chainId,
        expiresAt,
        now,
      });
    } catch {
      throw new UnauthorizedException('Authentication challenge is invalid or already used.');
    }

    return {
      cookie: serializeSessionCookie(token, sessionLifetimeMs, this.#secureCookie),
      session: publicSession(
        sessionHash,
        session.walletAddress,
        session.chainId,
        session.expiresAt,
      ),
    };
  }

  async authenticate(cookieHeader: string | undefined): Promise<AuthenticatedWalletSession> {
    const token = readSessionCookie(cookieHeader);
    if (token === undefined) throw new UnauthorizedException('Wallet session is required.');
    const sessionHash = hashSessionToken(token);
    const session = await touchActiveWalletSession(this.#database.db, sessionHash, new Date());
    if (session === undefined)
      throw new UnauthorizedException('Wallet session is invalid or expired.');
    return publicSession(sessionHash, session.walletAddress, session.chainId, session.expiresAt);
  }

  async revoke(sessionHash: string): Promise<void> {
    await revokeWalletSession(this.#database.db, sessionHash, new Date());
  }

  clearSessionCookie(): string {
    return serializeSessionCookie('', 0, this.#secureCookie);
  }
}

function publicSession(
  sessionHash: string,
  walletAddress: string,
  chainId: string,
  expiresAt: Date,
): AuthenticatedWalletSession {
  const parsedChainId = Number(chainId);
  if (!Number.isSafeInteger(parsedChainId) || parsedChainId <= 0) {
    throw new Error('Stored wallet session chain is invalid.');
  }
  return {
    sessionHash,
    walletAddress: getAddress(walletAddress),
    chainId: parsedChainId,
    expiresAt: expiresAt.toISOString(),
  };
}

export function readSessionCookie(cookieHeader: string | undefined): string | undefined {
  if (cookieHeader === undefined) return undefined;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name === SESSION_COOKIE_NAME && sessionTokenPattern.test(value)) return value;
  }
  return undefined;
}

function hashSessionToken(token: string): string {
  if (!sessionTokenPattern.test(token))
    throw new UnauthorizedException('Wallet session is invalid.');
  return `0x${createHash('sha256').update(token, 'utf8').digest('hex')}`;
}

function serializeSessionCookie(token: string, lifetimeMs: number, secure: boolean): string {
  const attributes = [
    `${SESSION_COOKIE_NAME}=${token}`,
    'Path=/v1',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(lifetimeMs / 1_000)}`,
  ];
  if (lifetimeMs === 0) attributes.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}
