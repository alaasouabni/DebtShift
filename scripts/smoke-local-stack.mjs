import {
  getExecutionPlanTypedData,
  getRefinanceIntentTypedData,
  ledgerReconciliationSchema,
} from '@debtshift/domain';
import { DEFAULT_ANVIL_BORROWER_KEY } from '@debtshift/protocols';
import { privateKeyToAccount } from 'viem/accounts';

const apiBase = process.env.API_PUBLIC_URL ?? 'http://127.0.0.1:3001';
const borrower = privateKeyToAccount(DEFAULT_ANVIL_BORROWER_KEY);

await waitForHealth();
const positions = await request(`/v1/positions/${borrower.address}`);
if (!Array.isArray(positions) || positions.length !== 1) {
  throw new Error('Local position discovery did not return exactly one source position.');
}
const prepared = await request('/v1/migrations/prepare', {
  method: 'POST',
  body: JSON.stringify({ borrower: borrower.address }),
});
if (
  prepared.execution?.mode !== 'sandbox' ||
  prepared.execution?.transportProvider !== 'DEBTSHIFT_SIMULATOR' ||
  prepared.execution?.simulatedTransport !== true
) {
  throw new Error('Prepared route is not the contract-backed sandbox route.');
}
const [intentSignature, planSignature] = await Promise.all([
  borrower.signTypedData(getRefinanceIntentTypedData(prepared.intent, prepared.verifyingContract)),
  borrower.signTypedData(getExecutionPlanTypedData(prepared.plan, prepared.verifyingContract)),
]);
const execution = await request('/v1/migrations/execute', {
  method: 'POST',
  body: JSON.stringify({
    signedIntent: {
      intent: prepared.intent,
      intentHash: prepared.intentHash,
      signature: intentSignature,
    },
    signedPlan: {
      plan: prepared.plan,
      planHash: prepared.planHash,
      signature: planSignature,
    },
    quote: prepared.quote,
    sourceSnapshot: prepared.sourceSnapshot,
    sourceAuthorization: prepared.sourceAuthorization,
    targetAuthorization: prepared.targetAuthorization,
  }),
});

let details;
const settlementDeadline = Date.now() + 120_000;
while (Date.now() < settlementDeadline) {
  details = await request(`/v1/migrations/${execution.migrationId}`);
  if (details.migration?.phase === 'SETTLED' || details.migration?.phase === 'COMPLETED') break;
  if (details.migration?.phase === 'RECOVERY' || details.migration?.phase === 'FAILED_SAFE') {
    throw new Error(`Local happy-path smoke test entered ${details.migration.phase}.`);
  }
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
}
if (details?.migration?.phase !== 'SETTLED' && details?.migration?.phase !== 'COMPLETED') {
  throw new Error(`Migration did not settle; current phase is ${details?.migration?.phase}.`);
}
const evidenceTypes = new Set(details.evidence.map((record) => record.type));
for (const type of [
  'SOURCE_CLOSE',
  'TRANSPORT_ORIGIN',
  'TRANSPORT_DESTINATION',
  'TARGET_POSITION',
  'LIQUIDITY_SETTLEMENT',
  'LEDGER_RECONCILIATION',
]) {
  if (!evidenceTypes.has(type)) throw new Error(`Missing finalized ${type} evidence.`);
}
if (details.migration.phase === 'COMPLETED' && !evidenceTypes.has('NEAR_RECEIPT')) {
  throw new Error('Completed migration is missing finalized NEAR receipt evidence.');
}
const ledgerEvidence = details.evidence.find(
  (record) => record.type === 'LEDGER_RECONCILIATION' && record.verificationState === 'FINALIZED',
);
const reconciliation = ledgerReconciliationSchema.parse(ledgerEvidence?.normalizedPayload?.ledger);
if (!Array.isArray(details.ledger) || details.ledger.length !== reconciliation.entries.length) {
  throw new Error('Durable ledger rows do not match the finalized reconciliation evidence.');
}
const requiredLedgerComponents = [
  'SOURCE_DEBT_PAYOFF',
  'RECOVERY_RESERVE_LOCKED',
  'TRANSPORT_ORIGIN_COLLATERAL',
  'TRANSPORT_DESTINATION_COLLATERAL',
  'TARGET_COLLATERAL_SUPPLY',
  'DESTINATION_LOAN_PROCEEDS',
  'SOLVER_PRINCIPAL_PAYOUT',
  'SOLVER_FEE_PAYOUT',
  'RECOVERY_RESERVE_PRINCIPAL_CONSUMED',
  'RECOVERY_RESERVE_FEE_CONSUMED',
];
const durableComponents = new Set(details.ledger.map((entry) => entry.componentCode));
for (const component of requiredLedgerComponents) {
  if (!durableComponents.has(component)) {
    throw new Error(`Durable settlement ledger is missing ${component}.`);
  }
}
const finalizedEvidenceIds = new Set(
  details.evidence
    .filter((record) => record.verificationState === 'FINALIZED')
    .map((record) => record.evidenceId),
);
if (!details.ledger.every((entry) => finalizedEvidenceIds.has(entry.evidenceId))) {
  throw new Error('A durable ledger row is not linked to finalized migration evidence.');
}
await verifyMigrationEventStream(execution.migrationId, details.events.at(-1)?.sequence ?? 0);
const metricsResponse = await fetch(`${apiBase}/v1/metrics`);
const metricsContentType = metricsResponse.headers.get('content-type') ?? '';
const metrics = await metricsResponse.text();
if (!metricsResponse.ok || !metricsContentType.startsWith('text/plain; version=0.0.4')) {
  throw new Error('Prometheus metrics endpoint did not return the required text exposition.');
}
for (const metric of [
  `debtshift_migrations{phase="${details.migration.phase}"}`,
  'debtshift_commands{status="SUCCEEDED",type="SETTLE_LIQUIDITY"}',
  'debtshift_liquidity_reservation_principal_units{status="SETTLED"}',
  'debtshift_ledger_entries{category="PRINCIPAL"}',
]) {
  if (!metrics.includes(metric)) throw new Error(`Prometheus output is missing ${metric}.`);
}
if (metrics.includes(execution.migrationId)) {
  throw new Error('Prometheus output leaked a high-cardinality migration identifier.');
}

