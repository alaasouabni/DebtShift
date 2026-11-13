import type { MigrationExecutionContext } from '@debtshift/database';
import {
  evidenceSchema,
  hashCanonicalText,
  type DebtShiftEnvironment,
  type Evidence,
  type EvidenceType,
} from '@debtshift/domain';
import { Account, JsonRpcProvider, KeyPairSigner } from 'near-api-js';

import type { ReceiptRegistryPort } from '../handlers.js';

const REQUIRED_COMPLETION_EVIDENCE: readonly EvidenceType[] = [
  'LIQUIDITY_RESERVATION',
  'SOURCE_LENDING_AUTHORIZATION',
  'SOURCE_CLOSE',
  'TRANSPORT_ORIGIN',
  'TRANSPORT_DESTINATION',
  'TARGET_POSITION',
  'LIQUIDITY_SETTLEMENT',
  'LEDGER_RECONCILIATION',
];

const ATTESTATION_PAGE_SIZE = 50;
const MAX_ATTESTATIONS = 128;

type RegistryEnvironment = Pick<
  DebtShiftEnvironment,
  | 'NEAR_NETWORK'
  | 'NEAR_RPC_URL'
  | 'NEAR_REGISTRY_ACCOUNT'
  | 'NEAR_SIGNER_ACCOUNT_ID'
  | 'NEAR_SIGNER_PRIVATE_KEY'
  | 'NEAR_STORAGE_DEPOSIT_YOCTO'
  | 'NEAR_FUNCTION_CALL_GAS'
>;

interface ActorIdentity {
  readonly network: string;
  readonly account: string;
}

interface RegisterAgreementRequest {
  readonly agreement_id: string;
  readonly intent_hash: string;
  readonly execution_plan_hash: string;
  readonly borrower: ActorIdentity;
  readonly transport_provider: ActorIdentity;
  readonly source_network: string;
  readonly destination_network: string;
}

interface AgreementView extends RegisterAgreementRequest {
  readonly registered_by: string;
  readonly registered_at_ns: string;
  readonly attestation_count: number;
  readonly final_receipt: FinalReceipt | null;
}

interface AttestationInput {
  readonly evidence_id: string;
  readonly evidence_type: string;
  readonly schema_version: number;
  readonly scheme: string;
  readonly evidence_reference: string;
  readonly verification_state: 'FINALIZED';
  readonly supersedes_evidence_id: string | null;
}

interface Attestation extends AttestationInput {
  readonly sequence: number;
  readonly verifier_id: string;
  readonly recorded_at_ns: string;
}

interface FinalReceipt {
  readonly receipt_bundle_hash: string;
  readonly terminal_status: 'COMPLETED' | 'FAILED_SAFE' | 'REQUOTE_REQUIRED' | 'EXPIRED';
  readonly finalized_by: string;
  readonly finalized_at_ns: string;
}

export interface NearRegistryClient {
  view(methodName: string, args: Readonly<Record<string, unknown>>): Promise<unknown>;
  call(methodName: string, args: Readonly<Record<string, unknown>>): Promise<unknown>;
}

export interface NearReceiptRegistryDependencies {
  readonly environment: RegistryEnvironment;
  readonly loadActiveFinalizedEvidence: (migrationId: string) => Promise<readonly Evidence[]>;
  readonly client?: NearRegistryClient;
}

/**
 * Idempotently mirrors the finalized DebtShift evidence set into the NEAR
 * agreement registry and returns a terminal receipt only after the contract's
 * finalized state has been read back from a final block.
 */
export class NearReceiptRegistryPort implements ReceiptRegistryPort {
  readonly #environment: RegistryEnvironment;
  readonly #loadActiveFinalizedEvidence: NearReceiptRegistryDependencies['loadActiveFinalizedEvidence'];
  readonly #client: NearRegistryClient;

  constructor({
    environment,
    loadActiveFinalizedEvidence,
    client,
  }: NearReceiptRegistryDependencies) {
    this.#environment = environment;
    this.#loadActiveFinalizedEvidence = loadActiveFinalizedEvidence;
    this.#client = client ?? new NearApiRegistryClient(environment);
  }

