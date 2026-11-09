import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

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

  @Get('migrations/:migrationId/evidence')
  @ApiOperation({ summary: 'Read normalized migration evidence' })
  async getEvidence(@Param('migrationId') migrationId: string) {
    return (await this.migrations.getMigration(migrationId)).evidence;
  }
}
