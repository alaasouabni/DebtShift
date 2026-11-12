/*
 * The provenance line under a piece of evidence.
 *
 * This exists as a pure function because of a real bug: the first migration
 * rendered against live data crashed here. `evidence.blockNumber` arrives as
 * JSON `null` — it is a nullable PostgreSQL column, not an absent key — and a
 * `=== undefined` guard let it reach a formatter that correctly refuses
 * anything that is not an integer string.
 *
 * Nullable columns observed on a real `GET /v1/migrations/:id`:
 * chainId, blockNumber, blockHash, transactionHash, logIndex,
 * providerReference, supersedesEvidenceId.
 */

import type { Evidence } from '../../lib/api/types';
import { formatInteger } from '../../lib/formatting';

/** True when a value is neither null nor undefined. */
function present<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

/**
 * `EIP712 · eip155:31337` for off-chain evidence, or the full chain, block,
 * transaction and log reference when the backend recorded one.
 */
export function evidenceProvenanceLine(evidence: Evidence): string {
  const parts: string[] = [evidence.provider, evidence.network];

  if (present(evidence.chainId)) parts.push(`chain ${String(evidence.chainId)}`);
  if (present(evidence.blockNumber)) parts.push(`block ${formatInteger(evidence.blockNumber)}`);
  if (present(evidence.transactionHash)) parts.push(`tx ${evidence.transactionHash}`);
  if (present(evidence.logIndex)) parts.push(`log ${String(evidence.logIndex)}`);

  return parts.join(' · ');
}

/**
 * Whether this evidence points at something on a chain.
 *
 * Used to decide whether an explorer link could ever apply. It never produces
 * one: the local chains have no explorer and the backend publishes no explorer
 * metadata, so inventing a URL is not an option.
 */
export function hasChainProvenance(evidence: Evidence): boolean {
  return present(evidence.transactionHash) || present(evidence.blockHash);
}

/**
 * True when this observation came from the transport simulator.
 *
 * The frontend contract (2026-11-12): link actual EVM/NEAR receipts, and label
 * ONLY the transport-provider observation as simulated. A sandbox migration
 * therefore has real chain evidence beside simulated transport evidence, and
 * the two must not be painted with one brush.
 */
export function isSimulatedTransport(evidence: Evidence): boolean {
  return evidence.provider === 'DEBTSHIFT_SIMULATOR';
}

/**
 * Why recovery opened, as the backend recorded it.
 *
 * Read from the `RECOVERY_OPENED` evidence payload, e.g.
 * `{ reason: 'FINALIZED_CHAIN_EVIDENCE_REORGED',
 *    policy: 'HALT_FOR_MANUAL_CANONICAL_STATE_RECONCILIATION' }` — observed on
 * a real sandbox migration. Returns `undefined` when there is no such evidence
 * or it carries no string reason; nothing is invented in its place.
 */
export function readRecoveryReason(
  evidence: readonly Evidence[],
): { readonly reason: string; readonly policy?: string } | undefined {
  const opened = evidence.find((item) => item.type === 'RECOVERY_OPENED');
  const reason = opened?.normalizedPayload.reason;
  if (typeof reason !== 'string' || reason.trim() === '') return undefined;
  const policy = opened?.normalizedPayload.policy;
  return typeof policy === 'string' && policy.trim() !== '' ? { reason, policy } : { reason };
}