  async finalize(context: MigrationExecutionContext): Promise<Evidence> {
    if (context.migration.phase !== 'SETTLED') {
      throw new Error(`NEAR completion requires SETTLED phase, not ${context.migration.phase}.`);
    }
    const verifier = await this.#client.view('is_verifier', {
      account_id: this.#environment.NEAR_SIGNER_ACCOUNT_ID,
    });
    if (verifier !== true) {
      throw new Error('The configured NEAR signer is not an authorized registry verifier.');
    }

    const records = (await this.#loadActiveFinalizedEvidence(context.migration.migrationId))
      .filter((record) => record.type !== 'NEAR_RECEIPT')
      .sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
    assertCompletionEvidence(context, records);

    const request = agreementRequest(context, this.#environment.NEAR_NETWORK);
    const receiptBundle = receiptBundlePayload(context, records);
    const receiptBundleHash = hashCanonicalText(stableJson(receiptBundle));

    let agreement = await this.#getAgreement(context.migration.migrationId);
    if (agreement === null) {
      await this.#client.call('register_agreement', { request });
      agreement = await this.#getAgreement(context.migration.migrationId);
      if (agreement === null) throw new Error('NEAR registry did not persist the agreement.');
    }
    assertAgreementMatches(agreement, request);

    if (agreement.final_receipt === null) {
      await this.#appendMissingAttestations(context.migration.migrationId, records);
      await this.#client.call('finalize_agreement', {
        agreement_id: context.migration.migrationId,
        receipt_bundle_hash: receiptBundleHash,
        terminal_status: 'COMPLETED',
      });
    }

    const finalReceipt = await this.#getFinalReceipt(context.migration.migrationId);
    if (finalReceipt === null) throw new Error('NEAR registry final receipt was not persisted.');
    assertReceiptMatches(finalReceipt, receiptBundleHash);
    return registryEvidence(context, finalReceipt, receiptBundle, this.#environment.NEAR_NETWORK);
  }

  async #getAgreement(agreementId: string): Promise<AgreementView | null> {
    return parseAgreement(await this.#client.view('get_agreement', { agreement_id: agreementId }));
  }

  async #getFinalReceipt(agreementId: string): Promise<FinalReceipt | null> {
    return parseFinalReceipt(
      await this.#client.view('get_final_receipt', { agreement_id: agreementId }),
    );
  }

  async #appendMissingAttestations(
    agreementId: string,
    records: readonly Evidence[],
  ): Promise<void> {
    if (records.length > MAX_ATTESTATIONS) {
      throw new Error(`Receipt evidence exceeds the registry limit of ${MAX_ATTESTATIONS}.`);
    }
    const inputs = new Map<string, AttestationInput>(
      records.map((record) => [record.evidenceId, attestation(record)]),
    );
    const existing = await this.#getAttestations(agreementId);
    for (const stored of existing) {
      const expected = inputs.get(stored.evidence_id);
      if (expected === undefined) {
        throw new Error(`NEAR agreement contains unexpected evidence ${stored.evidence_id}.`);
      }
      assertAttestationMatches(stored, expected);
    }
    const existingIds = new Set(existing.map(({ evidence_id }) => evidence_id));
    for (const input of inputs.values()) {
      if (existingIds.has(input.evidence_id)) continue;
      await this.#client.call('append_attestation', {
        agreement_id: agreementId,
        input,
      });
    }
  }

  async #getAttestations(agreementId: string): Promise<readonly Attestation[]> {
    const records: Attestation[] = [];
    for (let offset = 0; offset < MAX_ATTESTATIONS; offset += ATTESTATION_PAGE_SIZE) {
      const page = parseAttestations(
        await this.#client.view('get_attestations', {
          agreement_id: agreementId,
          from_index: offset,
          limit: ATTESTATION_PAGE_SIZE,
        }),
      );
      records.push(...page);
      if (page.length < ATTESTATION_PAGE_SIZE) return records;
    }
    throw new Error('NEAR registry attestation pagination exceeded its bounded limit.');
  }
}

