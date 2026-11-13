import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Query,
  Sse,
  UseGuards,
  type MessageEvent,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Observable } from 'rxjs';
import { getAddress } from 'viem';

import { SESSION_COOKIE_NAME, type AuthenticatedWalletSession } from './authentication.service.js';
import {
  bytes32ContractSchema,
  errorResponseSchema,
  evmAddressContractSchema,
  executeMigrationRequestSchema,
  executeMigrationResponseSchema,
  marketListResponseSchema,
  migrationDetailsResponseSchema,
  migrationEvidenceResponseSchema,
  migrationEventsResponseSchema,
  persistedPositionListResponseSchema,
  positionSnapshotListResponseSchema,
  preparationRequestSchema,
  preparationResponseSchema,
  toOpenApiSchema,
} from './http-contracts.js';
import { MigrationsService } from './migrations.service.js';
import { PreparationService } from './preparation.service.js';
import { assertSessionWallet, CurrentSession, SessionGuard } from './session.guard.js';

@ApiTags('migrations')
@ApiCookieAuth(SESSION_COOKIE_NAME)
@ApiUnauthorizedResponse({ schema: toOpenApiSchema(errorResponseSchema) })
@UseGuards(SessionGuard)
@Controller()
export class MigrationsController {
  constructor(
    @Inject(MigrationsService) private readonly migrations: MigrationsService,
    @Inject(PreparationService) private readonly preparation: PreparationService,
  ) {}

  @Get('positions/:wallet')
  @ApiOperation({ summary: 'List persisted lending positions for a wallet' })
  @ApiParam({ name: 'wallet', schema: toOpenApiSchema(evmAddressContractSchema) })
  @ApiOkResponse({ schema: toOpenApiSchema(positionSnapshotListResponseSchema) })
  @ApiBadRequestResponse({ schema: toOpenApiSchema(errorResponseSchema) })
  @ApiForbiddenResponse({ schema: toOpenApiSchema(errorResponseSchema) })
  async listPositions(
    @Param('wallet') wallet: string,
    @CurrentSession() session: AuthenticatedWalletSession,
  ) {
    const walletAddress = parseWalletAddress(wallet);
    assertSessionWallet(session, walletAddress);
    return [await this.preparation.getPosition(walletAddress)];
  }

  @Get('positions/:wallet/history')
  @ApiOperation({ summary: 'List persisted source position history for a wallet' })
  @ApiParam({ name: 'wallet', schema: toOpenApiSchema(evmAddressContractSchema) })
  @ApiOkResponse({ schema: toOpenApiSchema(persistedPositionListResponseSchema) })
  @ApiBadRequestResponse({ schema: toOpenApiSchema(errorResponseSchema) })
  @ApiForbiddenResponse({ schema: toOpenApiSchema(errorResponseSchema) })
  listPersistedPositions(
    @Param('wallet') wallet: string,
    @CurrentSession() session: AuthenticatedWalletSession,
  ) {
    const walletAddress = parseWalletAddress(wallet);
    assertSessionWallet(session, walletAddress);
    return this.migrations.listPositions(walletAddress);
  }

  @Get('markets')
  @ApiOperation({ summary: 'List enabled destination and source markets' })
  @ApiOkResponse({ schema: toOpenApiSchema(marketListResponseSchema) })
  listMarkets() {
    return this.migrations.listMarkets();
  }

  @Post('migrations/execute')
  @ApiOperation({ summary: 'Validate authorizations and durably start a migration' })
  @ApiBody({ schema: toOpenApiSchema(executeMigrationRequestSchema) })
  @ApiCreatedResponse({ schema: toOpenApiSchema(executeMigrationResponseSchema) })
  @ApiBadRequestResponse({ schema: toOpenApiSchema(errorResponseSchema) })
  @ApiForbiddenResponse({ schema: toOpenApiSchema(errorResponseSchema) })
  execute(@Body() body: unknown, @CurrentSession() session: AuthenticatedWalletSession) {
    return this.migrations.execute(body, session.walletAddress);
  }

  @Post('migrations/prepare')
  @ApiOperation({ summary: 'Prepare an exact local route for borrower EIP-712 review' })
  @ApiBody({ schema: toOpenApiSchema(preparationRequestSchema) })
  @ApiCreatedResponse({ schema: toOpenApiSchema(preparationResponseSchema) })
  @ApiBadRequestResponse({ schema: toOpenApiSchema(errorResponseSchema) })
  @ApiForbiddenResponse({ schema: toOpenApiSchema(errorResponseSchema) })
  prepare(@Body() body: unknown, @CurrentSession() session: AuthenticatedWalletSession) {
    return this.preparation.prepare(body, session.walletAddress);
  }

