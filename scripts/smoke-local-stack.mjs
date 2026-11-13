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

process.stdout.write(
  `${JSON.stringify({
    status: details.migration.phase === 'COMPLETED' ? 'completed' : 'settled',
    migrationId: execution.migrationId,
    phase: details.migration.phase,
    evidenceCount: details.evidence.length,
    ledgerEntryCount: details.ledger.length,
    unexplainedImbalanceUnits: reconciliation.unexplainedImbalanceUnits,
  })}\n`,
);

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
