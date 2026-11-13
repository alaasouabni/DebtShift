/*
 * Response shapes for the DebtShift API.
 *
 * The handoff is explicit that some controller bodies are not yet exported as
 * generated DTOs, so these temporary interfaces live here — in ONE module — and
 * nowhere else. When `@debtshift/sdk` starts publishing real types (it is an
 * empty stub today), delete from this file rather than adding a second source
 * of truth next to a component.
 *
 * Every amount is an integer string in base units. Every USD amount is integer
 * micro-dollars. Every rate is basis points. Nothing here is a `number` unless
 * the backend itself sends a bounded integer.
 */

import type {
  PreparedSourceLendingAuthorization,
  PreparedTargetLendingAuthorization,
  SignedTargetLendingAuthorization,
  SubmittedSourceLendingAuthorization,
} from '@debtshift/domain';

export type {
  PreparedSourceLendingAuthorization,
  PreparedTargetLendingAuthorization,
  SignedTargetLendingAuthorization,
  SubmittedSourceLendingAuthorization,
};

export type Address = string;
export type Hex32 = string;

export interface TokenReference {
  readonly chainId: number;
  readonly address: Address;
  readonly decimals: number;
  readonly symbol: string;
}

export interface MarketReference {
  readonly chainId: number;
  readonly protocol: string;
  readonly deployment: Address;
  readonly marketId: Hex32;
}

export interface PositionReference {
  readonly market: MarketReference;
  readonly borrower: Address;
  readonly collateralAsset: TokenReference;
  readonly debtAsset: TokenReference;
}

export interface BlockReference {
  readonly number: string;
  readonly hash: Hex32;
  readonly observedAt: string;
}

export type HealthMetric =
  | { readonly kind: 'AAVE_HEALTH_FACTOR'; readonly healthFactorWad: string }
  | { readonly kind: 'MORPHO_LTV'; readonly ltvBps: number; readonly lltvBps: number };

export interface PositionSnapshot {
  readonly snapshotId: Hex32;
  readonly position: PositionReference;
  readonly collateralUnits: string;
  readonly debtUnits: string;
  readonly health: HealthMetric;
  readonly borrowAprBps: number;
  readonly block: BlockReference;
}

export interface HealthResponse {
  readonly service: 'debtshift-api';
  readonly status: 'ok';
  readonly timestamp: string;
}

/* ------------------------------------------------------------- route analysis */

export type ExplanationConfiguration =
  | { readonly mode: 'DETERMINISTIC' }
  | { readonly mode: 'LOCAL_AI'; readonly baseUrl: string; readonly model: string }
  | {
      readonly mode: 'USER_API';
      readonly provider: 'OPENAI' | 'OPENROUTER' | 'CUSTOM';
      readonly model: string;
      readonly apiKey: string;
      readonly baseUrl?: string;
    };

export interface RouteExplanation {
  readonly summary: string;
  readonly mainEconomicBenefit: string;
  readonly mainRisks: readonly string[];
  readonly breakEvenExplanation: string;
  readonly safetyExplanation: string;
  readonly dataFreshnessWarning: string;
  readonly reviewAndSignStatement: string;
}

export interface ExplainedRoute {
  readonly decisionHash: string;
  readonly provider: 'DETERMINISTIC' | 'LOCAL_AI' | 'USER_API';
  readonly fallbackUsed: boolean;
  readonly explanation: RouteExplanation;
}

export interface RouteEconomics {
  readonly sourceAprBps: number;
  readonly targetAprBeforeBps: number;
  readonly targetAprAfterBps: number;
  readonly targetRateImpactBps: number;
  readonly aprReductionBps: number;
  readonly stressTargetAprBps: number;
  readonly allInCostUsdMicro: string;
  readonly carryingCostUsdMicro: string;
  readonly grossSavingsUsdMicro: string;
  readonly stressGrossSavingsUsdMicro: string;
  readonly netBenefitUsdMicro: string;
  readonly stressNetBenefitUsdMicro: string;
  readonly annualGrossSavingsUsdMicro: string;
  readonly breakEvenSeconds?: string;
}

export type RouteSafety =
  | {
      readonly kind: 'MAX_LTV_BPS';
      readonly postLtvBps: number;
      readonly stressLtvBps: number;
      readonly maximumLtvBps: number;
      readonly stressMaximumLtvBps: number;
    }
  | {
      readonly kind: 'MIN_HEALTH_FACTOR_WAD';
      readonly postHealthFactorWad: string;
      readonly stressHealthFactorWad: string;
      readonly minimumWad: string;
      readonly stressMinimumWad: string;
      readonly riskLimitBps?: number;
    };

