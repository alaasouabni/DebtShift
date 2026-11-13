import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';

import { AppModule } from './app.module.js';
import { createDebtShiftOpenApiDocument } from './openapi.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });
  app.enableShutdownHooks();
  app.enableCors({
    credentials: true,
    origin: process.env.WEB_PUBLIC_URL ?? 'http://localhost:3000',
  });
  app.setGlobalPrefix('v1');

  SwaggerModule.setup('docs', app, createDebtShiftOpenApiDocument(app));

  const port = Number(process.env.API_PORT ?? 3001);
  await app.listen(port, '0.0.0.0');
  Logger.log(`DebtShift API listening on ${port}`, 'Bootstrap');
}

void bootstrap();
