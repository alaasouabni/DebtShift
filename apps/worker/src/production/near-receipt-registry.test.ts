import type { MigrationExecutionContext } from '@debtshift/database';
import { evidenceSchema, type Evidence, type EvidenceType } from '@debtshift/domain';
import { describe, expect, it, vi } from 'vitest';

import { NearReceiptRegistryPort, type NearRegistryClient } from './near-receipt-registry.js';

const MIGRATION_ID = `0x${'11'.repeat(32)}` as const;
const INTENT_HASH = `0x${'22'.repeat(32)}` as const;
const PLAN_HASH = `0x${'33'.repeat(32)}` as const;
const REQUIRED_TYPES: readonly EvidenceType[] = [
  'LIQUIDITY_RESERVATION',
  'SOURCE_LENDING_AUTHORIZATION',
  'SOURCE_CLOSE',
  'TRANSPORT_ORIGIN',
  'TRANSPORT_DESTINATION',
  'TARGET_POSITION',
  'LIQUIDITY_SETTLEMENT',
  'LEDGER_RECONCILIATION',
];

describe('NearReceiptRegistryPort', () => {
  it('registers, attests, finalizes, and then replays from immutable final state', async () => {
    const registry = new RegistryHarness();
    const port = createPort(registry.client, evidence());

    const first = await port.finalize(context());
    const writeCount = registry.client.call.mock.calls.length;
    const second = await port.finalize(context());

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      type: 'NEAR_RECEIPT',
      provider: 'NEAR_AGREEMENT_REGISTRY',
      network: 'near:testnet',
      verificationState: 'FINALIZED',
      rawObservationHash: registry.receipt?.receipt_bundle_hash,
    });
    expect(registry.attestations).toHaveLength(REQUIRED_TYPES.length);
    expect(registry.client.call).toHaveBeenCalledWith(
      'finalize_agreement',
      expect.objectContaining({ terminal_status: 'COMPLETED' }),
    );
    expect(registry.client.call).toHaveBeenCalledTimes(1 + REQUIRED_TYPES.length + 1);
    expect(registry.client.call.mock.calls.length).toBe(writeCount);
  });

  it('refuses to create a terminal receipt when required workflow evidence is absent', async () => {
    const registry = new RegistryHarness();
    const port = createPort(registry.client, evidence().slice(0, -1));

    await expect(port.finalize(context())).rejects.toThrow('LEDGER_RECONCILIATION');
    expect(registry.client.call).not.toHaveBeenCalled();
  });

  it('rejects an existing agreement whose immutable signed bindings conflict', async () => {
    const registry = new RegistryHarness();
    const records = evidence();
    const port = createPort(registry.client, records);
    await port.finalize(context());
    if (registry.agreement === null) throw new Error('Expected a stored agreement.');
    registry.agreement.intent_hash = `0x${'ff'.repeat(32)}`;

    await expect(port.finalize(context())).rejects.toThrow('signed migration bindings');
  });

  it('does not finalize when an attestation write is absent from final contract state', async () => {
    const registry = new RegistryHarness();
    registry.dropAttestationWrites = true;
    const port = createPort(registry.client, evidence());

    await expect(port.finalize(context())).rejects.toThrow('did not persist durable evidence');
    expect(registry.receipt).toBeNull();
    expect(registry.client.call).not.toHaveBeenCalledWith('finalize_agreement', expect.anything());
  });

  it('rejects an immutable final receipt whose registered attestation set is incomplete', async () => {
    const registry = new RegistryHarness();
    const port = createPort(registry.client, evidence());
    await port.finalize(context());
    registry.attestations.pop();
    if (registry.agreement === null) throw new Error('Expected a stored agreement.');
    registry.agreement.attestation_count = registry.attestations.length;
    const writeCount = registry.client.call.mock.calls.length;

    await expect(port.finalize(context())).rejects.toThrow(
      'Finalized NEAR agreement is missing durable evidence',
    );
    expect(registry.client.call).toHaveBeenCalledTimes(writeCount);
  });
});

