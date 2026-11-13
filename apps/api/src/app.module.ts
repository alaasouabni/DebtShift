import { parseDebtShiftEnvironment } from '@debtshift/domain';
import { Module, RequestMethod, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { AppController } from './app.controller.js';
import { AuthenticationController } from './authentication.controller.js';
import { AuthenticationService } from './authentication.service.js';
import { DatabaseService } from './database.service.js';
import { MigrationsController } from './migrations.controller.js';
import { MigrationsService } from './migrations.service.js';
import { MetricsController } from './metrics.controller.js';
import { MetricsService } from './metrics.service.js';
import { HttpTracingMiddleware, TracingLifecycleService } from './observability.js';
import { LiveMarketToolsService } from './live/live-market-tools.service.js';
import { LiveProtocolService } from './live/live-protocol.service.js';
import {
  DisabledMarketIntelligencePort,
  DisabledProtocolDataPort,
} from './market-data/disabled-market-data.js';
import {
  MARKET_INTELLIGENCE_PORT,
  PROTOCOL_DATA_PORT,
  type ProtocolDataPort,
} from './market-data/ports.js';
import { PreparationService } from './preparation.service.js';
import { QuotesController } from './quotes.controller.js';
import { RouteAnalysisController } from './route-analysis.controller.js';
import { RouteAnalysisService } from './route-analysis.service.js';
import { SessionGuard } from './session.guard.js';
import { LocalMarketToolsService } from './simulator/local-market-tools.service.js';
import { LocalProtocolService } from './simulator/local-protocol.service.js';
import { TransportService } from './transport.service.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      cache: true,
      isGlobal: true,
      validate: parseDebtShiftEnvironment,
    }),
  ],
  controllers: [
    AppController,
    AuthenticationController,
    MetricsController,
    QuotesController,
    RouteAnalysisController,
    MigrationsController,
  ],
  providers: [
    DatabaseService,
    AuthenticationService,
    SessionGuard,
    MetricsService,
    TracingLifecycleService,
    TransportService,
    {
      provide: PROTOCOL_DATA_PORT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): ProtocolDataPort => {
        const provider = config.getOrThrow<string>('MARKET_DATA_PROVIDER');
        if (provider === 'SIMULATOR') return new LocalProtocolService(config);
        if (provider === 'LIVE_READ_ONLY') return new LiveProtocolService(config);
        if (provider === 'DISABLED') return new DisabledProtocolDataPort();
        throw new Error(`Unsupported market data provider ${provider}.`);
      },
    },
    {
      provide: MARKET_INTELLIGENCE_PORT,
      inject: [PROTOCOL_DATA_PORT, TransportService, ConfigService],
      useFactory: (
        protocols: ProtocolDataPort,
        transport: TransportService,
        config: ConfigService,
      ) => {
        if (protocols.provider === 'SIMULATOR') {
          return new LocalMarketToolsService(protocols as LocalProtocolService, config);
        }
        if (protocols.provider === 'LIVE_READ_ONLY') {
          return new LiveMarketToolsService(protocols as LiveProtocolService, transport, config);
        }
        return new DisabledMarketIntelligencePort();
      },
    },
    RouteAnalysisService,
    PreparationService,
    MigrationsService,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(HttpTracingMiddleware).forRoutes({ path: '{*path}', method: RequestMethod.ALL });
  }
}