class NearApiRegistryClient implements NearRegistryClient {
  readonly #provider: JsonRpcProvider;
  readonly #account: Account;

  constructor(private readonly environment: RegistryEnvironment) {
    if (
      environment.NEAR_REGISTRY_ACCOUNT.length === 0 ||
      environment.NEAR_SIGNER_ACCOUNT_ID.length === 0 ||
      environment.NEAR_SIGNER_PRIVATE_KEY.length === 0
    ) {
      throw new Error('NEAR registry writes require registry and verifier signer configuration.');
    }
    this.#provider = new JsonRpcProvider({ url: environment.NEAR_RPC_URL });
    const signer = KeyPairSigner.fromSecretKey(
      environment.NEAR_SIGNER_PRIVATE_KEY as Parameters<typeof KeyPairSigner.fromSecretKey>[0],
    );
    this.#account = new Account(environment.NEAR_SIGNER_ACCOUNT_ID, this.#provider, signer);
  }

  async view(methodName: string, args: Readonly<Record<string, unknown>>): Promise<unknown> {
    return this.#provider.callFunction({
      contractId: this.environment.NEAR_REGISTRY_ACCOUNT,
      method: methodName,
      args: { ...args },
      blockQuery: { finality: 'final' },
    });
  }

  call(methodName: string, args: Readonly<Record<string, unknown>>): Promise<unknown> {
    return this.#account.callFunction({
      contractId: this.environment.NEAR_REGISTRY_ACCOUNT,
      methodName,
      args: { ...args },
      deposit: this.environment.NEAR_STORAGE_DEPOSIT_YOCTO,
      gas: this.environment.NEAR_FUNCTION_CALL_GAS,
      waitUntil: 'FINAL',
    });
  }
}

function agreementRequest(
  context: MigrationExecutionContext,
  nearNetwork: RegistryEnvironment['NEAR_NETWORK'],
): RegisterAgreementRequest {
  return {
    agreement_id: context.migration.migrationId,
    intent_hash: context.signedIntent.intentHash,
    execution_plan_hash: context.signedPlan.planHash,
    borrower: {
      network: `eip155:${context.signedPlan.plan.sourceMarket.chainId.toString()}`,
      account: context.signedPlan.plan.borrower,
    },
    transport_provider: {
      network: `near:${nearNetwork}`,
      account: context.quote.provider,
    },
    source_network: `eip155:${context.signedPlan.plan.sourceMarket.chainId.toString()}`,
    destination_network: `eip155:${context.signedPlan.plan.targetMarket.chainId.toString()}`,
  };
}

function receiptBundlePayload(
  context: MigrationExecutionContext,
  records: readonly Evidence[],
): Readonly<Record<string, unknown>> {
  return {
    schemaVersion: 1,
    migrationId: context.migration.migrationId,
    intentHash: context.signedIntent.intentHash,
    executionPlanHash: context.signedPlan.planHash,
    terminalStatus: 'COMPLETED',
    evidence: records.map((record) => ({
      evidenceId: record.evidenceId,
      type: record.type,
      schemaVersion: record.schemaVersion,
      provider: record.provider,
      network: record.network,
      ...(record.chainId === undefined ? {} : { chainId: record.chainId }),
      ...(record.blockNumber === undefined ? {} : { blockNumber: record.blockNumber }),
      ...(record.blockHash === undefined ? {} : { blockHash: record.blockHash }),
      ...(record.transactionHash === undefined ? {} : { transactionHash: record.transactionHash }),
      ...(record.providerReference === undefined
        ? {}
        : { providerReference: record.providerReference }),
      rawObservationHash: record.rawObservationHash,
      verificationState: record.verificationState,
      verificationMethod: record.verificationMethod,
      verifierVersion: record.verifierVersion,
    })),
  };
}