process.stdout.write(
  `${JSON.stringify({
    status: details.migration.phase === 'COMPLETED' ? 'completed' : 'settled',
    migrationId: execution.migrationId,
    phase: details.migration.phase,
    evidenceCount: details.evidence.length,
    ledgerEntryCount: details.ledger.length,
    unexplainedImbalanceUnits: reconciliation.unexplainedImbalanceUnits,
    eventStreamVerified: true,
    metricsVerified: true,
  })}\n`,
);

async function verifyMigrationEventStream(migrationId, expectedLatestSequence) {
  if (expectedLatestSequence < 1) {
    throw new Error('Migration has no durable audit sequence to verify through SSE.');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  const sequences = [];
  let buffer = '';
  try {
    const response = await fetch(`${apiBase}/v1/migrations/${migrationId}/stream?after=0`, {
      headers: { accept: 'text/event-stream' },
      signal: controller.signal,
    });
    if (
      !response.ok ||
      !(response.headers.get('content-type') ?? '').startsWith('text/event-stream') ||
      response.body === null
    ) {
      throw new Error('Migration event stream did not return a readable SSE response.');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (sequences.at(-1) !== expectedLatestSequence) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const records = buffer.split(/\r?\n\r?\n/);
      buffer = records.pop() ?? '';
      for (const record of records) {
        const lines = record.split(/\r?\n/);
        const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
        if (event !== 'migration') continue;
        const id = lines.find((line) => line.startsWith('id: '))?.slice(4);
        const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
        if (id === undefined || data === undefined) {
          throw new Error('Migration SSE record is missing its cursor or data payload.');
        }
        const sequence = Number(id);
        const payload = JSON.parse(data);
        if (
          !Number.isSafeInteger(sequence) ||
          payload.migrationId !== migrationId ||
          payload.sequence !== sequence
        ) {
          throw new Error('Migration SSE cursor is not bound to its authoritative event payload.');
        }
        sequences.push(sequence);
      }
    }
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
  if (sequences[0] !== 1 || sequences.at(-1) !== expectedLatestSequence) {
    throw new Error(
      `Migration SSE cursor recovery returned ${sequences.join(',')}; expected 1 through ${expectedLatestSequence}.`,
    );
  }
  if (sequences.some((sequence, index) => index > 0 && sequence !== sequences[index - 1] + 1)) {
    throw new Error('Migration SSE audit sequences are not contiguous and ordered.');
  }
}

async function waitForHealth() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      await request('/v1/health');
      return;
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
  }
  throw new Error('DebtShift API did not become healthy within 30 seconds.');
}

async function request(path, init = {}) {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} ${path}: ${Array.isArray(body.message) ? body.message.join(', ') : body.message}`,
    );
  }
  return body;
}