export type FinancingClass = 'SOLVER_ADVANCED' | 'CAPITALIZED' | 'SEPARATELY_PAID';

export type FinancingCostKind =
  'TRANSPORT' | 'PROTOCOL' | 'EXECUTION' | 'NETWORK' | 'SLIPPAGE' | 'OTHER';

export interface FinancingComponent {
  readonly componentId: string;
  readonly kind: FinancingCostKind;
  readonly financingClass: FinancingClass;
  readonly asset: TokenReference;
  readonly amountUnits: string;
  readonly settlementAmountUnits: string;
  readonly conversionQuoteHash?: string;
  readonly counted?: boolean;
}

export type EvidenceVerificationState =
  'PROVISIONAL' | 'CONFIRMED' | 'FINALIZED' | 'RETRACTED' | 'REJECTED';

export interface ExternalFunding {
  readonly fundingId: string;
  readonly evidenceId: string;
  readonly migrationId?: string;
  readonly asset: TokenReference;
  readonly amountUnits: string;
  readonly escrow: Address;
  readonly refundReceiver: Address;
  readonly authorizedUse: string;
  readonly verificationState: EvidenceVerificationState;
  readonly expiresAt: string;
  readonly counted?: boolean;
  readonly exclusionCodes?: readonly string[];
}

export interface Rejection {
  readonly code: string;
  readonly message: string;
  readonly reference?: string;
}

/** The sources-and-uses model. Every amount is in settlement-asset base units. */
export interface RefinancingFeasibility {
  readonly modelVersion: 1;
  readonly eligible: boolean;
  readonly settlementAsset: TokenReference;
  readonly sourceDebtPayoffAssetUnits: string;
  readonly sourceDebtPayoffUnits: string;
  readonly sourceConversionQuoteHash?: string;
  readonly borrowerDebtPrepaymentUnits: string;
  readonly borrowerDebtPrepaymentEvidenceId?: string;
  readonly solverAdvancedCostUnits: string;
  readonly solverPrincipalUnits: string;
  readonly solverFeeUnits: string;
  readonly capitalizedCostUnits: string;
  readonly separatelyPaidCostUnits: string;
  readonly totalRequiredRepaymentAndFinancedCostUnits: string;
  readonly confirmedExternalFundingUnits: string;
  readonly protocolBorrowCapacityUnits: string;
  readonly policyBorrowCapacityUnits: string;
  readonly liquidityBorrowCapacityUnits: string;
  readonly signedBorrowCapacityUnits: string;
  readonly maximumSafeBorrowingCapacityUnits: string;
  readonly requiredDestinationBorrowUnits: string;
  readonly fundingShortfallUnits: string;
  readonly components: readonly FinancingComponent[];
  readonly externalFunding: readonly ExternalFunding[];
  readonly rejections: readonly Rejection[];
}

export interface MarketSnapshot {
  readonly snapshotId: Hex32;
  readonly market: MarketReference;
  readonly collateralAsset: TokenReference;
  readonly debtAsset: TokenReference;
  readonly borrowAprBps: number;
  readonly availableBorrowUnits: string;
  readonly collateralFactorBps?: number;
  readonly lltvBps?: number;
  readonly block: BlockReference;
}

export interface RouteProvenance {
  readonly sourceSnapshotId: string;
  readonly marketSnapshotId: string;
  readonly marketBlockNumber: string;
  readonly marketBlockHash: string;
  readonly oracleUpdatedAt: string;
  readonly evaluatedAt: string;
  readonly rateProjection: string;
}

export interface RouteEvaluation {
  readonly candidateId: string;
  readonly eligible: boolean;
  readonly rank?: number;
  readonly scoreUsdMicro: string;
  readonly economics: RouteEconomics;
  readonly safety: RouteSafety;
  readonly financing: RefinancingFeasibility;
  readonly rejections: readonly Rejection[];
  readonly provenance: RouteProvenance;
  /** Present on the candidate the backend evaluated; used for market labels. */
  readonly market?: MarketSnapshot;
}

export interface RouteComparison {
  readonly policyVersion: 1;
  readonly selectedCandidateId?: string;
  readonly evaluations: readonly RouteEvaluation[];
}

export interface SourcePositionAnalysis {
  readonly sourcePosition: PositionSnapshot;
  readonly comparison: RouteComparison;
}

