import { z } from 'zod';

const traceParentPattern = /^[0-9a-f]{2}-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;

export const traceParentSchema = z
  .string()
  .regex(traceParentPattern, 'Trace context must use the W3C traceparent format.')
  .refine((value) => !value.startsWith('ff-'), 'Traceparent version ff is forbidden.')
  .refine(
    (value) => value.slice(3, 35) !== '00000000000000000000000000000000',
    'Trace ID cannot be all zeroes.',
  )
  .refine(
    (value) => value.slice(36, 52) !== '0000000000000000',
    'Parent span ID cannot be all zeroes.',
  );

export const traceStateSchema = z
  .string()
  .max(512)
  .regex(/^[\x20-\x7e]+$/, 'Tracestate must contain printable ASCII only.')
  .refine((value) => !value.includes('\r') && !value.includes('\n'));

export const traceContextCarrierSchema = z
  .object({
    traceparent: traceParentSchema,
    tracestate: traceStateSchema.optional(),
  })
  .strict();

export type TraceContextCarrier = z.infer<typeof traceContextCarrierSchema>;
