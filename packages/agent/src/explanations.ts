import type { IncomingMessage } from 'node:http';
import { request as requestHttps } from 'node:https';

import { hashCanonicalText } from '@debtshift/domain';
import type { RouteComparison, RouteEvaluation } from '@debtshift/optimizer';
import { z } from 'zod';

import {
  parseLocalOllamaBaseUrl,
  parseRemoteBaseUrl,
  resolvePublicRemoteAddress,
  type DnsLookup,
  type ResolvedPublicAddress,
} from './endpoint-security.js';

const MAX_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

export const explanationSchema = z
  .object({
    summary: z.string().trim().min(1).max(2_000),
    mainEconomicBenefit: z.string().trim().min(1).max(2_000),
    mainRisks: z.array(z.string().trim().min(1).max(1_000)).min(1).max(8),
    breakEvenExplanation: z.string().trim().min(1).max(2_000),
    safetyExplanation: z.string().trim().min(1).max(2_000),
    dataFreshnessWarning: z.string().trim().min(1).max(2_000),
    reviewAndSignStatement: z.string().trim().min(1).max(2_000),
  })
  .strict();

export type RouteExplanation = z.infer<typeof explanationSchema>;

export const explanationConfigurationSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('DETERMINISTIC') }).strict(),
  z
    .object({
      mode: z.literal('LOCAL_AI'),
      baseUrl: z.url(),
      model: z.string().trim().min(1).max(256),
    })
    .strict(),
  z
    .object({
      mode: z.literal('USER_API'),
      provider: z.enum(['OPENAI', 'OPENROUTER', 'CUSTOM']),
      model: z.string().trim().min(1).max(256),
      apiKey: z.string().min(1).max(16_384),
      baseUrl: z.url().optional(),
    })
    .strict(),
]);

export type ExplanationConfiguration = z.infer<typeof explanationConfigurationSchema>;

export interface ExplainedRoute {
  readonly decisionHash: string;
  readonly provider: 'DETERMINISTIC' | 'LOCAL_AI' | 'USER_API';
  readonly fallbackUsed: boolean;
  readonly explanation: RouteExplanation;
}

export interface ExplanationServiceOptions {
  readonly allowCustomEndpoints?: boolean;
  readonly timeoutMs?: number;
  readonly fetcher?: typeof fetch;
  readonly dnsLookup?: DnsLookup;
}

export class RouteExplanationService {
  readonly #allowCustomEndpoints: boolean;
  readonly #timeoutMs: number;
  readonly #fetcher: typeof fetch | undefined;
  readonly #dnsLookup: DnsLookup | undefined;

  constructor(options: ExplanationServiceOptions = {}) {
    this.#allowCustomEndpoints = options.allowCustomEndpoints ?? false;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fetcher = options.fetcher;
    this.#dnsLookup = options.dnsLookup;
  }

  async explain(
    comparison: RouteComparison,
    configuration: ExplanationConfiguration = { mode: 'DETERMINISTIC' },
  ): Promise<ExplainedRoute> {
    const payload = createExplanationPayload(comparison);
    const deterministic = deterministicExplanation(payload);
    const decisionHash = hashCanonicalText(JSON.stringify(payload));
    if (configuration.mode === 'DETERMINISTIC') {
      return {
        decisionHash,
        provider: 'DETERMINISTIC',
        fallbackUsed: false,
        explanation: deterministic,
      };
    }

    try {
      const explanation =
        configuration.mode === 'LOCAL_AI'
          ? await this.#explainWithOllama(payload, configuration)
          : await this.#explainWithUserApi(payload, configuration);
      return {
        decisionHash,
        provider: configuration.mode,
        fallbackUsed: false,
        explanation,
      };
    } catch {
      return {
        decisionHash,
        provider: configuration.mode,
        fallbackUsed: true,
        explanation: deterministic,
      };
    }
  }

