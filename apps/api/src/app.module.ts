import { parseDebtShiftEnvironment } from '@debtshift/domain';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AppController } from './app.controller.js';
import { DatabaseService } from './database.service.js';
import { MigrationsController } from './migrations.controller.js';
import { MigrationsService } from './migrations.service.js';
import { LocalProtocolService } from './local-protocol.service.js';
import { LocalMarketToolsService } from './local-market-tools.service.js';
import { PreparationService } from './preparation.service.js';
import { QuotesController } from './quotes.controller.js';
import { RouteAnalysisController } from './route-analysis.controller.js';
import { RouteAnalysisService } from './route-analysis.service.js';
import { TransportService } from './transport.service.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      cache: true,
      isGlobal: true,
      validate: parseDebtShiftEnvironment,
    }),
  ],
  controllers: [AppController, QuotesController, RouteAnalysisController, MigrationsController],
  providers: [
    DatabaseService,
    TransportService,
    LocalProtocolService,
    LocalMarketToolsService,
    RouteAnalysisService,
    PreparationService,
    MigrationsService,
  ],
})
export class AppModule {}
