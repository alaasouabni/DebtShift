import { traceContextCarrierSchema } from '@debtshift/domain';
import { initializeTracing, startSafeSpan, type TracingLifecycle } from '@debtshift/observability';
import {
  Inject,
  Injectable,
  type NestMiddleware,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

interface TraceableRequest {
  readonly method: string;
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
}

interface TraceableResponse {
  readonly statusCode: number;
  once(event: 'finish' | 'close', listener: () => void): unknown;
}

@Injectable()
export class TracingLifecycleService implements OnApplicationShutdown {
  readonly #tracing: TracingLifecycle;

  constructor(@Inject(ConfigService) config: ConfigService) {
    const endpoint = config.get<string>('OTEL_EXPORTER_OTLP_ENDPOINT');
    this.#tracing = initializeTracing({
      ...(endpoint === undefined || endpoint.length === 0 ? {} : { endpoint }),
      serviceName: 'debtshift-api',
      serviceVersion: '0.1.0',
      environment: config.getOrThrow<string>('DEBTSHIFT_MODE'),
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.#tracing.shutdown();
  }
}

@Injectable()
export class HttpTracingMiddleware implements NestMiddleware {
  readonly #mode: string;

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.#mode = config.getOrThrow<string>('DEBTSHIFT_MODE');
  }

  use(request: TraceableRequest, response: TraceableResponse, next: () => void): void {
    const parentTraceContext = incomingTraceContext(request.headers);
    const span = startSafeSpan('debtshift.http.request', {
      attributes: {
        'debtshift.mode': this.#mode,
        'http.request.method': request.method,
      },
      ...(parentTraceContext === undefined ? {} : { parentTraceContext }),
    });
    let ended = false;
    const endSpan = (): void => {
      if (ended) return;
      ended = true;
      span.setAttribute('http.response.status_code', response.statusCode);
      if (response.statusCode >= 500) span.fail('HttpServerError');
      else span.succeed();
      span.end();
    };
    response.once('finish', endSpan);
    response.once('close', endSpan);
    span.run(next);
  }
}

function incomingTraceContext(
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
) {
  const traceparent = firstHeader(headers.traceparent);
  if (traceparent === undefined) return undefined;
  const tracestate = firstHeader(headers.tracestate);
  const parsed = traceContextCarrierSchema.safeParse({
    traceparent,
    ...(tracestate === undefined ? {} : { tracestate }),
  });
  return parsed.success ? parsed.data : undefined;
}

function firstHeader(value: string | readonly string[] | undefined): string | undefined {
  if (typeof value === 'string' || value === undefined) return value;
  return value[0];
}
