import { describe, expect, it } from 'vitest';

import {
  classifyTraceError,
  initializeTracing,
  normalizeOtlpTraceEndpoint,
  sanitizeSpanAttributes,
} from './index.js';

describe('observability safety boundary', () => {
  it('keeps tracing disabled when no deployment endpoint is selected', async () => {
    const tracing = initializeTracing({
      serviceName: 'debtshift-api',
      serviceVersion: '0.1.0',
      environment: 'sandbox',
    });
    expect(tracing.enabled).toBe(false);
    await expect(tracing.shutdown()).resolves.toBeUndefined();
  });

  it('normalizes base collector URLs to the OTLP HTTP trace route', () => {
    expect(normalizeOtlpTraceEndpoint('http://jaeger:4318')).toBe('http://jaeger:4318/v1/traces');
    expect(normalizeOtlpTraceEndpoint('https://otel.example.com/collector/')).toBe(
      'https://otel.example.com/collector/v1/traces',
    );
    expect(normalizeOtlpTraceEndpoint('https://otel.example.com/v1/traces/')).toBe(
      'https://otel.example.com/v1/traces',
    );
    expect(normalizeOtlpTraceEndpoint('http://[::1]:4318')).toBe('http://[::1]:4318/v1/traces');
    expect(normalizeOtlpTraceEndpoint('http://[fd00::10]:4318')).toBe(
      'http://[fd00::10]:4318/v1/traces',
    );
  });

  it.each([
    'ftp://localhost/traces',
    'https://user:secret@otel.example.com',
    'https://otel.example.com?token=secret',
    'http://otel.example.com',
    'http://[2001:4860:4860::8888]:4318',
  ])('rejects unsafe collector URL %s', (endpoint) => {
    expect(() => normalizeOtlpTraceEndpoint(endpoint)).toThrow();
  });

  it('accepts only explicitly reviewed, low-risk trace attributes', () => {
    expect(
      sanitizeSpanAttributes({
        'debtshift.mode': 'sandbox',
        'debtshift.command.type': 'RESERVE_LIQUIDITY',
      }),
    ).toEqual({
      'debtshift.mode': 'sandbox',
      'debtshift.command.type': 'RESERVE_LIQUIDITY',
    });
    expect(() => sanitizeSpanAttributes({ authorization: 'Bearer secret' })).toThrow(
      'not allowlisted',
    );
    expect(() => sanitizeSpanAttributes({ 'signed.payload': '0xdeadbeef' })).toThrow(
      'not allowlisted',
    );
  });

  it('uses a static error class instead of mutable, potentially sensitive error text', () => {
    class RetryFailure extends Error {}

    const forged = new Error('provider failure');
    forged.name = 'Bearer_secret_token';
    expect(classifyTraceError(forged)).toBe('Error');
    expect(classifyTraceError(new RetryFailure())).toBe('RetryFailure');
    expect(classifyTraceError({ name: 'Bearer_secret_token' })).toBe('UnknownError');
  });
});
