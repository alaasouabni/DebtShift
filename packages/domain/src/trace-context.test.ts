import { describe, expect, it } from 'vitest';

import { traceContextCarrierSchema } from './trace-context.js';

const validTraceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

describe('trace context carrier', () => {
  it('accepts a strict W3C carrier', () => {
    expect(
      traceContextCarrierSchema.parse({
        traceparent: validTraceparent,
        tracestate: 'vendor=value',
      }),
    ).toEqual({ traceparent: validTraceparent, tracestate: 'vendor=value' });
  });

  it.each([
    '00-00000000000000000000000000000000-00f067aa0ba902b7-01',
    '00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01',
    'ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    'not-a-traceparent',
  ])('rejects malformed or forbidden traceparent %s', (traceparent) => {
    expect(() => traceContextCarrierSchema.parse({ traceparent })).toThrow();
  });

  it('rejects baggage and other unexpected fields', () => {
    expect(() =>
      traceContextCarrierSchema.parse({ traceparent: validTraceparent, baggage: 'secret=value' }),
    ).toThrow();
  });
});
