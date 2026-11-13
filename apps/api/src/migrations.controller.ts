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
  type MessageEvent,
} from '@nestjs/common';
import { ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import type { Observable } from 'rxjs';

import { MigrationsService } from './migrations.service.js';
import { PreparationService } from './preparation.service.js';

@ApiTags('migrations')
@Controller()
export class MigrationsController {
  constructor(
    @Inject(MigrationsService) private readonly migrations: MigrationsService,
    @Inject(PreparationService) private readonly preparation: PreparationService,
  ) {}

  @Get('positions/:wallet')
  @ApiOperation({ summary: 'List persisted lending positions for a wallet' })
  async listPositions(@Param('wallet') wallet: string) {
    return [await this.preparation.getPosition(wallet)];
  }

  @Get('positions/:wallet/history')
  @ApiOperation({ summary: 'List persisted source position history for a wallet' })
  listPersistedPositions(@Param('wallet') wallet: string) {
    return this.migrations.listPositions(wallet);
  }

  @Get('markets')
  @ApiOperation({ summary: 'List enabled destination and source markets' })
  listMarkets() {
    return this.migrations.listMarkets();
  }

  @Post('migrations/execute')
  @ApiOperation({ summary: 'Validate authorizations and durably start a migration' })
  execute(@Body() body: unknown) {
    return this.migrations.execute(body);
  }

  @Post('migrations/prepare')
  @ApiOperation({ summary: 'Prepare an exact local route for borrower EIP-712 review' })
  prepare(@Body() body: unknown) {
    return this.preparation.prepare(body);
  }

  @Get('migrations/:migrationId')
  @ApiOperation({ summary: 'Read migration state, evidence, events, commands, and ledger' })
  getMigration(@Param('migrationId') migrationId: string) {
    return this.migrations.getMigration(migrationId);
  }

  @Get('migrations/:migrationId/events')
  @ApiOperation({ summary: 'Read authoritative migration event history' })
  async getEvents(@Param('migrationId') migrationId: string) {
    return (await this.migrations.getMigration(migrationId)).events;
  }

  @Sse('migrations/:migrationId/stream')
  @ApiOperation({ summary: 'Stream cursor-resumable authoritative migration events' })
  @ApiProduces('text/event-stream')
  streamEvents(
    @Param('migrationId') migrationId: string,
    @Query('after') after: string | undefined,
    @Headers('last-event-id') lastEventId: string | undefined,
  ): Promise<Observable<MessageEvent>> {
    return this.migrations.streamMigrationEvents(
      migrationId,
      parseMigrationEventCursor(after, lastEventId),
    );
  }

  @Get('migrations/:migrationId/evidence')
  @ApiOperation({ summary: 'Read normalized migration evidence' })
  async getEvidence(@Param('migrationId') migrationId: string) {
    return (await this.migrations.getMigration(migrationId)).evidence;
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
