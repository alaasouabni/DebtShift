import { Module, type INestApplication } from '@nestjs/common';
import {
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
  type SwaggerDocumentOptions,
} from '@nestjs/swagger';

import { AppController } from './app.controller.js';
import { AuthenticationController } from './authentication.controller.js';
import { AuthenticationService, SESSION_COOKIE_NAME } from './authentication.service.js';
import { MigrationsController } from './migrations.controller.js';
import { MigrationsService } from './migrations.service.js';
import { MetricsController } from './metrics.controller.js';
import { MetricsService } from './metrics.service.js';
import { PreparationService } from './preparation.service.js';
import { QuotesController } from './quotes.controller.js';
import { RouteAnalysisController } from './route-analysis.controller.js';
import { RouteAnalysisService } from './route-analysis.service.js';
import { SessionGuard } from './session.guard.js';
import { TransportService } from './transport.service.js';

const documentOptions: SwaggerDocumentOptions = {
  operationIdFactory: (controllerKey, methodKey) => `${controllerKey}_${methodKey}`,
};

const documentationOnlyProvider = Object.freeze({});

/** Controller graph used only for metadata reflection; it never constructs runtime adapters. */
@Module({
  controllers: [
    AppController,
    AuthenticationController,
    MetricsController,
    QuotesController,
    RouteAnalysisController,
    MigrationsController,
  ],
  providers: [
    { provide: AuthenticationService, useValue: documentationOnlyProvider },
    { provide: MetricsService, useValue: documentationOnlyProvider },
    { provide: TransportService, useValue: documentationOnlyProvider },
    { provide: RouteAnalysisService, useValue: documentationOnlyProvider },
    { provide: MigrationsService, useValue: documentationOnlyProvider },
    { provide: PreparationService, useValue: documentationOnlyProvider },
    { provide: SessionGuard, useValue: { canActivate: () => true } },
  ],
})
export class DebtShiftOpenApiModule {}

export function createDebtShiftOpenApiDocument(app: INestApplication): OpenAPIObject {
  const configuration = new DocumentBuilder()
    .setTitle('DebtShift API')
    .setDescription(
      'Deterministic refinance analysis and evidence-driven migration orchestration. Wallet login proves API identity only; financial execution requires separate EIP-712 authorizations.',
    )
    .setVersion('0.1.0')
    .setOpenAPIVersion('3.1.0')
    .addCookieAuth(SESSION_COOKIE_NAME, { type: 'apiKey' }, SESSION_COOKIE_NAME)
    .build();
  return SwaggerModule.createDocument(app, configuration, documentOptions);
}
