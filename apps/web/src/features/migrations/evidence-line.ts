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
