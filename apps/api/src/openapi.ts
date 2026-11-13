import type { INestApplication } from '@nestjs/common';
import {
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
  type SwaggerDocumentOptions,
} from '@nestjs/swagger';

import { SESSION_COOKIE_NAME } from './authentication.service.js';

const documentOptions: SwaggerDocumentOptions = {
  operationIdFactory: (controllerKey, methodKey) => `${controllerKey}_${methodKey}`,
};

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