export interface RouteAnalysisResponse {
  readonly analysis: {
    readonly agent: string;
    readonly deterministic: boolean;
    readonly analyses: readonly SourcePositionAnalysis[];
  };
  readonly explanations: readonly {
    readonly sourceSnapshotId: string;
    readonly result: ExplainedRoute;
  }[];
}

/* ------------------------------------------------------------- authorization */

export type SafetyPolicy =
  | {
      readonly kind: 'MIN_HEALTH_FACTOR_WAD';
      readonly minimumWad: string;
      readonly stressMinimumWad: string;
    }
  | {
      readonly kind: 'MAX_LTV_BPS';
      readonly maximumLtvBps: number;
      readonly stressMaximumLtvBps: number;
    };

export interface RefinanceIntent {
  readonly borrower: Address;
  readonly accountType: 'EOA' | 'EIP1271';
  readonly sourcePosition: PositionReference;
  readonly allowedTargets: readonly MarketReference[];
  readonly feeAsset: TokenReference;
  readonly maxSourceDebtUnits: string;
  readonly minSourceCollateralUnits: string;
  readonly maxTotalFeeUnits: string;
  readonly maxSlippageBps: number;
  readonly minAprReductionBps: number;
  readonly safetyPolicy: SafetyPolicy;
  readonly maxDurationSeconds: number;
  readonly expiration: string;
  readonly nonce: string;
}

export type TransportProvider = 'DEBTSHIFT_SIMULATOR' | 'NEAR_INTENTS_1CLICK';
export type ProviderMode = 'SIMULATED' | 'DRY' | 'COMMITTED';

export interface ProviderFee {
  readonly kind: 'NETWORK' | 'TRANSPORT' | 'SLIPPAGE' | 'SOLVER' | 'PROTOCOL' | 'OTHER';
  readonly asset: TokenReference;
  readonly amountUnits: string;
}

export interface ProviderQuote {
  readonly quoteId: string;
  readonly quoteHash: Hex32;
  readonly provider: TransportProvider;
  readonly mode: ProviderMode;
  readonly inputAsset: TokenReference;
  readonly outputAsset: TokenReference;
  readonly amountInUnits: string;
  readonly expectedAmountOutUnits: string;
  readonly minAmountOutUnits: string;
  readonly fees: readonly ProviderFee[];
  readonly destinationReceiver: string;
  readonly refundReceiver: string;
  readonly depositAddress?: string;
  readonly depositMemo?: string;
  readonly expiresAt: string;
  readonly correlationId?: string;
  readonly rawResponseHash: Hex32;
}

export interface ExecutionFinancing extends RefinancingFeasibility {
  readonly evaluatedAt: string;
  readonly validUntil: string;
  readonly capacityEvidenceHash: Hex32;
  readonly liquidityBufferBps: number;
  readonly stressCollateralDropBps: number;
}

export interface ExecutionPlan {
  readonly intentHash: Hex32;
  readonly migrationId: Hex32;
  readonly borrower: Address;
  readonly sourcePositionId: Hex32;
  readonly sourceMarket: MarketReference;
  readonly targetMarket: MarketReference;
  readonly sourceDebtAsset: TokenReference;
  readonly sourceCollateralAsset: TokenReference;
  readonly destinationDebtAsset: TokenReference;
  readonly destinationCollateralAsset: TokenReference;
  readonly sourceRepaymentMaxUnits: string;
  readonly sourceCollateralMinUnits: string;
  readonly targetDebtMaxUnits: string;
  readonly minDestinationCollateralUnits: string;
  readonly transportProvider: TransportProvider;
  readonly transportQuoteHash: Hex32;
  readonly transportDepositAddress: string;
  readonly destinationReceiver: Address;
  /**
   * Where the transport provider returns value if the crossing fails.
   * Signed since the plan's EIP-712 version 2; absent from payloads
   * recorded before it.
   */
  readonly transportRefundReceiver?: Address;
  readonly refundReceiver: Address;
  readonly fundingProvider: Address;
  readonly reservationHash: Hex32;
  readonly payoutAsset: TokenReference;
  readonly payoutReceiver: Address;
  readonly principalMaxUnits: string;
  readonly feeMaxUnits: string;
  readonly financing: ExecutionFinancing;
  readonly routeHash: Hex32;
  readonly deadline: string;
  readonly nonce: string;
}