  async #explainWithOllama(
    payload: ExplanationPayload,
    configuration: Extract<ExplanationConfiguration, { mode: 'LOCAL_AI' }>,
  ): Promise<RouteExplanation> {
    const baseUrl = parseLocalOllamaBaseUrl(configuration.baseUrl);
    const response = await this.#post(new URL('api/chat', ensureTrailingSlash(baseUrl)), {
      model: nonEmptyModel(configuration.model),
      stream: false,
      format: 'json',
      messages: promptMessages(payload),
    });
    const envelope = z
      .object({ message: z.object({ content: z.string() }).passthrough() })
      .passthrough()
      .parse(response);
    return explanationSchema.parse(JSON.parse(envelope.message.content));
  }

  async #explainWithUserApi(
    payload: ExplanationPayload,
    configuration: Extract<ExplanationConfiguration, { mode: 'USER_API' }>,
  ): Promise<RouteExplanation> {
    if (configuration.apiKey.trim().length === 0) throw new Error('A user API key is required.');
    const baseUrl = remoteProviderUrl(configuration, this.#allowCustomEndpoints);
    const pinnedAddress = await resolvePublicRemoteAddress(
      baseUrl,
      ...(this.#dnsLookup === undefined ? [] : [this.#dnsLookup]),
    );
    const response = await this.#post(
      new URL('chat/completions', ensureTrailingSlash(baseUrl)),
      {
        model: nonEmptyModel(configuration.model),
        temperature: 0,
        response_format: { type: 'json_object' },
        messages: promptMessages(payload),
      },
      { authorization: `Bearer ${configuration.apiKey}` },
      pinnedAddress,
    );
    const envelope = z
      .object({
        choices: z
          .array(
            z.object({ message: z.object({ content: z.string() }).passthrough() }).passthrough(),
          )
          .min(1),
      })
      .passthrough()
      .parse(response);
    const content = envelope.choices[0]?.message.content;
    if (content === undefined) throw new Error('AI provider returned no explanation.');
    return explanationSchema.parse(JSON.parse(content));
  }

  async #post(
    url: URL,
    body: unknown,
    headers: Readonly<Record<string, string>> = {},
    pinnedAddress?: ResolvedPublicAddress,
  ): Promise<unknown> {
    if (pinnedAddress !== undefined && this.#fetcher === undefined) {
      return postPinnedHttpsJson(
        url,
        body,
        headers,
        pinnedAddress,
        this.#timeoutMs,
        MAX_RESPONSE_BYTES,
      );
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await (this.#fetcher ?? fetch)(url, {
        method: 'POST',
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
      if (response.status < 200 || response.status >= 300) {
        throw new Error('AI provider request failed.');
      }
      return JSON.parse(await readLimitedBody(response, MAX_RESPONSE_BYTES));
    } finally {
      clearTimeout(timer);
    }
  }
}

function postPinnedHttpsJson(
  url: URL,
  body: unknown,
  headers: Readonly<Record<string, string>>,
  pinnedAddress: ResolvedPublicAddress,
  timeoutMs: number,
  maximumBytes: number,
): Promise<unknown> {
  if (url.protocol !== 'https:') throw new Error('Pinned remote requests require HTTPS.');
  const encodedBody = JSON.stringify(body);
  return new Promise((resolvePromise, rejectPromise) => {
    const request = requestHttps(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(encodedBody).toString(),
          ...headers,
        },
        lookup: (_hostname, _options, callback) => {
          callback(null, pinnedAddress.address, pinnedAddress.family);
        },
      },
      (response) => {
        void parsePinnedResponse(response, maximumBytes).then(resolvePromise, rejectPromise);
      },
    );
    request.setTimeout(timeoutMs, () =>
      request.destroy(new Error('AI provider request timed out.')),
    );
    request.on('error', rejectPromise);
    request.end(encodedBody);
  });
}

async function parsePinnedResponse(
  response: IncomingMessage,
  maximumBytes: number,
): Promise<unknown> {
  if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
    response.destroy();
    throw new Error('AI provider request failed.');
  }
  const declaredLength = Number(response.headers['content-length'] ?? '0');
  if (declaredLength > maximumBytes) {
    response.destroy();
    throw new Error('AI provider response is too large.');
  }
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of response) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    length += buffer.byteLength;
    if (length > maximumBytes) {
      response.destroy();
      throw new Error('AI provider response is too large.');
    }
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
}

interface ExplanationPayload {
  readonly selectedCandidateId?: string;
  readonly candidate: Pick<
    RouteEvaluation,
    'candidateId' | 'eligible' | 'economics' | 'safety' | 'rejections' | 'provenance'
  >;
}

function createExplanationPayload(comparison: RouteComparison): ExplanationPayload {
  const selected =
    comparison.evaluations.find(
      (evaluation) => evaluation.candidateId === comparison.selectedCandidateId,
    ) ?? comparison.evaluations[0];
  if (selected === undefined) throw new Error('A route comparison has no candidate to explain.');
  return {
    ...(comparison.selectedCandidateId === undefined
      ? {}
      : { selectedCandidateId: comparison.selectedCandidateId }),
    candidate: {
      candidateId: selected.candidateId,
      eligible: selected.eligible,
      economics: selected.economics,
      safety: selected.safety,
      rejections: selected.rejections,
      provenance: selected.provenance,
    },
  };
}