function createPort(client: NearRegistryClient, records: readonly Evidence[]) {
  return new NearReceiptRegistryPort({
    environment: {
      NEAR_NETWORK: 'testnet',
      NEAR_RPC_URL: 'https://rpc.testnet.near.org',
      NEAR_REGISTRY_ACCOUNT: 'registry.testnet',
      NEAR_SIGNER_ACCOUNT_ID: 'verifier.testnet',
      NEAR_SIGNER_PRIVATE_KEY: 'ed25519:test',
      NEAR_STORAGE_DEPOSIT_YOCTO: '1000000000000000000000000',
      NEAR_FUNCTION_CALL_GAS: '100000000000000',
    },
    loadActiveFinalizedEvidence: async () => records,
    client,
  });
}

function context(): MigrationExecutionContext {
  return {
    migration: { migrationId: MIGRATION_ID, phase: 'SETTLED' },
    signedIntent: { intentHash: INTENT_HASH },
    signedPlan: {
      planHash: PLAN_HASH,
      plan: {
        borrower: '0xa1d79dfa76e98d5e8a776114d9524c4b6e888daa',
        sourceMarket: { chainId: 8453 },
        targetMarket: { chainId: 42161 },
      },
    },
    quote: { provider: 'NEAR_INTENTS_1CLICK' },
  } as unknown as MigrationExecutionContext;
}

function evidence(): readonly Evidence[] {
  return REQUIRED_TYPES.map((type, index) => {
    const byte = (index + 1).toString(16).padStart(2, '0');
    const transactionByte = (index + 17).toString(16).padStart(2, '0');
    return evidenceSchema.parse({
      evidenceId: `0x${byte.repeat(32)}`,
      migrationId: MIGRATION_ID,
      type,
      schemaVersion: 1,
      provider: 'TEST_PROVIDER',
      network: 'eip155:8453',
      chainId: 8453,
      blockNumber: (100 + index).toString(),
      blockHash: `0x${'aa'.repeat(32)}`,
      transactionHash: `0x${transactionByte.repeat(32)}`,
      providerReference: `0x${byte.repeat(32)}`,
      rawObservationHash: `0x${'bb'.repeat(32)}`,
      normalizedPayload: { type },
      observedAt: '2026-11-12T10:00:00.000Z',
      verificationState: 'FINALIZED',
      verificationMethod: 'RECEIPT_AND_STATE',
      verifierVersion: 'test-v1',
    });
  });
}

class RegistryHarness {
  agreement: Record<string, unknown> | null = null;
  readonly attestations: Array<Record<string, unknown>> = [];
  receipt: Record<string, string> | null = null;
  dropAttestationWrites = false;

  readonly client = {
    view: vi.fn(async (methodName: string, args: Readonly<Record<string, unknown>>) => {
      if (methodName === 'is_verifier') return true;
      if (methodName === 'get_agreement') return this.agreement;
      if (methodName === 'get_final_receipt') return this.receipt;
      if (methodName === 'get_attestations') {
        const offset = Number(args.from_index ?? 0);
        const limit = Number(args.limit ?? 50);
        return this.attestations.slice(offset, offset + limit);
      }
      throw new Error(`Unexpected view ${methodName}.`);
    }),
    call: vi.fn(async (methodName: string, args: Readonly<Record<string, unknown>>) => {
      if (methodName === 'register_agreement') {
        const request = args.request as Record<string, unknown>;
        this.agreement = {
          ...request,
          registered_by: 'verifier.testnet',
          registered_at_ns: '1794477600000000000',
          attestation_count: 0,
          final_receipt: null,
        };
        return this.agreement;
      }
      if (methodName === 'append_attestation') {
        const input = args.input as Record<string, unknown>;
        const stored = {
          ...input,
          sequence: this.attestations.length + 1,
          verifier_id: 'verifier.testnet',
          recorded_at_ns: '1794477600000000000',
        };
        if (!this.dropAttestationWrites) this.attestations.push(stored);
        if (this.agreement !== null) this.agreement.attestation_count = this.attestations.length;
        return stored;
      }
      if (methodName === 'finalize_agreement') {
        this.receipt = {
          receipt_bundle_hash: String(args.receipt_bundle_hash),
          terminal_status: 'COMPLETED',
          finalized_by: 'verifier.testnet',
          finalized_at_ns: '1794477600000000000',
        };
        if (this.agreement !== null) this.agreement.final_receipt = this.receipt;
        return this.receipt;
      }
      throw new Error(`Unexpected call ${methodName}.`);
    }),
  } satisfies NearRegistryClient & {
    view: ReturnType<typeof vi.fn>;
    call: ReturnType<typeof vi.fn>;
  };
}