/*
 * `execution` is what the API returns since 2026-11-13. The two older
 * shapes are kept because recorded payloads still carry them.
 *
 * `simulation` is what the API returned before; `environment` is what the
 * frontend contract specifies since the 2026-11-12 strategy update. Both are
 * optional here because either may be present while the backend migrates.
 * Never read them directly — `readEnvironment` in `lib/environment` is the one
 * place that understands both and fails closed when neither is usable.
 */
export interface PreparedMigration {
  readonly execution?: {
    readonly mode: 'sandbox' | 'testnet' | 'mainnet-readonly' | 'mainnet';
    readonly transportProvider: TransportProvider;
    readonly transportMode: ProviderMode;
    readonly simulatedTransport: boolean;
    readonly fundedExecutionEnabled: boolean;
    readonly warning: string;
  };
  readonly simulation?: {
    readonly provider: 'DEBTSHIFT_SIMULATOR';
    readonly mode: 'SIMULATED';
    readonly warning: string;
  };
  readonly environment?: {
    readonly mode: 'sandbox' | 'testnet' | 'mainnet-readonly' | 'mainnet';
    readonly transportProvider: TransportProvider;
    readonly executionEnabled: boolean;
    readonly warning?: string;
  };
  readonly verifyingContract: Address;
  readonly intent: RefinanceIntent;
  readonly intentHash: Hex32;
  readonly plan: ExecutionPlan;
  readonly planHash: Hex32;
  /**
   * Permissions the lending protocols themselves need, prepared by the
   * backend. `NONE` when the market needs nothing beyond the two
   * signatures; absent from payloads recorded before 2026-11-13.
   */
  readonly sourceAuthorization?: PreparedSourceLendingAuthorization;
  readonly targetAuthorization?: PreparedTargetLendingAuthorization;
  readonly quote: ProviderQuote;
  readonly sourceSnapshot: PositionSnapshot;
  readonly routeAnalysis: RouteAnalysisResponse;
}

export interface ExecuteRequest {
  readonly signedIntent: {
    readonly intent: RefinanceIntent;
    readonly intentHash: Hex32;
    readonly signature: string;
  };
  readonly signedPlan: {
    readonly plan: ExecutionPlan;
    readonly planHash: Hex32;
    readonly signature: string;
  };
  readonly quote: ProviderQuote;
  readonly sourceSnapshot: PositionSnapshot;
  readonly sourceAuthorization: SubmittedSourceLendingAuthorization;
  readonly targetAuthorization: SignedTargetLendingAuthorization;
}

export interface ExecuteResponse {
  readonly migrationId: Hex32;
  readonly created?: boolean;
  readonly initialCommandId?: Hex32;
}

/* ------------------------------------------------------------ wallet session */

/**
 * A one-time EIP-4361 login challenge.
 *
 * `message` is the exact text the wallet signs. It proves control of the
 * wallet for API access only; it authorizes no refinance and no transaction.
 */
export interface WalletChallenge {
  readonly challengeId: string;
  readonly wallet: Address;
  readonly chainId: number;
  readonly message: string;
  readonly expiresAt: string;
}

/**
 * The borrower session as the API reports it. The session token itself is an
 * HttpOnly cookie this code can neither read nor store.
 */
export interface WalletSession {
  readonly wallet: Address;
  readonly chainId: number;
  readonly expiresAt: string;
}

export interface CancellationResponse {
  readonly migrationId: Hex32;
  /** RESERVED while the workflow releases the reservation, then CANCELLED. */
  readonly phase: 'RESERVED' | 'CANCELLED';
  readonly cancellationRequested: true;
}

/* ----------------------------------------------------------------- migration */

export const MIGRATION_PHASES = [
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
  'RECOVERY',
  'FAILED_SAFE',
  'REQUOTE_REQUIRED',
  'EXPIRED',
  'CANCELLED',
] as const;

export type MigrationPhase = (typeof MIGRATION_PHASES)[number];

/** The ten ordered forward phases, in order. Recovery states are not on this track. */
export const FORWARD_PHASES = MIGRATION_PHASES.slice(0, 10) as readonly MigrationPhase[];

/*
 * REQUOTE_REQUIRED is terminal: a pre-source feasibility check failed, the
 * undrawn reservation was released and the source position is untouched. The
 * backend's transition table gives it no successors, so polling stops there.
 */
export const TERMINAL_PHASES: readonly MigrationPhase[] = [
  'COMPLETED',
  'FAILED_SAFE',
  'REQUOTE_REQUIRED',
  'EXPIRED',
  'CANCELLED',
];

