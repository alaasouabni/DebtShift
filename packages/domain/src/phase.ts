import type { Evidence, EvidenceType, MigrationPhase } from './migration.js';

const forwardPhases = [
  'DRAFT',
  'QUOTED',
  'AUTHORIZED',
  'RESERVED',
  'SOURCE_CLOSED',
  'ROUTING',
  'DEST_FUNDED',
  'TARGET_OPEN',
  'SETTLED',
  'COMPLETED',
] as const satisfies readonly MigrationPhase[];

export interface PhaseEvidence {
  readonly sourceSnapshot: boolean;
  readonly routeQuote: boolean;
  readonly intentAuthorization: boolean;
  readonly executionPlanAuthorization: boolean;
  readonly financingFeasibility: boolean;
  readonly financingRevalidation: boolean;
  readonly supplementaryFunding: boolean;
  readonly liquidityReservation: boolean;
  readonly sourceClose: boolean;
  readonly transportOrigin: boolean;
  readonly transportDestination: boolean;
  readonly targetPosition: boolean;
  readonly liquiditySettlement: boolean;
  readonly ledgerReconciliation: boolean;
  readonly nearReceipt: boolean;
  readonly expired: boolean;
  readonly recoveryOpened: boolean;
  readonly recoveryCompleted: boolean;
}

const evidenceFieldByType: Readonly<Record<EvidenceType, keyof PhaseEvidence>> = {
  SOURCE_POSITION_SNAPSHOT: 'sourceSnapshot',
  ROUTE_QUOTE: 'routeQuote',
  INTENT_AUTHORIZATION: 'intentAuthorization',
  EXECUTION_PLAN_AUTHORIZATION: 'executionPlanAuthorization',
  FINANCING_FEASIBILITY: 'financingFeasibility',
  FINANCING_REVALIDATION: 'financingRevalidation',
  SUPPLEMENTARY_FUNDING: 'supplementaryFunding',
  LIQUIDITY_RESERVATION: 'liquidityReservation',
  SOURCE_CLOSE: 'sourceClose',
  TRANSPORT_ORIGIN: 'transportOrigin',
  TRANSPORT_DESTINATION: 'transportDestination',
  TARGET_POSITION: 'targetPosition',
  LIQUIDITY_SETTLEMENT: 'liquiditySettlement',
  LEDGER_RECONCILIATION: 'ledgerReconciliation',
  NEAR_RECEIPT: 'nearReceipt',
  MIGRATION_EXPIRED: 'expired',
  RECOVERY_OPENED: 'recoveryOpened',
  RECOVERY_COMPLETED: 'recoveryCompleted',
};

export function phaseEvidenceFromRecords(records: readonly Evidence[]): PhaseEvidence {
  const result: Record<keyof PhaseEvidence, boolean> = {
    sourceSnapshot: false,
    routeQuote: false,
    intentAuthorization: false,
    executionPlanAuthorization: false,
    financingFeasibility: false,
    financingRevalidation: false,
    supplementaryFunding: false,
    liquidityReservation: false,
    sourceClose: false,
    transportOrigin: false,
    transportDestination: false,
    targetPosition: false,
    liquiditySettlement: false,
    ledgerReconciliation: false,
    nearReceipt: false,
    expired: false,
    recoveryOpened: false,
    recoveryCompleted: false,
  };

  for (const record of records) {
    if (record.verificationState === 'FINALIZED') {
      result[evidenceFieldByType[record.type]] = true;
    }
  }

  return result;
}

export function deriveMigrationPhase(evidence: PhaseEvidence): MigrationPhase {
  if (!evidence.sourceSnapshot) {
    throw new Error('A migration cannot exist without a finalized source position snapshot.');
  }

  if (evidence.recoveryCompleted) {
    return 'FAILED_SAFE';
  }

  if (evidence.recoveryOpened || (evidence.expired && evidence.sourceClose)) {
    return 'RECOVERY';
  }

  if (evidence.expired) {
    return 'EXPIRED';
  }

  const authorized =
    evidence.intentAuthorization &&
    evidence.executionPlanAuthorization &&
    evidence.financingFeasibility;
  const settled = evidence.liquiditySettlement && evidence.ledgerReconciliation;
  const predicates: readonly [MigrationPhase, boolean][] = [
    ['QUOTED', evidence.routeQuote],
    ['AUTHORIZED', evidence.routeQuote && authorized],
    ['RESERVED', evidence.routeQuote && authorized && evidence.liquidityReservation],
    [
      'SOURCE_CLOSED',
      evidence.routeQuote && authorized && evidence.liquidityReservation && evidence.sourceClose,
    ],
    [
      'ROUTING',
      evidence.routeQuote &&
        authorized &&
        evidence.liquidityReservation &&
        evidence.sourceClose &&
        evidence.transportOrigin,
    ],
    [
      'DEST_FUNDED',
      evidence.routeQuote &&
        authorized &&
        evidence.liquidityReservation &&
        evidence.sourceClose &&
        evidence.transportOrigin &&
        evidence.transportDestination,
    ],
    [
      'TARGET_OPEN',
      evidence.routeQuote &&
        authorized &&
        evidence.liquidityReservation &&
        evidence.sourceClose &&
        evidence.transportOrigin &&
        evidence.transportDestination &&
        evidence.targetPosition,
    ],
    [
      'SETTLED',
      evidence.routeQuote &&
        authorized &&
        evidence.liquidityReservation &&
        evidence.sourceClose &&
        evidence.transportOrigin &&
        evidence.transportDestination &&
        evidence.targetPosition &&
        settled,
    ],
    [
      'COMPLETED',
      evidence.routeQuote &&
        authorized &&
        evidence.liquidityReservation &&
        evidence.sourceClose &&
        evidence.transportOrigin &&
        evidence.transportDestination &&
        evidence.targetPosition &&
        settled &&
        evidence.nearReceipt,
    ],
  ];

  let phase: MigrationPhase = 'DRAFT';
  for (const [candidate, satisfied] of predicates) {
    if (!satisfied) break;
    phase = candidate;
  }
  return phase;
}

const allowedTransitions: Readonly<Record<MigrationPhase, readonly MigrationPhase[]>> = {
  DRAFT: ['QUOTED', 'EXPIRED'],
  QUOTED: ['AUTHORIZED', 'EXPIRED'],
  AUTHORIZED: ['RESERVED', 'EXPIRED'],
  RESERVED: ['SOURCE_CLOSED', 'EXPIRED', 'RECOVERY'],
  SOURCE_CLOSED: ['ROUTING', 'RECOVERY'],
  ROUTING: ['DEST_FUNDED', 'RECOVERY'],
  DEST_FUNDED: ['TARGET_OPEN', 'RECOVERY'],
  TARGET_OPEN: ['SETTLED', 'RECOVERY'],
  SETTLED: ['COMPLETED', 'RECOVERY'],
  COMPLETED: [],
  RECOVERY: ['SETTLED', 'FAILED_SAFE'],
  FAILED_SAFE: [],
  EXPIRED: [],
};

export function isAllowedPhaseTransition(from: MigrationPhase, to: MigrationPhase): boolean {
  return allowedTransitions[from].includes(to);
}

export function assertAllowedPhaseTransition(from: MigrationPhase, to: MigrationPhase): void {
  if (!isAllowedPhaseTransition(from, to)) {
    throw new Error(`Illegal migration transition: ${from} -> ${to}.`);
  }
}

export function forwardPhaseIndex(phase: MigrationPhase): number | undefined {
  const index = forwardPhases.indexOf(phase as (typeof forwardPhases)[number]);
  return index === -1 ? undefined : index;
}