function deterministicExplanation(payload: ExplanationPayload): RouteExplanation {
  const route = payload.candidate;
  const breakEven = route.economics.breakEvenSeconds;
  const mainRisks = route.rejections.length
    ? route.rejections.map((rejection) => rejection.message).slice(0, 8)
    : [
        `Stress target APR is ${formatBps(route.economics.stressTargetAprBps)}.`,
        'Cross-chain settlement remains non-atomic and depends on independently verified custody.',
      ];
  const safety =
    route.safety.kind === 'MAX_LTV_BPS'
      ? `Projected LTV is ${formatBps(route.safety.postLtvBps)} and stressed LTV is ${formatBps(route.safety.stressLtvBps)}.`
      : `Projected health factor is ${formatWad(route.safety.postHealthFactorWad)} and stressed health factor is ${formatWad(route.safety.stressHealthFactorWad)}.`;
  return explanationSchema.parse({
    summary: route.eligible
      ? `Route ${route.candidateId} passes the deterministic economics, liquidity, freshness, and safety policy.`
      : `Route ${route.candidateId} is not eligible under the deterministic policy.`,
    mainEconomicBenefit: `Projected net benefit is ${formatUsdMicro(route.economics.netBenefitUsdMicro)} over the selected horizon, from an APR reduction of ${formatBps(route.economics.aprReductionBps)}.`,
    mainRisks,
    breakEvenExplanation:
      breakEven === undefined
        ? 'There is no finite break-even because the projected APR reduction is not positive.'
        : `At unchanged projected rates, one-time costs break even after about ${formatDays(breakEven)} days.`,
    safetyExplanation: safety,
    dataFreshnessWarning: `Market block ${route.provenance.marketBlockNumber} and oracle update ${route.provenance.oracleUpdatedAt} were evaluated at ${route.provenance.evaluatedAt}; execution must re-read critical state.`,
    reviewAndSignStatement:
      'Review every amount, market, receiver, fee cap, deadline, and risk limit before signing. This explanation cannot authorize execution.',
  });
}

function remoteProviderUrl(
  configuration: Extract<ExplanationConfiguration, { mode: 'USER_API' }>,
  allowCustomEndpoints: boolean,
): URL {
  if (configuration.provider === 'OPENAI') return parseRemoteBaseUrl('https://api.openai.com/v1/');
  if (configuration.provider === 'OPENROUTER') {
    return parseRemoteBaseUrl('https://openrouter.ai/api/v1/');
  }
  if (!allowCustomEndpoints) throw new Error('Custom AI endpoints are disabled.');
  if (configuration.baseUrl === undefined) throw new Error('A custom AI base URL is required.');
  return parseRemoteBaseUrl(configuration.baseUrl);
}

function promptMessages(payload: ExplanationPayload) {
  return [
    {
      role: 'system',
      content:
        'Explain the supplied deterministic DebtShift result. Return only JSON matching: summary, mainEconomicBenefit, mainRisks (array), breakEvenExplanation, safetyExplanation, dataFreshnessWarning, reviewAndSignStatement. Never change or recommend different signed values.',
    },
    { role: 'user', content: JSON.stringify(payload) },
  ] as const;
}

async function readLimitedBody(response: Response, maximumBytes: number): Promise<string> {
  const contentLength = Number(response.headers.get('content-length') ?? '0');
  if (contentLength > maximumBytes) throw new Error('AI provider response is too large.');
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel();
      throw new Error('AI provider response is too large.');
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function ensureTrailingSlash(url: URL): URL {
  const normalized = new URL(url);
  if (!normalized.pathname.endsWith('/')) normalized.pathname += '/';
  return normalized;
}

function nonEmptyModel(model: string): string {
  const trimmed = model.trim();
  if (trimmed.length === 0 || trimmed.length > 256) throw new Error('Invalid AI model identifier.');
  return trimmed;
}

function formatUsdMicro(value: string): string {
  const amount = BigInt(value);
  const sign = amount < 0n ? '-' : '';
  const absolute = amount < 0n ? -amount : amount;
  return `${sign}$${absolute / 1_000_000n}.${(absolute % 1_000_000n).toString().padStart(6, '0').slice(0, 2)}`;
}

function formatBps(value: number): string {
  return `${(value / 100).toFixed(2)}%`;
}

function formatDays(seconds: string): string {
  return (Number(BigInt(seconds)) / 86_400).toFixed(1);
}

function formatWad(value: string): string {
  const wad = BigInt(value);
  return `${wad / 10n ** 18n}.${((wad % 10n ** 18n) / 10n ** 16n).toString().padStart(2, '0')}`;
}
