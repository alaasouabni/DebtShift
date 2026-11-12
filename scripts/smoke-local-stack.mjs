import { getExecutionPlanTypedData, getRefinanceIntentTypedData } from '@debtshift/domain';
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
  }),
});

let details;
for (let attempt = 0; attempt < 80; attempt += 1) {
  details = await request(`/v1/migrations/${execution.migrationId}`);
  if (details.migration?.phase === 'SETTLED') break;
  if (details.migration?.phase === 'RECOVERY' || details.migration?.phase === 'FAILED_SAFE') {
    throw new Error(`Local happy-path smoke test entered ${details.migration.phase}.`);
  }
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
}
if (details?.migration?.phase !== 'SETTLED') {
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

process.stdout.write(
  `${JSON.stringify({
    status: 'settled',
    migrationId: execution.migrationId,
    phase: details.migration.phase,
    evidenceCount: details.evidence.length,
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