function attestation(record: Evidence): AttestationInput {
  return {
    evidence_id: record.evidenceId,
    evidence_type: record.type,
    schema_version: record.schemaVersion,
    scheme: record.verificationMethod,
    evidence_reference:
      record.transactionHash === undefined
        ? `${record.network}/evidence/${record.rawObservationHash}`
        : `${record.network}/tx/${record.transactionHash}`,
    verification_state: 'FINALIZED',
    supersedes_evidence_id: null,
  };
}

function registryEvidence(
  context: MigrationExecutionContext,
  receipt: FinalReceipt,
  bundle: Readonly<Record<string, unknown>>,
  nearNetwork: RegistryEnvironment['NEAR_NETWORK'],
): Evidence {
  const evidenceId = hashCanonicalText(
    `debtshift.evidence.v1:${context.migration.migrationId}:NEAR_RECEIPT:${receipt.receipt_bundle_hash}`,
  );
  return evidenceSchema.parse({
    evidenceId,
    migrationId: context.migration.migrationId,
    type: 'NEAR_RECEIPT',
    schemaVersion: 1,
    provider: 'NEAR_AGREEMENT_REGISTRY',
    network: `near:${nearNetwork}`,
    providerReference: context.migration.migrationId,
    rawObservationHash: receipt.receipt_bundle_hash,
    normalizedPayload: {
      agreementId: context.migration.migrationId,
      receiptBundleHash: receipt.receipt_bundle_hash,
      terminalStatus: receipt.terminal_status,
      finalizedBy: receipt.finalized_by,
      finalizedAtNanoseconds: receipt.finalized_at_ns,
      bundle,
    },
    observedAt: nanosecondsToIso(receipt.finalized_at_ns),
    verificationState: 'FINALIZED',
    verificationMethod: 'NEAR_FINAL_STATE_AND_CONTRACT_RECEIPT',
    verifierVersion: 'debtshift-worker-v1',
  });
}

function assertCompletionEvidence(
  context: MigrationExecutionContext,
  records: readonly Evidence[],
): void {
  if (records.some((record) => record.migrationId !== context.migration.migrationId)) {
    throw new Error('Receipt bundle contains evidence for a different migration.');
  }
  const types = new Set(records.map(({ type }) => type));
  const missing = REQUIRED_COMPLETION_EVIDENCE.filter((type) => !types.has(type));
  if (missing.length !== 0) {
    throw new Error(`NEAR receipt is missing finalized evidence: ${missing.join(', ')}.`);
  }
}

function assertAgreementMatches(actual: AgreementView, expected: RegisterAgreementRequest): void {
  const actualRequest: RegisterAgreementRequest = {
    agreement_id: actual.agreement_id,
    intent_hash: actual.intent_hash,
    execution_plan_hash: actual.execution_plan_hash,
    borrower: actual.borrower,
    transport_provider: actual.transport_provider,
    source_network: actual.source_network,
    destination_network: actual.destination_network,
  };
  if (stableJson(actualRequest) !== stableJson(expected)) {
    throw new Error('Existing NEAR agreement does not match the signed migration bindings.');
  }
}

function assertAttestationMatches(actual: Attestation, expected: AttestationInput): void {
  const comparable: AttestationInput = {
    evidence_id: actual.evidence_id,
    evidence_type: actual.evidence_type,
    schema_version: actual.schema_version,
    scheme: actual.scheme,
    evidence_reference: actual.evidence_reference,
    verification_state: actual.verification_state,
    supersedes_evidence_id: actual.supersedes_evidence_id,
  };
  if (stableJson(comparable) !== stableJson(expected)) {
    throw new Error(`NEAR attestation ${actual.evidence_id} conflicts with durable evidence.`);
  }
}

function assertReceiptMatches(actual: FinalReceipt, receiptBundleHash: string): void {
  if (actual.receipt_bundle_hash !== receiptBundleHash || actual.terminal_status !== 'COMPLETED') {
    throw new Error('Existing NEAR final receipt conflicts with the durable receipt bundle.');
  }
}

