/*
 * The landing page's scroll story: one recorded migration, phase by phase.
 *
 * Everything shown is read from the recording of a real run on the
 * contract-backed sandbox: the phase times from its audit events, and for each
 * phase the evidence it rests on and the ledger lines it produced. Nothing is
 * typed into the page. Pure, so it can be tested without a DOM.
 */

import type {
  Evidence,
  LedgerEntry,
  MigrationDetails,
  MigrationPhase,
  PreparedMigration,
} from '../../lib/api/types';
import { chainName } from '../../lib/chains';
import { formatAmount, truncateHex } from '../../lib/formatting';
import { EVIDENCE_TYPE_LABELS, PHASE_LABELS, ledgerComponentLabel } from '../../lib/labels';

export interface StoryFact {
  readonly label: string;
  readonly value: string;
}

export interface StoryPhase {
  readonly phase: MigrationPhase;
  readonly title: string;
  readonly body: string;
  /** Seconds since the migration was authorized, as recorded. */
  readonly offsetSeconds: number;
  readonly facts: readonly StoryFact[];
  /** True when this phase's transport observation came from the simulator. */
  readonly simulated: boolean;
}

/** The evidence and ledger lines that best show what each phase did. */
const PHASE_SOURCES: Partial<
  Record<MigrationPhase, { evidence: readonly string[]; ledger: readonly string[] }>
> = {
  AUTHORIZED: { evidence: ['INTENT_AUTHORIZATION', 'EXECUTION_PLAN_AUTHORIZATION'], ledger: [] },
  RESERVED: { evidence: ['LIQUIDITY_RESERVATION'], ledger: ['RECOVERY_RESERVE_LOCKED'] },
  SOURCE_CLOSED: { evidence: ['SOURCE_CLOSE'], ledger: ['SOURCE_DEBT_PAYOFF'] },
  ROUTING: { evidence: ['TRANSPORT_ORIGIN'], ledger: ['TRANSPORT_ORIGIN_COLLATERAL'] },
  DEST_FUNDED: {
    evidence: ['TRANSPORT_DESTINATION'],
    ledger: ['TRANSPORT_DESTINATION_COLLATERAL'],
  },
  TARGET_OPEN: {
    evidence: ['TARGET_POSITION'],
    ledger: ['TARGET_COLLATERAL_SUPPLY', 'DESTINATION_LOAN_PROCEEDS'],
  },
  SETTLED: {
    evidence: ['LIQUIDITY_SETTLEMENT', 'LEDGER_RECONCILIATION'],
    ledger: ['SOLVER_PRINCIPAL_PAYOUT', 'SOLVER_FEE_PAYOUT'],
  },
};

interface AssetInfo {
  readonly symbol: string;
  readonly decimals: number;
}

/** Asset symbols by chain and address, from the prepared plan. */
function assetIndex(prepared: PreparedMigration): Map<string, AssetInfo> {
  const index = new Map<string, AssetInfo>();
  const plan = prepared.plan as unknown as Record<string, unknown>;
  for (const value of Object.values(plan)) {
    if (value === null || typeof value !== 'object') continue;
    const asset = value as {
      address?: unknown;
      symbol?: unknown;
      decimals?: unknown;
      chainId?: unknown;
    };
    if (
      typeof asset.address === 'string' &&
      typeof asset.symbol === 'string' &&
      typeof asset.decimals === 'number' &&
      asset.chainId !== undefined
    ) {
      index.set(`${String(asset.chainId)}:${asset.address.toLowerCase()}`, {
        symbol: asset.symbol,
        decimals: asset.decimals,
      });
    }
  }
  return index;
}

function amountOf(entry: LedgerEntry, assets: Map<string, AssetInfo>): string {
  const asset = assets.get(`${String(entry.chainId)}:${entry.token.toLowerCase()}`);
  return asset
    ? formatAmount(entry.amountUnits, asset.decimals, asset.symbol)
    : `${entry.amountUnits} base units`;
}

function isSimulated(evidence: Evidence): boolean {
  return evidence.provider === 'DEBTSHIFT_SIMULATOR' || evidence.network.includes('simulat');
}

export function buildStory(details: MigrationDetails, prepared: PreparedMigration): StoryPhase[] {
  const assets = assetIndex(prepared);
  const events = [...details.events].sort((a, b) => a.sequence - b.sequence);
  const startedAt = events.length > 0 ? Date.parse(events[0]!.observedAt) : 0;

  const phases: StoryPhase[] = [];
  for (const event of events) {
    if (phases.some((entry) => entry.phase === event.phase)) continue;
    const sources = PHASE_SOURCES[event.phase];
    const facts: StoryFact[] = [];
    let simulated = false;

    for (const code of sources?.ledger ?? []) {
      const entry = details.ledger.find((line) => line.componentCode === code);
      if (entry)
        facts.push({ label: ledgerComponentLabel(code) ?? code, value: amountOf(entry, assets) });
    }

    const evidence = (sources?.evidence ?? [])
      .map((type) => details.evidence.find((item) => item.type === type))
      .filter((item): item is Evidence => item !== undefined);
    if (evidence.length > 0) {
      facts.push({
        label: evidence.length > 1 ? 'Evidence' : 'Evidence',
        value: evidence.map((item) => EVIDENCE_TYPE_LABELS[item.type]).join(' · '),
      });
      const onChain = evidence.find((item) => item.transactionHash);
      if (onChain) {
        if (onChain.chainId !== null && onChain.chainId !== undefined) {
          facts.push({ label: 'Chain', value: chainName(Number(onChain.chainId)) });
        }
        if (onChain.blockNumber) facts.push({ label: 'Block', value: String(onChain.blockNumber) });
        facts.push({ label: 'Transaction', value: truncateHex(onChain.transactionHash!, 10, 8) });
      }
      facts.push({ label: 'Verification', value: evidence[0]!.verificationState });
      simulated = evidence.some(isSimulated);
    }

    const label = PHASE_LABELS[event.phase];
    phases.push({
      phase: event.phase,
      title: label.label,
      body: label.caption,
      offsetSeconds: Math.max(0, Math.round((Date.parse(event.observedAt) - startedAt) / 1000)),
      facts,
      simulated,
    });
  }
  return phases;
}
