import 'reflect-metadata';

import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { OpenAPIObject, OperationObject, PathItemObject } from '@nestjs/swagger';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDebtShiftOpenApiDocument, DebtShiftOpenApiModule } from './openapi.js';

describe('DebtShift OpenAPI contract', () => {
  let app: INestApplication;
  let document: OpenAPIObject;

  beforeAll(async () => {
    app = await NestFactory.create(DebtShiftOpenApiModule, { logger: false });
    app.setGlobalPrefix('v1');
    document = createDebtShiftOpenApiDocument(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('assigns a stable unique operation id and an explicit success response to every route', () => {
    const securitySchemes = document.components?.securitySchemes ?? {};
    const operationIds = operations(document).map((operation) => {
      expect(operation.operationId).toBeTypeOf('string');
      expect(Object.keys(operation.responses ?? {})).toContainEqual(
        expect.stringMatching(/^2[0-9][0-9]$/),
      );
      for (const requirement of operation.security ?? []) {
        for (const securityName of Object.keys(requirement)) {
          expect(securitySchemes).toHaveProperty(securityName);
        }
      }
      return operation.operationId;
    });
    expect(new Set(operationIds).size).toBe(operationIds.length);
  });

  it('documents wallet login without exposing a session token in JSON', () => {
    const challenge = operation(document, '/v1/auth/challenge', 'post');
    expect(challenge.security).toBeUndefined();
    expect(jsonSchema(challenge.requestBody)).toMatchObject({
      type: 'object',
      required: ['wallet'],
    });

    const verify = operation(document, '/v1/auth/verify', 'post');
    expect(verify.responses?.['200']).toMatchObject({
      headers: { 'Set-Cookie': { schema: { type: 'string' } } },
    });
    expect(JSON.stringify(verify.responses?.['200'])).not.toContain('sessionHash');
  });

  it('documents the full financial authorization bundle and authenticated evidence routes', () => {
    const execute = operation(document, '/v1/migrations/execute', 'post');
    expect(jsonSchema(execute.requestBody)).toMatchObject({
      type: 'object',
      required: [
        'signedIntent',
        'signedPlan',
        'quote',
        'sourceSnapshot',
        'sourceAuthorization',
        'targetAuthorization',
      ],
    });
    expect(execute.security).toEqual([{ debtshift_session: [] }]);

    const evidence = operation(document, '/v1/migrations/{migrationId}/evidence', 'get');
    expect(evidence.security).toEqual([{ debtshift_session: [] }]);
    expect(evidence.responses?.['200']).toMatchObject({
      content: { 'application/json': { schema: { type: 'array' } } },
    });
  });
});

function operations(document: OpenAPIObject): OperationObject[] {
  const methods = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'] as const;
  return Object.values(document.paths).flatMap((path) =>
    methods.flatMap((method) => {
      const candidate = (path as PathItemObject | undefined)?.[method];
      return candidate === undefined ? [] : [candidate];
    }),
  );
}

function operation(document: OpenAPIObject, path: string, method: 'get' | 'post'): OperationObject {
  const value = document.paths[path]?.[method];
  if (value === undefined) throw new Error(`Missing ${method.toUpperCase()} ${path}.`);
  return value;
}

function jsonSchema(requestBody: OperationObject['requestBody']): unknown {
  if (requestBody === undefined || '$ref' in requestBody) return undefined;
  return requestBody.content['application/json']?.schema;
}
