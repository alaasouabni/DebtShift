import {
  context,
  propagation,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
} from '@opentelemetry/api';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { isIP } from 'node:net';
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import { traceContextCarrierSchema, type TraceContextCarrier } from '@debtshift/domain';

const instrumentationName = '@debtshift/observability';
const instrumentationVersion = '0.1.0';
const allowedAttributeNames = new Set([
  'debtshift.mode',
  'debtshift.command.type',
  'debtshift.command.logical_attempt',
  'debtshift.command.final_attempt',
  'http.request.method',
  'http.response.status_code',
  'error.type',
]);

export type SafeSpanAttributeValue = string | number | boolean;
export type SafeSpanAttributes = Readonly<Record<string, SafeSpanAttributeValue>>;

export interface TracingConfiguration {
  readonly endpoint?: string;
  readonly serviceName: 'debtshift-api' | 'debtshift-worker';
  readonly serviceVersion: string;
  readonly environment: string;
}

export interface TracingLifecycle {
  readonly enabled: boolean;
  shutdown(): Promise<void>;
}

export interface SafeSpanHandle {
  run<T>(callback: () => T): T;
  setAttribute(name: string, value: SafeSpanAttributeValue): void;
  succeed(): void;
  fail(errorType: string): void;
  end(): void;
}

export interface StartSafeSpanOptions {
  readonly attributes?: SafeSpanAttributes;
  readonly parentTraceContext?: TraceContextCarrier;
}

export function initializeTracing(configuration: TracingConfiguration): TracingLifecycle {
  const endpoint = normalizeOtlpTraceEndpoint(configuration.endpoint);
  if (endpoint === undefined) return disabledTracingLifecycle;

  const sdk = new NodeSDK({
    autoDetectResources: false,
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: configuration.serviceName,
      [ATTR_SERVICE_VERSION]: configuration.serviceVersion,
      [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: configuration.environment,
    }),
    traceExporter: new OTLPTraceExporter({ url: endpoint }),
  });
  sdk.start();
  return {
    enabled: true,
    shutdown: async () => sdk.shutdown(),
  };
}

export function normalizeOtlpTraceEndpoint(endpoint: string | undefined): string | undefined {
  const normalized = endpoint?.trim();
  if (normalized === undefined || normalized.length === 0) return undefined;

  const url = new URL(normalized);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('OTLP trace endpoint must use HTTP or HTTPS.');
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error('OTLP trace endpoint cannot contain embedded credentials.');
  }
  if (url.search.length > 0 || url.hash.length > 0) {
    throw new Error('OTLP trace endpoint cannot contain query parameters or fragments.');
  }
  if (url.protocol === 'http:' && !isPrivateCollectorHost(url.hostname)) {
    throw new Error('Remote OTLP trace endpoints must use HTTPS.');
  }
  const pathname = url.pathname.replace(/\/+$/, '');
  url.pathname = pathname.endsWith('/v1/traces') ? pathname : `${pathname}/v1/traces`;
  return url.toString();
}

export function captureTraceContext(): TraceContextCarrier | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier, {
    set: (target, key, value) => {
      if (key === 'traceparent' || key === 'tracestate') target[key] = value;
    },
  });
  const parsed = traceContextCarrierSchema.safeParse(carrier);
  return parsed.success ? parsed.data : undefined;
}

export function startSafeSpan(name: string, options: StartSafeSpanOptions = {}): SafeSpanHandle {
  const attributes = sanitizeSpanAttributes(options.attributes ?? {});
  const parentContext = extractParentContext(options.parentTraceContext);
  const span = trace
    .getTracer(instrumentationName, instrumentationVersion)
    .startSpan(name, { attributes }, parentContext);
  const activeContext = trace.setSpan(parentContext, span);
  return spanHandle(span, activeContext);
}

export async function runWithSafeSpan<T>(
  name: string,
  options: StartSafeSpanOptions,
  callback: (span: SafeSpanHandle) => Promise<T>,
): Promise<T> {
  const span = startSafeSpan(name, options);
  try {
    const result = await span.run(() => callback(span));
    span.succeed();
    return result;
  } catch (error) {
    span.fail(classifyTraceError(error));
    throw error;
  } finally {
    span.end();
  }
}

export function sanitizeSpanAttributes(attributes: SafeSpanAttributes): Attributes {
  const safe: Attributes = {};
  for (const [name, value] of Object.entries(attributes)) {
    if (!allowedAttributeNames.has(name)) {
      throw new Error(`Trace attribute ${name} is not allowlisted.`);
    }
    safe[name] = value;
  }
  return safe;
}

function extractParentContext(carrier: TraceContextCarrier | undefined): Context {
  if (carrier === undefined) return context.active();
  const parsed = traceContextCarrierSchema.parse(carrier);
  return propagation.extract(context.active(), parsed, {
    get: (source, key) => source[key as keyof TraceContextCarrier],
    keys: (source) => Object.keys(source),
  });
}

function spanHandle(span: Span, activeContext: Context): SafeSpanHandle {
  let failed = false;
  return {
    run: <T>(callback: () => T): T => context.with(activeContext, callback),
    setAttribute: (name, value) => {
      const attributes = sanitizeSpanAttributes({ [name]: value });
      span.setAttributes(attributes);
    },
    succeed: () => {
      if (!failed) span.setStatus({ code: SpanStatusCode.OK });
    },
    fail: (errorType) => {
      failed = true;
      span.setAttribute('error.type', normalizeErrorType(errorType));
      span.setStatus({ code: SpanStatusCode.ERROR });
    },
    end: () => span.end(),
  };
}

export function classifyTraceError(error: unknown): string {
  if (error instanceof Error) {
    const constructorName = error.constructor.name;
    if (/^[A-Za-z][A-Za-z0-9_.:-]{0,119}$/.test(constructorName)) return constructorName;
    return 'Error';
  }
  return 'UnknownError';
}

function normalizeErrorType(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 120);
  return normalized.length === 0 ? 'UnknownError' : normalized;
}

function isPrivateCollectorHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (isIP(host) === 6) {
    return host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
  }
  if (/^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)) return true;
  const private172 = /^172\.(\d{1,3})\./.exec(host);
  if (private172 !== null) {
    const secondOctet = Number(private172[1]);
    if (secondOctet >= 16 && secondOctet <= 31) return true;
  }
  return isIP(host) === 0 && !host.includes('.');
}

const disabledTracingLifecycle: TracingLifecycle = {
  enabled: false,
  shutdown: async () => undefined,
};