  @Get('migrations/:migrationId')
  @ApiOperation({ summary: 'Read migration state, evidence, events, commands, and ledger' })
  @ApiParam({ name: 'migrationId', schema: toOpenApiSchema(bytes32ContractSchema) })
  @ApiOkResponse({ schema: toOpenApiSchema(migrationDetailsResponseSchema) })
  @ApiNotFoundResponse({ schema: toOpenApiSchema(errorResponseSchema) })
  getMigration(
    @Param('migrationId') migrationId: string,
    @CurrentSession() session: AuthenticatedWalletSession,
  ) {
    return this.migrations.getMigration(migrationId, session.walletAddress);
  }

  @Get('migrations/:migrationId/events')
  @ApiOperation({ summary: 'Read authoritative migration event history' })
  @ApiParam({ name: 'migrationId', schema: toOpenApiSchema(bytes32ContractSchema) })
  @ApiOkResponse({ schema: toOpenApiSchema(migrationEventsResponseSchema) })
  @ApiNotFoundResponse({ schema: toOpenApiSchema(errorResponseSchema) })
  async getEvents(
    @Param('migrationId') migrationId: string,
    @CurrentSession() session: AuthenticatedWalletSession,
  ) {
    return (await this.migrations.getMigration(migrationId, session.walletAddress)).events;
  }

  @Sse('migrations/:migrationId/stream')
  @ApiOperation({ summary: 'Stream cursor-resumable authoritative migration events' })
  @ApiProduces('text/event-stream')
  @ApiParam({ name: 'migrationId', schema: toOpenApiSchema(bytes32ContractSchema) })
  @ApiQuery({
    name: 'after',
    required: false,
    schema: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' },
  })
  @ApiHeader({
    name: 'Last-Event-ID',
    required: false,
    schema: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' },
  })
  @ApiOkResponse({
    content: { 'text/event-stream': { schema: { type: 'string' } } },
  })
  @ApiBadRequestResponse({ schema: toOpenApiSchema(errorResponseSchema) })
  @ApiNotFoundResponse({ schema: toOpenApiSchema(errorResponseSchema) })
  streamEvents(
    @Param('migrationId') migrationId: string,
    @Query('after') after: string | undefined,
    @Headers('last-event-id') lastEventId: string | undefined,
    @CurrentSession() session: AuthenticatedWalletSession,
  ): Promise<Observable<MessageEvent>> {
    return this.migrations.streamMigrationEvents(
      migrationId,
      parseMigrationEventCursor(after, lastEventId),
      session.walletAddress,
    );
  }

  @Get('migrations/:migrationId/evidence')
  @ApiOperation({ summary: 'Read normalized migration evidence' })
  @ApiParam({ name: 'migrationId', schema: toOpenApiSchema(bytes32ContractSchema) })
  @ApiOkResponse({ schema: toOpenApiSchema(migrationEvidenceResponseSchema) })
  @ApiNotFoundResponse({ schema: toOpenApiSchema(errorResponseSchema) })
  async getEvidence(
    @Param('migrationId') migrationId: string,
    @CurrentSession() session: AuthenticatedWalletSession,
  ) {
    return (await this.migrations.getMigration(migrationId, session.walletAddress)).evidence;
  }
}

function parseWalletAddress(wallet: string) {
  try {
    return getAddress(wallet);
  } catch {
    throw new BadRequestException('Wallet route parameter must be a valid EVM address.');
  }
}

export function parseMigrationEventCursor(
  queryCursor: string | undefined,
  lastEventId: string | undefined,
): number {
  const values = [queryCursor, lastEventId].filter(
    (value): value is string => value !== undefined && value.length > 0,
  );
  if (values.length === 0) return 0;
  const parsed = values.map((value) => {
    if (!/^(0|[1-9][0-9]*)$/.test(value)) {
      throw new BadRequestException('Migration event cursor must be a non-negative integer.');
    }
    const cursor = Number(value);
    if (!Number.isSafeInteger(cursor) || cursor > 2_147_483_647) {
      throw new BadRequestException('Migration event cursor is outside the supported range.');
    }
    return cursor;
  });
  return Math.max(...parsed);
}