function parseAgreement(value: unknown): AgreementView | null {
  if (value === null || value === undefined) return null;
  const record = object(value, 'agreement');
  return {
    agreement_id: text(record.agreement_id, 'agreement_id'),
    intent_hash: text(record.intent_hash, 'intent_hash'),
    execution_plan_hash: text(record.execution_plan_hash, 'execution_plan_hash'),
    borrower: actor(record.borrower, 'borrower'),
    transport_provider: actor(record.transport_provider, 'transport_provider'),
    source_network: text(record.source_network, 'source_network'),
    destination_network: text(record.destination_network, 'destination_network'),
    registered_by: text(record.registered_by, 'registered_by'),
    registered_at_ns: unsignedIntegerText(record.registered_at_ns, 'registered_at_ns'),
    attestation_count: safeInteger(record.attestation_count, 'attestation_count'),
    final_receipt: parseFinalReceipt(record.final_receipt),
  };
}

function parseFinalReceipt(value: unknown): FinalReceipt | null {
  if (value === null || value === undefined) return null;
  const record = object(value, 'final receipt');
  const terminalStatus = text(record.terminal_status, 'terminal_status');
  if (!['COMPLETED', 'FAILED_SAFE', 'REQUOTE_REQUIRED', 'EXPIRED'].includes(terminalStatus)) {
    throw new Error(`Invalid NEAR terminal status ${terminalStatus}.`);
  }
  return {
    receipt_bundle_hash: text(record.receipt_bundle_hash, 'receipt_bundle_hash'),
    terminal_status: terminalStatus as FinalReceipt['terminal_status'],
    finalized_by: text(record.finalized_by, 'finalized_by'),
    finalized_at_ns: unsignedIntegerText(record.finalized_at_ns, 'finalized_at_ns'),
  };
}

function parseAttestations(value: unknown): readonly Attestation[] {
  if (!Array.isArray(value)) throw new Error('Invalid NEAR attestation page.');
  return value.map((candidate) => {
    const record = object(candidate, 'attestation');
    const state = text(record.verification_state, 'verification_state');
    if (state !== 'FINALIZED') {
      throw new Error(`Unexpected NEAR attestation state ${state}.`);
    }
    return {
      evidence_id: text(record.evidence_id, 'evidence_id'),
      evidence_type: text(record.evidence_type, 'evidence_type'),
      schema_version: safeInteger(record.schema_version, 'schema_version'),
      scheme: text(record.scheme, 'scheme'),
      evidence_reference: text(record.evidence_reference, 'evidence_reference'),
      verification_state: 'FINALIZED' as const,
      supersedes_evidence_id:
        record.supersedes_evidence_id === null
          ? null
          : text(record.supersedes_evidence_id, 'supersedes_evidence_id'),
      sequence: safeInteger(record.sequence, 'sequence'),
      verifier_id: text(record.verifier_id, 'verifier_id'),
      recorded_at_ns: unsignedIntegerText(record.recorded_at_ns, 'recorded_at_ns'),
    };
  });
}

function actor(value: unknown, label: string): ActorIdentity {
  const record = object(value, label);
  return {
    network: text(record.network, `${label}.network`),
    account: text(record.account, `${label}.account`),
  };
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Invalid NEAR ${label}.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid NEAR ${label}.`);
  }
  return value;
}

function safeInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid NEAR ${label}.`);
  }
  return value;
}

function unsignedIntegerText(value: unknown, label: string): string {
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) return value;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
    return BigInt(value).toString();
  }
  throw new Error(`Invalid NEAR ${label}.`);
}

function nanosecondsToIso(value: string): string {
  const milliseconds = BigInt(value) / 1_000_000n;
  const numeric = Number(milliseconds);
  if (!Number.isSafeInteger(numeric)) throw new Error('NEAR receipt timestamp is out of range.');
  return new Date(numeric).toISOString();
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableValue(value));
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  if (typeof value === 'bigint') return value.toString();
  return value;
}