/**
 * The phases the backend accepts a borrower cancellation from: authorized or
 * reserved, which is to say before the source loan is touched. Anything later
 * is answered with HTTP 409.
 */
export const CANCELLABLE_PHASES: readonly MigrationPhase[] = ['AUTHORIZED', 'RESERVED'];

export function isCancellablePhase(phase: string): boolean {
  return CANCELLABLE_PHASES.includes(phase as MigrationPhase);
}

export function isTerminalPhase(phase: string): boolean {
  return TERMINAL_PHASES.includes(phase as MigrationPhase);
}

export type CommandType =
  | 'RESERVE_LIQUIDITY'
  | 'CLOSE_SOURCE'
  | 'DISPATCH_TRANSPORT'
  | 'VERIFY_DESTINATION'
  | 'OPEN_TARGET'
  | 'SETTLE_LIQUIDITY'
  | 'FINALIZE_NEAR_RECEIPT'
  | 'EXECUTE_RECOVERY'
  | 'CANCEL_MIGRATION';

export type CommandStatus =
  | 'PENDING'
  | 'DISPATCHED'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED_RETRYABLE'
  | 'FAILED_TERMINAL'
  | 'CANCELLED';

export type EvidenceType =
  | 'SOURCE_POSITION_SNAPSHOT'
  | 'ROUTE_QUOTE'
  | 'INTENT_AUTHORIZATION'
  | 'EXECUTION_PLAN_AUTHORIZATION'
  | 'SOURCE_LENDING_AUTHORIZATION'
  | 'FINANCING_FEASIBILITY'
  | 'FINANCING_REVALIDATION'
  | 'SUPPLEMENTARY_FUNDING'
  | 'LIQUIDITY_RESERVATION'
  | 'SOURCE_CLOSE'
  | 'TRANSPORT_ORIGIN'
  | 'TRANSPORT_DESTINATION'
  | 'TARGET_POSITION'
  | 'LIQUIDITY_SETTLEMENT'
  | 'LEDGER_RECONCILIATION'
  | 'NEAR_RECEIPT'
  | 'MIGRATION_EXPIRED'
  | 'MIGRATION_CANCELLATION_REQUESTED'
  | 'MIGRATION_CANCELLED'
  | 'REQUOTE_REQUIRED'
  | 'RECOVERY_OPENED'
  | 'RECOVERY_COMPLETED';

export type LedgerCategory =
  'PRINCIPAL' | 'FEE' | 'COST' | 'COLLATERAL' | 'RESERVE' | 'REFUND' | 'RESIDUAL' | 'SHORTFALL';

export interface Migration {
  readonly migrationId: Hex32;
  readonly intentHash: Hex32;
  readonly planHash: Hex32;
  readonly quoteHash: Hex32;
  readonly phase: MigrationPhase;
  readonly version: number;
  /** When the authorized window closes. */
  readonly expiresAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Null until the migration reaches COMPLETED. */
  readonly completedAt?: string | null;
}

/*
 * Note the `| null`s.
 *
 * These come straight out of PostgreSQL columns, so an absent value arrives as
 * JSON `null`, not as an absent key. Declaring them optional-only was wrong and
 * crashed the evidence list on the first real migration: `blockNumber` was
 * null, a `=== undefined` guard let it through, and the formatter rejected it.
 * Typing them honestly makes the compiler force the guard at every use.
 */
export interface Evidence {
  readonly evidenceId: Hex32;
  readonly migrationId: Hex32;
  readonly type: EvidenceType;
  readonly schemaVersion: number;
  readonly provider: string;
  readonly network: string;
  readonly chainId?: number | null;
  readonly blockNumber?: string | null;
  readonly blockHash?: Hex32 | null;
  readonly transactionHash?: Hex32 | null;
  readonly logIndex?: number | null;
  readonly providerReference?: string | null;
  readonly supersedesEvidenceId?: Hex32 | null;
  readonly rawObservationHash: Hex32;
  readonly normalizedPayload: Record<string, unknown>;
  readonly observedAt: string;
  readonly verificationState: EvidenceVerificationState;
  readonly verificationMethod: string;
  readonly verifierVersion: string;
}

export interface Command {
  readonly commandId: Hex32;
  readonly migrationId: Hex32;
  readonly type: CommandType;
  readonly idempotencyKey: string;
  readonly status: CommandStatus;
  readonly logicalAttempt: number;
  readonly payloadHash: Hex32;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Null for a command that has not failed. */
  readonly lastError?: string | null;
}

