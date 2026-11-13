import { createHash } from 'node:crypto';

const DEFAULT_SPEC_URL = 'https://1click.chaindefuser.com/docs/v0/openapi.yaml';
const MAX_SPEC_BYTES = 3_000_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAXIMUM_ATTEMPTS = 3;

const specUrl = process.env.ONE_CLICK_OPENAPI_URL ?? DEFAULT_SPEC_URL;
if (!specUrl.startsWith('https://')) {
  throw new Error('ONE_CLICK_OPENAPI_URL must use HTTPS.');
}

const response = await fetchWithRetry(specUrl);
const bytes = new Uint8Array(await response.arrayBuffer());
if (bytes.byteLength === 0 || bytes.byteLength > MAX_SPEC_BYTES) {
  throw new Error(`Unexpected 1Click OpenAPI size ${bytes.byteLength}.`);
}
const document = new TextDecoder('utf-8', { fatal: true }).decode(bytes);

const quotePath = yamlSection(document, '/v0/quote', 2);
assertFragments('quote endpoint', quotePath, [
  'post:',
  'operationId: getQuote',
  "$ref: '#/components/schemas/QuoteRequest'",
  "$ref: '#/components/schemas/QuoteResponse'",
  '- X-API-Key: []',
]);

const statusPath = yamlSection(document, '/v0/status', 2);
assertFragments('status endpoint', statusPath, [
  'get:',
  'operationId: getExecutionStatus',
  '- name: depositAddress',
  '- name: depositMemo',
  "$ref: '#/components/schemas/GetExecutionStatusResponse'",
]);

const depositPath = yamlSection(document, '/v0/deposit/submit', 2);
assertFragments('deposit submission endpoint', depositPath, [
  'post:',
  'operationId: submitDepositTx',
  "$ref: '#/components/schemas/SubmitDepositTxRequest'",
  "$ref: '#/components/schemas/SubmitDepositTxResponse'",
]);

const quoteRequest = yamlSection(document, 'QuoteRequest', 4);
assertProperties('QuoteRequest', quoteRequest, [
  'dry',
  'swapType',
  'slippageTolerance',
  'originAsset',
  'depositType',
  'destinationAsset',
  'amount',
  'refundTo',
  'refundType',
  'recipient',
  'recipientType',
  'deadline',
]);
assertFragments('QuoteRequest exact modes', quoteRequest, [
  '- EXACT_INPUT',
  '- EXACT_OUTPUT',
  '- ORIGIN_CHAIN',
  '- DESTINATION_CHAIN',
]);

const quoteResponse = yamlSection(document, 'QuoteResponse', 4);
assertProperties('QuoteResponse', quoteResponse, [
  'correlationId',
  'timestamp',
  'signature',
  'quoteRequest',
  'quote',
]);

const executionStatus = yamlSection(document, 'GetExecutionStatusResponse', 4);
assertProperties('GetExecutionStatusResponse', executionStatus, [
  'correlationId',
  'quoteResponse',
  'status',
  'updatedAt',
  'swapDetails',
]);
assertFragments('execution status values', executionStatus, [
  '- KNOWN_DEPOSIT_TX',
  '- PENDING_DEPOSIT',
  '- INCOMPLETE_DEPOSIT',
  '- PROCESSING',
  '- SUCCESS',
  '- REFUNDED',
  '- FAILED',
]);

const depositRequest = yamlSection(document, 'SubmitDepositTxRequest', 4);
assertProperties('SubmitDepositTxRequest', depositRequest, [
  'txHash',
  'depositAddress',
  'nearSenderAccount',
  'memo',
]);
assertFragments('SubmitDepositTxRequest required fields', depositRequest, [
  '- txHash',
  '- depositAddress',
]);

console.log(
  JSON.stringify({
    provider: 'NEAR_INTENTS_1CLICK',
    specUrl,
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    etag: response.headers.get('etag'),
    lastModified: response.headers.get('last-modified'),
    validatedEndpoints: ['/v0/quote', '/v0/status', '/v0/deposit/submit'],
  }),
);

async function fetchWithRetry(url) {
  let lastError;
  for (let attempt = 1; attempt <= MAXIMUM_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { accept: 'application/yaml, text/yaml, text/plain' },
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new Error(`Official 1Click OpenAPI returned HTTP ${response.status}.`);
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < MAXIMUM_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 250));
      }
    }
  }
  throw new Error('Unable to fetch the official 1Click OpenAPI specification.', {
    cause: lastError,
  });
}

function yamlSection(document, key, indentation) {
  const prefix = ' '.repeat(indentation);
  const marker = `${prefix}${key}:`;
  const start = document.indexOf(marker);
  if (start === -1) throw new Error(`Official 1Click OpenAPI is missing ${key}.`);
  const sectionStart = start + marker.length;
  const nextHeader = new RegExp(`\\n${prefix}[^ \\r\\n][^\\r\\n]*:\\r?\\n`, 'g');
  nextHeader.lastIndex = sectionStart;
  const next = nextHeader.exec(document);
  return document.slice(start, next?.index ?? document.length);
}

function assertProperties(label, section, properties) {
  for (const property of properties) {
    const propertyPattern = new RegExp(`^\\s+${escapeRegExp(property)}:`, 'm');
    if (!propertyPattern.test(section)) {
      throw new Error(`Official 1Click ${label} is missing property ${property}.`);
    }
  }
}

function assertFragments(label, section, fragments) {
  for (const fragment of fragments) {
    if (!section.includes(fragment)) {
      throw new Error(`Official 1Click ${label} is missing ${fragment}.`);
    }
  }
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