export interface LedgerEntry {
  readonly entryId: Hex32;
  readonly migrationId: Hex32;
  readonly sequence: number;
  /**
   * What the entry is, the evidence it rests on and whether it is a
   * finalized movement or a signed classification. Present since the
   * receipt-linked ledger of 2026-11-13; absent from older rows.
   */
  readonly componentCode?: string | null;
  readonly componentId?: string | null;
  readonly evidenceId?: Hex32 | null;
  readonly basis?: 'FINALIZED_MOVEMENT' | 'SIGNED_COST_CLASSIFICATION' | null;
  /** A number in older rows, a decimal string since the receipt-linked ledger. */
  readonly chainId: number | string;
  readonly token: Address;
  readonly amountUnits: string;
  readonly debitParty: string;
  readonly creditParty: string;
  readonly category: LedgerCategory;
  readonly transactionReference?: string | null;
  readonly createdAt: string;
}

export interface AuditEvent {
  readonly eventId: Hex32;
  readonly migrationId: Hex32;
  readonly sequence: number;
  readonly type: string;
  readonly phase: MigrationPhase;
  /** Who caused the event: the workflow, or the borrower's address. */
  readonly actor?: string;
  readonly payload: Record<string, unknown>;
  readonly payloadHash?: Hex32;
  readonly observedAt: string;
  readonly createdAt?: string;
}

export type RecoveryPolicy =
  | 'RETURN_KNOWN_COLLATERAL_PRESERVE_SOLVER_RECEIVABLE'
  | 'RETURN_VERIFIED_COLLATERAL_PRESERVE_SOLVER_RECEIVABLE'
  | 'MANUAL_CUSTODY_RECONCILIATION'
  | 'MANUAL_TARGET_AND_PAYOUT_RECONCILIATION'
  | 'MANUAL_SETTLEMENT_RECONCILIATION'
  | 'MANUAL_RECOVERY_EXECUTION_RECONCILIATION'
  | 'HALT_FOR_MANUAL_CANONICAL_STATE_RECONCILIATION';

export type RecoveryNextPermittedAction =
  | 'EXECUTE_SIGNED_RECOVERY'
  | 'RECONCILE_TRANSPORT_CUSTODY'
  | 'RECONCILE_TARGET_AND_PAYOUT'
  | 'RECONCILE_SETTLEMENT'
  | 'RECONCILE_RECOVERY_EXECUTION'
  | 'RECONCILE_CANONICAL_STATE';

export type RecoveryEscalationState =
  'AUTOMATED_RECOVERY_PENDING' | 'MANUAL_REVIEW_REQUIRED' | 'RESOLVED_FAILED_SAFE';

export type RecoveryCaseStatus = 'OPEN' | 'RESOLVED_FAILED_SAFE';

/**
 * One recovery the backend opened for a migration: what policy applies, who
 * owns the next step, what that step is and by when, and which assets are
 * still outstanding.
 */
export interface RecoveryCase {
  readonly recoveryId: Hex32;
  readonly migrationId: Hex32;
  readonly policy: RecoveryPolicy;
  readonly status: RecoveryCaseStatus;
  readonly reason: string;
  /*
   * The responsibility lifecycle. Always sent by the current API; absent from
   * a case recorded before 2026-11-13, so each is rendered only when present.
   */
  readonly nextPermittedAction?: RecoveryNextPermittedAction;
  readonly actionDeadline?: string;
  readonly escalationOwner?: string;
  readonly escalationState?: RecoveryEscalationState;
  readonly residualAssets: readonly Record<string, unknown>[];
  readonly openedAt: string;
  readonly resolvedAt: string | null;
}

export interface MigrationDetails {
  readonly migration: Migration;
  readonly evidence: readonly Evidence[];
  readonly events: readonly AuditEvent[];
  readonly commands: readonly Command[];
  readonly ledger: readonly LedgerEntry[];
  readonly reservations: readonly Record<string, unknown>[];
  /** Absent from payloads recorded before the recovery lifecycle existed. */
  readonly recoveryCases?: readonly RecoveryCase[];
}

/* ------------------------------------------------------- persisted diagnostics */

export interface PersistedPositionRow {
  readonly position: Record<string, unknown>;
  readonly market: Record<string, unknown>;
  readonly snapshot: Record<string, unknown> | null;
}

export interface MarketRow {
  readonly chainId: number;
  readonly protocol: string;
  readonly deployment: Address;
  readonly marketId: Hex32;
  readonly enabled: boolean;
  readonly [key: string]: unknown;
}
