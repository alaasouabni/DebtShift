import type { MigrationExecutionContext } from '@debtshift/database';
import {
  getExecutionPlanTypedData,
  type DebtShiftEnvironment,
  type Evidence,
} from '@debtshift/domain';
import type { TransportObservation } from '@debtshift/intents';
import { loadFoundryArtifact, type FoundryArtifact } from '@debtshift/protocols';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  keccak256,
  padHex,
  stringToHex,
  type Address,
  type Chain,
  type Hex,
  type PrivateKeyAccount,
  type PublicClient,
  type TransactionReceipt,
  type Transport,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import {
  PostSourceCapacityDeteriorationError,
  PreSourceCapacityDeteriorationError,
  type ChainCanonicalityFailure,
  type FinalizedChainAction,
  type MigrationExecutionPort,
} from '../handlers.js';

type LocalPublicClient = PublicClient<Transport, Chain>;
type LocalWalletClient = WalletClient<Transport, Chain, PrivateKeyAccount>;

interface LocalArtifacts {
  readonly token: FoundryArtifact;
  readonly vault: FoundryArtifact;
  readonly escrow: FoundryArtifact;
  readonly sourceLending: FoundryArtifact;
  readonly targetLending: FoundryArtifact;
  readonly sourceAdapter: FoundryArtifact;
  readonly destinationAdapter: FoundryArtifact;
}

type FinancingCheckpoint =
  | 'BEFORE_RESERVATION'
  | 'AFTER_RESERVATION'
  | 'BEFORE_SOURCE_CLOSE'
  | 'AFTER_SOURCE_CLOSE'
  | 'BEFORE_TARGET_BORROW'
  | 'AFTER_TARGET_BORROW'
  | 'BEFORE_SETTLEMENT'
  | 'AFTER_SETTLEMENT';

interface FinancingRevalidation extends Readonly<Record<string, unknown>> {
  readonly checkpoint: FinancingCheckpoint;
  readonly observedAt: string;
  readonly originalCapacityEvidenceHash: string;
  readonly sourceState: 'OPEN_MATCHED' | 'CLOSED';
  readonly destinationCollateralUnits: string;
  readonly collateralPriceInDebtWad: string;
  readonly collateralValueUnits: string;
  readonly protocolMaximumLtvBps: number;
  readonly observedTargetBorrowAprBps: number;
  readonly maximumTargetBorrowAprBps: number;
  readonly policyFailureCodes: readonly string[];
  readonly protocolBorrowCapacityUnits: string;
  readonly policyBorrowCapacityUnits: string;
  readonly liquidityBorrowCapacityUnits: string;
  readonly signedBorrowCapacityUnits: string;
  readonly maximumSafeBorrowingCapacityUnits: string;
  readonly confirmedExternalFundingUnits: string;
  readonly solverPrincipalUnits: string;
  readonly solverFeeUnits: string;
  readonly capitalizedCostUnits: string;
  readonly totalRequiredUnits: string;
  readonly requiredDestinationBorrowUnits: string;
  readonly fundingShortfallUnits: string;
}

interface EscrowFundingRecord {
  readonly evidenceHash: Hex;
  readonly chainId: bigint;
  readonly token: Address;
  readonly depositor: Address;
  readonly refundReceiver: Address;
  readonly amountUnits: bigint;
  readonly authorizedUseHash: Hex;
  readonly deadline: bigint;
  readonly status: number;
}

interface SolverExposure {
  readonly principalReceivableUnits: bigint;
  readonly feeClaimUnits: bigint;
  readonly totalClaimUnits: bigint;
  readonly reservationStatus: number;
  readonly recoveryReserveProvider: Address;
  readonly recoveryReserveUnits: bigint;
}

interface SourceFeasibilityEvidenceInput {
  readonly planHash: Hex;
  readonly analysisHash: Hex;
  readonly externalFundingEvidenceHash: Hex;
  readonly liquidityAsset: Address;
  readonly solverPrincipalUnits: bigint;
  readonly solverFeeUnits: bigint;
  readonly capitalizedCostUnits: bigint;
  readonly totalRequiredUnits: bigint;
  readonly confirmedExternalFundingUnits: bigint;
  readonly maximumSafeBorrowingCapacityUnits: bigint;
  readonly requiredDestinationBorrowUnits: bigint;
  readonly fundingShortfallUnits: bigint;
  readonly sequence: bigint;
  readonly evaluatedAt: bigint;
  readonly validUntil: bigint;
}

class FinancingCapacityFailure extends Error {
  override readonly name = 'FinancingCapacityFailure';

  constructor(readonly revalidation: FinancingRevalidation) {
    super(
      `Fresh financing has ${revalidation.fundingShortfallUnits} settlement units of shortfall at ${revalidation.checkpoint}.`,
    );
  }
}

const eventTopics = {
  liquidityReserved: eventTopic(
    'LiquidityReserved(bytes32,address,address,uint256,uint256,uint64)',
  ),
  sourceClosed: eventTopic('SourceClosed(bytes32,address,uint256,uint256)'),
  balanceReleased: eventTopic('BalanceReleased(bytes32,address,address,uint256)'),
  collateralAssigned: eventTopic('CollateralAssigned(bytes32,address,address,uint256)'),
  destinationOpened: eventTopic('DestinationOpened(bytes32,address,bytes32,uint256,uint256)'),
  liquiditySettled: eventTopic('LiquiditySettled(bytes32,uint256,uint256)'),
  reservationReleased: eventTopic('ReservationReleased(bytes32)'),
} as const;

/**
 * Executes only the disposable dual-Anvil workflow. This port is deliberately
 * unavailable in any funded mainnet mode; production adapters use separate ports.
 */
export class DualAnvilSandboxExecutionPort implements MigrationExecutionPort {
  readonly #environment: DebtShiftEnvironment;
  readonly #account: PrivateKeyAccount;
  readonly #sourceChain: Chain;
  readonly #destinationChain: Chain;
  readonly #sourcePublic: LocalPublicClient;
  readonly #destinationPublic: LocalPublicClient;
  readonly #sourceWallet: LocalWalletClient;
  readonly #destinationWallet: LocalWalletClient;
  readonly #artifacts: Promise<LocalArtifacts>;

  constructor(environment: DebtShiftEnvironment) {
    if (environment.DEBTSHIFT_MODE !== 'sandbox') {
      throw new Error(
        'The dual-Anvil contract sandbox execution port is available only in sandbox mode.',
      );
    }
    if (
      environment.TRANSPORT_PROVIDER !== 'DEBTSHIFT_SIMULATOR' ||
      environment.INTENTS_MODE !== 'simulated'
    ) {
      throw new Error(
        'The dual-Anvil contract sandbox requires the explicitly simulated external transport adapter.',
      );
    }
    if (environment.SANDBOX_EXECUTOR_PRIVATE_KEY.length === 0) {
      throw new Error('SANDBOX_EXECUTOR_PRIVATE_KEY is required by the contract sandbox worker.');
    }

    this.#environment = environment;
    this.#account = privateKeyToAccount(environment.SANDBOX_EXECUTOR_PRIVATE_KEY as Hex);
    this.#sourceChain = localChain(
      environment.SOURCE_CHAIN_ID,
      'DebtShift source',
      environment.SOURCE_RPC_URL,
    );
    this.#destinationChain = localChain(
      environment.DESTINATION_CHAIN_ID,
      'DebtShift destination',
      environment.DESTINATION_RPC_URL,
    );
    this.#sourcePublic = createPublicClient({
      chain: this.#sourceChain,
      transport: http(environment.SOURCE_RPC_URL),
    });
    this.#destinationPublic = createPublicClient({
      chain: this.#destinationChain,
      transport: http(environment.DESTINATION_RPC_URL),
    });
    this.#sourceWallet = createWalletClient({
      account: this.#account,
      chain: this.#sourceChain,
      transport: http(environment.SOURCE_RPC_URL),
    });
    this.#destinationWallet = createWalletClient({
      account: this.#account,
      chain: this.#destinationChain,
      transport: http(environment.DESTINATION_RPC_URL),
    });
    this.#artifacts = loadArtifacts();
  }

  async verifyCanonicalEvidence(
    records: readonly Evidence[],
  ): Promise<readonly ChainCanonicalityFailure[]> {
    const failures: ChainCanonicalityFailure[] = [];
    for (const evidence of records) {
      if (
        evidence.chainId === undefined ||
        evidence.blockNumber === undefined ||
        evidence.blockHash === undefined
      ) {
        continue;
      }
      const client = this.#clientForChain(evidence.chainId);
      const requiredConfirmations = this.#confirmationsForChain(evidence.chainId);
      const observedAt = new Date().toISOString();
      if (client === undefined || requiredConfirmations === undefined) {
        failures.push({
          evidence,
          reason: 'UNSUPPORTED_CHAIN_ID',
          observedAt,
          requiredConfirmations: 0,
          observedTipBlockNumber: '0',
        });
        continue;
      }
      const observedTip = await client.getBlockNumber();
      let observedBlockHash: Hex | undefined;
      try {
        const block = await client.getBlock({ blockNumber: BigInt(evidence.blockNumber) });
        observedBlockHash = block.hash ?? undefined;
      } catch {
        failures.push({
          evidence,
          reason: 'CANONICAL_BLOCK_NOT_FOUND',
          observedAt,
          requiredConfirmations,
          observedTipBlockNumber: observedTip.toString(),
        });
        continue;
      }
      if (observedBlockHash?.toLowerCase() !== evidence.blockHash.toLowerCase()) {
        failures.push({
          evidence,
          reason: 'CANONICAL_BLOCK_HASH_MISMATCH',
          observedAt,
          requiredConfirmations,
          observedTipBlockNumber: observedTip.toString(),
          ...(observedBlockHash === undefined ? {} : { observedBlockHash }),
        });
        continue;
      }
      const observedConfirmations =
        observedTip >= BigInt(evidence.blockNumber)
          ? observedTip - BigInt(evidence.blockNumber) + 1n
          : 0n;
      if (observedConfirmations < BigInt(requiredConfirmations)) {
        failures.push({
          evidence,
          reason: 'FINALITY_DEPTH_LOST',
          observedAt,
          requiredConfirmations,
          observedTipBlockNumber: observedTip.toString(),
          observedBlockHash,
        });
        continue;
      }
      if (evidence.transactionHash === undefined) continue;
      try {
        const receipt = await client.getTransactionReceipt({ hash: evidence.transactionHash });
        if (
          receipt.status !== 'success' ||
          receipt.blockNumber.toString() !== evidence.blockNumber ||
          receipt.blockHash.toLowerCase() !== evidence.blockHash.toLowerCase()
        ) {
          failures.push({
            evidence,
            reason:
              receipt.status === 'success'
                ? 'TRANSACTION_RECEIPT_MOVED_OR_REPLACED'
                : 'TRANSACTION_RECEIPT_REVERTED',
            observedAt,
            requiredConfirmations,
            observedTipBlockNumber: observedTip.toString(),
            observedBlockHash,
            observedReceiptBlockNumber: receipt.blockNumber.toString(),
            observedReceiptBlockHash: receipt.blockHash,
          });
        }
      } catch {
        failures.push({
          evidence,
          reason: 'TRANSACTION_RECEIPT_NOT_FOUND',
          observedAt,
          requiredConfirmations,
          observedTipBlockNumber: observedTip.toString(),
          observedBlockHash,
        });
      }
    }
    return failures;
  }

  async reserve(context: MigrationExecutionContext): Promise<FinalizedChainAction> {
    this.#assertContext(context);
    const artifacts = await this.#artifacts;
    const migrationId = context.migration.migrationId as Hex;
    const existing = await this.#eventAction(
      this.#sourcePublic,
      this.#environment.SOURCE_CHAIN_ID,
      this.#environment.SOURCE_VAULT_ADDRESS,
      eventTopics.liquidityReserved,
      [migrationId, addressTopic(this.#environment.SOURCE_DEBT_TOKEN_ADDRESS)],
      { action: 'reserve', reconciled: true },
    );
    if (existing !== undefined) {
      this.#assertRecoveryReserve(
        await this.#readSolverExposure(artifacts.vault, migrationId),
        context,
        1,
      );
      return withFinancingRevalidation(
        existing,
        await this.#revalidateFinancing(context, artifacts, 'AFTER_RESERVATION'),
      );
    }

    const plan = context.signedPlan.plan;
    const financingRevalidation = await this.#revalidateFinancing(
      context,
      artifacts,
      'BEFORE_RESERVATION',
    );
    const proof = await this.#recordFeasibility(context, artifacts, financingRevalidation);
    const recoveryReserveUnits = BigInt(plan.principalMaxUnits) + BigInt(plan.feeMaxUnits);
    const auxiliaryTransactions = await this.#ensureTokenBalance(
      this.#sourceWallet,
      this.#sourcePublic,
      artifacts.token,
      this.#environment.SOURCE_DEBT_TOKEN_ADDRESS,
      recoveryReserveUnits,
    );
    auxiliaryTransactions.push(
      await this.#writeHash(
        this.#sourceWallet,
        this.#sourcePublic,
        artifacts.token,
        this.#environment.SOURCE_DEBT_TOKEN_ADDRESS,
        'approve',
        [this.#environment.SOURCE_VAULT_ADDRESS, recoveryReserveUnits],
      ),
    );
    const action = await this.#writeAction(
      this.#sourceWallet,
      this.#sourcePublic,
      this.#environment.SOURCE_CHAIN_ID,
      artifacts.vault,
      this.#environment.SOURCE_VAULT_ADDRESS,
      'reserve',
      [
        migrationId,
        this.#environment.SOURCE_DEBT_TOKEN_ADDRESS,
        this.#environment.SOURCE_ADAPTER_ADDRESS,
        context.signedPlan.planHash,
        proof.feasibilityHash,
        BigInt(plan.principalMaxUnits),
        BigInt(plan.feeMaxUnits),
        BigInt(plan.deadline),
      ],
      {
        action: 'reserve',
        principalUnits: plan.principalMaxUnits,
        feeCapUnits: plan.feeMaxUnits,
        recoveryReserveProvider: this.#account.address,
        recoveryReserveUnits: recoveryReserveUnits.toString(),
        auxiliaryTransactions,
        planHash: context.signedPlan.planHash,
        feasibilityHash: proof.feasibilityHash,
        feasibilityTransactionHash: proof.transactionHash,
        financingRevalidation,
      },
    );
    this.#assertRecoveryReserve(
      await this.#readSolverExposure(artifacts.vault, migrationId),
      context,
      1,
    );
    return action;
  }

  async closeSource(context: MigrationExecutionContext): Promise<FinalizedChainAction> {
    this.#assertContext(context);
    const artifacts = await this.#artifacts;
    const plan = context.signedPlan.plan;
    const migrationId = context.migration.migrationId as Hex;
    const existing = await this.#eventAction(
      this.#sourcePublic,
      this.#environment.SOURCE_CHAIN_ID,
      this.#environment.SOURCE_ADAPTER_ADDRESS,
      eventTopics.sourceClosed,
      [migrationId, addressTopic(plan.borrower)],
      { action: 'closeSource', reconciled: true },
    );
    if (existing !== undefined) {
      return withFinancingRevalidation(
        existing,
        await this.#revalidateFinancing(context, artifacts, 'AFTER_SOURCE_CLOSE'),
      );
    }

    let financingRevalidation: FinancingRevalidation;
    try {
      financingRevalidation = await this.#revalidateFinancing(
        context,
        artifacts,
        'BEFORE_SOURCE_CLOSE',
      );
    } catch (error) {
      if (!(error instanceof FinancingCapacityFailure)) throw error;
      throw new PreSourceCapacityDeteriorationError(
        await this.#releaseFailedReservation(context, artifacts, error.revalidation),
      );
    }
    const proof = await this.#recordFeasibility(context, artifacts, financingRevalidation);
    const authorization = getExecutionPlanTypedData(
      plan,
      this.#environment.EIP712_VERIFYING_CONTRACT,
    ).message;

    return this.#writeAction(
      this.#sourceWallet,
      this.#sourcePublic,
      this.#environment.SOURCE_CHAIN_ID,
      artifacts.sourceAdapter,
      this.#environment.SOURCE_ADAPTER_ADDRESS,
      'closeSource',
      [authorization, context.signedPlan.signature],
      {
        action: 'closeSource',
        borrower: plan.borrower,
        maximumDebtUnits: plan.sourceRepaymentMaxUnits,
        minimumCollateralUnits: plan.sourceCollateralMinUnits,
        planHash: context.signedPlan.planHash,
        feasibilityHash: proof.feasibilityHash,
        feasibilityTransactionHash: proof.transactionHash,
        financingRevalidation,
      },
    );
  }

  async dispatchTransport(context: MigrationExecutionContext): Promise<FinalizedChainAction> {
    this.#assertContext(context);
    const artifacts = await this.#artifacts;
    const migrationId = context.migration.migrationId as Hex;
    const existing = await this.#eventAction(
      this.#sourcePublic,
      this.#environment.SOURCE_CHAIN_ID,
      this.#environment.SOURCE_ESCROW_ADDRESS,
      eventTopics.balanceReleased,
      [
        migrationId,
        addressTopic(this.#environment.SOURCE_COLLATERAL_TOKEN_ADDRESS),
        addressTopic(this.#account.address),
      ],
      { action: 'dispatchTransport', reconciled: true },
    );
    if (existing !== undefined) return existing;

    return this.#writeAction(
      this.#sourceWallet,
      this.#sourcePublic,
      this.#environment.SOURCE_CHAIN_ID,
      artifacts.escrow,
      this.#environment.SOURCE_ESCROW_ADDRESS,
      'release',
      [
        migrationId,
        this.#environment.SOURCE_COLLATERAL_TOKEN_ADDRESS,
        this.#account.address,
        BigInt(context.quote.amountInUnits),
      ],
      {
        action: 'dispatchTransport',
        provider: 'DEBTSHIFT_SIMULATOR',
        amountInUnits: context.quote.amountInUnits,
        custodyReceiver: this.#account.address,
      },
    );
  }

  async deliverDestination(
    context: MigrationExecutionContext,
    observation: TransportObservation,
  ): Promise<FinalizedChainAction> {
    this.#assertContext(context);
    const artifacts = await this.#artifacts;
    const migrationId = context.migration.migrationId as Hex;
    const existing = await this.#eventAction(
      this.#destinationPublic,
      this.#environment.DESTINATION_CHAIN_ID,
      this.#environment.DESTINATION_ESCROW_ADDRESS,
      eventTopics.collateralAssigned,
      [
        migrationId,
        addressTopic(this.#environment.DESTINATION_COLLATERAL_TOKEN_ADDRESS),
        addressTopic(this.#account.address),
      ],
      { action: 'deliverDestination', reconciled: true },
    );
    if (existing !== undefined) return existing;

    const amount = BigInt(observation.observedAmountOutUnits);
    const auxiliaryTransactions = await this.#ensureTokenBalance(
      this.#destinationWallet,
      this.#destinationPublic,
      artifacts.token,
      this.#environment.DESTINATION_COLLATERAL_TOKEN_ADDRESS,
      amount,
    );
    auxiliaryTransactions.push(
      await this.#writeHash(
        this.#destinationWallet,
        this.#destinationPublic,
        artifacts.token,
        this.#environment.DESTINATION_COLLATERAL_TOKEN_ADDRESS,
        'approve',
        [this.#environment.DESTINATION_ESCROW_ADDRESS, amount],
      ),
    );
    return this.#writeAction(
      this.#destinationWallet,
      this.#destinationPublic,
      this.#environment.DESTINATION_CHAIN_ID,
      artifacts.escrow,
      this.#environment.DESTINATION_ESCROW_ADDRESS,
      'assign',
      [
        migrationId,
        this.#environment.DESTINATION_COLLATERAL_TOKEN_ADDRESS,
        this.#account.address,
        amount,
      ],
      {
        action: 'deliverDestination',
        amountOutUnits: observation.observedAmountOutUnits,
        auxiliaryTransactions,
      },
    );
  }

  async openTarget(context: MigrationExecutionContext): Promise<FinalizedChainAction> {
    this.#assertContext(context);
    const artifacts = await this.#artifacts;
    const plan = context.signedPlan.plan;
    const migrationId = context.migration.migrationId as Hex;
    const existing = await this.#eventAction(
      this.#destinationPublic,
      this.#environment.DESTINATION_CHAIN_ID,
      this.#environment.DESTINATION_ADAPTER_ADDRESS,
      eventTopics.destinationOpened,
      [migrationId, addressTopic(plan.borrower)],
      { action: 'openTarget', reconciled: true },
    );
    if (existing !== undefined) {
      return withFinancingRevalidation(
        existing,
        await this.#revalidateFinancing(context, artifacts, 'AFTER_TARGET_BORROW'),
      );
    }

    if (context.transportLeg.observedOutputUnits === null) {
      throw new Error('Destination collateral has not been independently observed.');
    }
    let financingRevalidation: FinancingRevalidation;
    try {
      financingRevalidation = await this.#revalidateFinancing(
        context,
        artifacts,
        'BEFORE_TARGET_BORROW',
      );
    } catch (error) {
      if (!(error instanceof FinancingCapacityFailure)) throw error;
      throw new PostSourceCapacityDeteriorationError(
        await this.#recordCapacityDeterioration(context, artifacts, error.revalidation),
      );
    }
    const proof = await this.#recordDestinationFeasibility(
      context,
      artifacts,
      financingRevalidation,
    );
    const borrowUnits = BigInt(financingRevalidation.requiredDestinationBorrowUnits);
    const authorization = getExecutionPlanTypedData(
      plan,
      this.#environment.EIP712_VERIFYING_CONTRACT,
    ).message;
    const fundingEvidenceHash = this.#fundingEvidenceHash(context);
    return this.#writeAction(
      this.#destinationWallet,
      this.#destinationPublic,
      this.#environment.DESTINATION_CHAIN_ID,
      artifacts.destinationAdapter,
      this.#environment.DESTINATION_ADAPTER_ADDRESS,
      'openDestination',
      [
        authorization,
        context.signedPlan.signature,
        {
          sourceChainId: this.#environment.SOURCE_CHAIN_ID,
          sourceAdapter: this.#environment.SOURCE_ADAPTER_ADDRESS,
          collateralUnits: BigInt(context.transportLeg.observedOutputUnits),
          borrowUnits,
          feasibilityHash: proof.feasibilityHash,
          fundingEvidenceHash,
          solverPrincipalUnits: BigInt(financingRevalidation.solverPrincipalUnits),
          solverFeeUnits: BigInt(financingRevalidation.solverFeeUnits),
          capitalizedCostUnits: BigInt(financingRevalidation.capitalizedCostUnits),
          capitalizedCostReceiver: '0x0000000000000000000000000000000000000000',
          lendingAuthorization: context.targetLendingAuthorization.encodedAuthorization,
        },
      ],
      {
        action: 'openTarget',
        borrower: plan.borrower,
        collateralUnits: context.transportLeg.observedOutputUnits,
        borrowUnits: borrowUnits.toString(),
        feasibilityHash: proof.feasibilityHash,
        feasibilityTransactionHash: proof.transactionHash,
        fundingEvidenceHash,
        financingRevalidation,
      },
    );
  }

  async settleLiquidity(context: MigrationExecutionContext): Promise<FinalizedChainAction> {
    this.#assertContext(context);
    const artifacts = await this.#artifacts;
    const plan = context.signedPlan.plan;
    const migrationId = context.migration.migrationId as Hex;
    const existing = await this.#eventAction(
      this.#sourcePublic,
      this.#environment.SOURCE_CHAIN_ID,
      this.#environment.SOURCE_VAULT_ADDRESS,
      eventTopics.liquiditySettled,
      [migrationId],
      { action: 'settleLiquidity', reconciled: true },
    );
    if (existing !== undefined) {
      return withFinancingRevalidation(
        existing,
        await this.#revalidateFinancing(context, artifacts, 'AFTER_SETTLEMENT'),
      );
    }

    const financingRevalidation = await this.#revalidateFinancing(
      context,
      artifacts,
      'BEFORE_SETTLEMENT',
    );
    const proof = await this.#recordFeasibility(context, artifacts, financingRevalidation);

    const exposure = await this.#readSolverExposure(artifacts.vault, migrationId);
    this.#assertRecoveryReserve(exposure, context, 2);
    const repayment = exposure.principalReceivableUnits + exposure.feeClaimUnits;
    return this.#writeAction(
      this.#sourceWallet,
      this.#sourcePublic,
      this.#environment.SOURCE_CHAIN_ID,
      artifacts.vault,
      this.#environment.SOURCE_VAULT_ADDRESS,
      'settle',
      [migrationId, this.#account.address, BigInt(plan.feeMaxUnits)],
      {
        action: 'settleLiquidity',
        repaymentUnits: repayment.toString(),
        feeUnits: plan.feeMaxUnits,
        recoveryReserveProvider: exposure.recoveryReserveProvider,
        recoveryReserveMaximumUnits: exposure.recoveryReserveUnits.toString(),
        feasibilityHash: proof.feasibilityHash,
        feasibilityTransactionHash: proof.transactionHash,
        financingRevalidation,
      },
    );
  }

  async executeRecovery(
    context: MigrationExecutionContext,
    reason: string,
  ): Promise<FinalizedChainAction> {
    this.#assertContext(context);
    const artifacts = await this.#artifacts;
    const plan = context.signedPlan.plan;
    const migrationId = context.migration.migrationId as Hex;
    const existingDestinationRelease = await this.#eventAction(
      this.#destinationPublic,
      this.#environment.DESTINATION_CHAIN_ID,
      this.#environment.DESTINATION_ESCROW_ADDRESS,
      eventTopics.balanceReleased,
      [
        migrationId,
        addressTopic(this.#environment.DESTINATION_COLLATERAL_TOKEN_ADDRESS),
        addressTopic(plan.refundReceiver),
      ],
      {
        action: 'executeRecovery',
        reason,
        custodyLocation: 'DESTINATION_ESCROW',
        reconciled: true,
      },
    );
    const existingSourceRelease = await this.#eventAction(
      this.#sourcePublic,
      this.#environment.SOURCE_CHAIN_ID,
      this.#environment.SOURCE_ESCROW_ADDRESS,
      eventTopics.balanceReleased,
      [
        migrationId,
        addressTopic(this.#environment.SOURCE_COLLATERAL_TOKEN_ADDRESS),
        addressTopic(plan.refundReceiver),
      ],
      {
        action: 'executeRecovery',
        reason,
        custodyLocation: 'SOURCE_ESCROW',
        reconciled: true,
      },
    );
    if (existingDestinationRelease !== undefined) {
      return this.#withRecoveryReserveSettlement(existingDestinationRelease, context, artifacts);
    }
    if (existingSourceRelease !== undefined) {
      return this.#withRecoveryReserveSettlement(existingSourceRelease, context, artifacts);
    }

    const destinationCollateral = await this.#readBigInt(
      this.#destinationPublic,
      artifacts.escrow,
      this.#environment.DESTINATION_ESCROW_ADDRESS,
      'categorizedBalances',
      [migrationId, this.#environment.DESTINATION_COLLATERAL_TOKEN_ADDRESS, 0],
    );
    if (destinationCollateral > 0n) {
      const solverExposure = await this.#readSolverExposure(artifacts.vault, migrationId);
      const recoveryAction = await this.#writeAction(
        this.#destinationWallet,
        this.#destinationPublic,
        this.#environment.DESTINATION_CHAIN_ID,
        artifacts.escrow,
        this.#environment.DESTINATION_ESCROW_ADDRESS,
        'release',
        [
          migrationId,
          this.#environment.DESTINATION_COLLATERAL_TOKEN_ADDRESS,
          plan.refundReceiver,
          destinationCollateral,
        ],
        {
          action: 'executeRecovery',
          reason,
          policy: 'RETURN_KNOWN_COLLATERAL_PRESERVE_SOLVER_RECEIVABLE',
          custodyLocation: 'DESTINATION_ESCROW',
          refundReceiver: plan.refundReceiver,
          refundAsset: this.#environment.DESTINATION_COLLATERAL_TOKEN_ADDRESS,
          refundUnits: destinationCollateral.toString(),
          solverExposure: {
            asset: this.#environment.SOURCE_DEBT_TOKEN_ADDRESS,
            principalUnits: solverExposure.principalReceivableUnits.toString(),
            feeUnits: solverExposure.feeClaimUnits.toString(),
            totalClaimUnits: solverExposure.totalClaimUnits.toString(),
            disposition: 'UNSETTLED_EXPLICIT_CLAIM',
          },
        },
      );
      return this.#withRecoveryReserveSettlement(recoveryAction, context, artifacts);
    }

    const [sourceExposure, sourcePosition] = await Promise.all([
      this.#readSolverExposure(artifacts.vault, migrationId),
      this.#readPosition(
        this.#sourcePublic,
        artifacts.sourceLending,
        this.#environment.SOURCE_LENDING_ADDRESS,
        plan.borrower,
      ),
    ]);
    if (
      sourceExposure.reservationStatus === 1 &&
      sourcePosition[0] >= BigInt(plan.sourceCollateralMinUnits) &&
      sourcePosition[1] > 0n
    ) {
      return this.#writeAction(
        this.#sourceWallet,
        this.#sourcePublic,
        this.#environment.SOURCE_CHAIN_ID,
        artifacts.vault,
        this.#environment.SOURCE_VAULT_ADDRESS,
        'release',
        [migrationId],
        {
          action: 'executeRecovery',
          reason,
          policy: 'RELEASE_UNDRAWN_RESERVATION_SOURCE_UNCHANGED',
          borrower: plan.borrower,
          sourceCollateralUnits: sourcePosition[0].toString(),
          sourceDebtUnits: sourcePosition[1].toString(),
          recoveryReserveDisposition: 'REFUNDED_TO_PROVIDER',
        },
      );
    }

    const expectedRefund = BigInt(context.sourceSnapshot.collateralUnits);
    const currentlyAssigned = await this.#readBigInt(
      this.#sourcePublic,
      artifacts.escrow,
      this.#environment.SOURCE_ESCROW_ADDRESS,
      'balances',
      [migrationId, this.#environment.SOURCE_COLLATERAL_TOKEN_ADDRESS],
    );
    const auxiliaryTransactions: Hex[] = [];
    if (currentlyAssigned < expectedRefund) {
      const returnedAmount = expectedRefund - currentlyAssigned;
      auxiliaryTransactions.push(
        ...(await this.#ensureTokenBalance(
          this.#sourceWallet,
          this.#sourcePublic,
          artifacts.token,
          this.#environment.SOURCE_COLLATERAL_TOKEN_ADDRESS,
          returnedAmount,
        )),
      );
      auxiliaryTransactions.push(
        await this.#writeHash(
          this.#sourceWallet,
          this.#sourcePublic,
          artifacts.token,
          this.#environment.SOURCE_COLLATERAL_TOKEN_ADDRESS,
          'approve',
          [this.#environment.SOURCE_ESCROW_ADDRESS, returnedAmount],
        ),
      );
      auxiliaryTransactions.push(
        await this.#writeHash(
          this.#sourceWallet,
          this.#sourcePublic,
          artifacts.escrow,
          this.#environment.SOURCE_ESCROW_ADDRESS,
          'assign',
          [
            migrationId,
            this.#environment.SOURCE_COLLATERAL_TOKEN_ADDRESS,
            this.#account.address,
            returnedAmount,
          ],
        ),
      );
    }

    const refundable = await this.#readBigInt(
      this.#sourcePublic,
      artifacts.escrow,
      this.#environment.SOURCE_ESCROW_ADDRESS,
      'balances',
      [migrationId, this.#environment.SOURCE_COLLATERAL_TOKEN_ADDRESS],
    );
    if (refundable < expectedRefund) {
      throw new Error('Recovery custody does not contain the full authorized collateral refund.');
    }
    const recoveryAction = await this.#writeAction(
      this.#sourceWallet,
      this.#sourcePublic,
      this.#environment.SOURCE_CHAIN_ID,
      artifacts.escrow,
      this.#environment.SOURCE_ESCROW_ADDRESS,
      'release',
      [
        migrationId,
        this.#environment.SOURCE_COLLATERAL_TOKEN_ADDRESS,
        plan.refundReceiver,
        expectedRefund,
      ],
      {
        action: 'executeRecovery',
        reason,
        refundReceiver: plan.refundReceiver,
        refundUnits: expectedRefund.toString(),
        auxiliaryTransactions,
      },
    );
    return this.#withRecoveryReserveSettlement(recoveryAction, context, artifacts);
  }

  #assertContext(context: MigrationExecutionContext): void {
    const plan = context.signedPlan.plan;
    const expected = this.#environment;
    if (plan.sourceMarket.chainId !== expected.SOURCE_CHAIN_ID) {
      throw new Error('The authorized source chain does not match the local worker configuration.');
    }
    if (plan.targetMarket.chainId !== expected.DESTINATION_CHAIN_ID) {
      throw new Error(
        'The authorized destination chain does not match the local worker configuration.',
      );
    }
    if (
      !sameAddress(plan.sourceDebtAsset.address, expected.SOURCE_DEBT_TOKEN_ADDRESS) ||
      !sameAddress(plan.sourceCollateralAsset.address, expected.SOURCE_COLLATERAL_TOKEN_ADDRESS) ||
      !sameAddress(plan.destinationDebtAsset.address, expected.DESTINATION_DEBT_TOKEN_ADDRESS) ||
      !sameAddress(
        plan.destinationCollateralAsset.address,
        expected.DESTINATION_COLLATERAL_TOKEN_ADDRESS,
      )
    ) {
      throw new Error('The authorized assets do not match the deployed local contracts.');
    }
    if (!sameAddress(plan.destinationReceiver, expected.DESTINATION_ESCROW_ADDRESS)) {
      throw new Error('The destination receiver must be the configured destination escrow.');
    }
    if (!sameAddress(expected.EIP712_VERIFYING_CONTRACT, expected.SOURCE_ADAPTER_ADDRESS)) {
      throw new Error('The EIP-712 verifying contract must be the configured source adapter.');
    }
    if (plan.financing.fundingShortfallUnits !== '0') {
      throw new Error('The authorized financing structure has a non-zero funding shortfall.');
    }
    if (BigInt(plan.financing.capitalizedCostUnits) !== 0n) {
      throw new Error(
        'The local destination contract requires signed capitalized-cost recipients; none are present in this plan.',
      );
    }
    if (BigInt(plan.financing.validUntil) < BigInt(plan.deadline)) {
      throw new Error('Financing evidence expires before the execution plan.');
    }
    if (BigInt(context.quote.amountInUnits) > BigInt(context.sourceSnapshot.collateralUnits)) {
      throw new Error('The transport amount exceeds the observed source collateral.');
    }
  }

  async #revalidateFinancing(
    context: MigrationExecutionContext,
    artifacts: LocalArtifacts,
    checkpoint: FinancingCheckpoint,
  ): Promise<FinancingRevalidation> {
    const plan = context.signedPlan.plan;
    const financing = plan.financing;
    const nowSeconds = BigInt(Math.floor(Date.now() / 1_000));
    if (nowSeconds > BigInt(plan.deadline) || nowSeconds > BigInt(financing.validUntil)) {
      throw new Error(`Financing evidence expired at checkpoint ${checkpoint}.`);
    }

    const sourcePosition = await this.#readPosition(
      this.#sourcePublic,
      artifacts.sourceLending,
      this.#environment.SOURCE_LENDING_ADDRESS,
      plan.borrower,
    );
    const afterSourceClose =
      checkpoint === 'AFTER_SOURCE_CLOSE' ||
      checkpoint === 'BEFORE_TARGET_BORROW' ||
      checkpoint === 'AFTER_TARGET_BORROW' ||
      checkpoint === 'BEFORE_SETTLEMENT' ||
      checkpoint === 'AFTER_SETTLEMENT';
    if (afterSourceClose) {
      if (sourcePosition[0] !== 0n || sourcePosition[1] !== 0n) {
        throw new Error(`Source position is not closed at checkpoint ${checkpoint}.`);
      }
    } else if (
      sourcePosition[0] < BigInt(plan.sourceCollateralMinUnits) ||
      sourcePosition[1] === 0n ||
      sourcePosition[1] > BigInt(plan.sourceRepaymentMaxUnits)
    ) {
      throw new Error(`Source position changed before checkpoint ${checkpoint}.`);
    }

    const targetAlreadyOpen =
      checkpoint === 'AFTER_TARGET_BORROW' ||
      checkpoint === 'BEFORE_SETTLEMENT' ||
      checkpoint === 'AFTER_SETTLEMENT';
    let escrowFunding = 0n;
    const expectedExternalFunding = BigInt(financing.confirmedExternalFundingUnits);
    if (expectedExternalFunding > 0n) {
      const funding = this.#singleExternalFunding(context);
      if (
        !sameAddress(funding.escrow, this.#environment.DESTINATION_ESCROW_ADDRESS) ||
        !sameAddress(funding.asset.address, this.#environment.DESTINATION_DEBT_TOKEN_ADDRESS)
      ) {
        throw new Error(
          'Supplementary funding is not assigned to the configured settlement escrow.',
        );
      }
      if (nowSeconds > BigInt(funding.expiresAt)) {
        throw new Error(`Supplementary funding ${funding.fundingId} expired.`);
      }
      const record = await this.#readFundingRecord(
        artifacts.escrow,
        context.migration.migrationId as Hex,
      );
      if (
        record.evidenceHash.toLowerCase() !== funding.evidenceId.toLowerCase() ||
        record.chainId !== BigInt(this.#environment.DESTINATION_CHAIN_ID) ||
        !sameAddress(record.token, this.#environment.DESTINATION_DEBT_TOKEN_ADDRESS) ||
        !sameAddress(record.refundReceiver, funding.refundReceiver) ||
        record.amountUnits !== expectedExternalFunding ||
        record.authorizedUseHash.toLowerCase() !== funding.authorizedUse.toLowerCase() ||
        record.deadline !== BigInt(funding.expiresAt) ||
        record.status !== (targetAlreadyOpen ? 2 : 1)
      ) {
        throw new Error('Supplementary funding escrow evidence does not match the signed plan.');
      }
      if (!targetAlreadyOpen) {
        const activeBalance = await this.#readBigInt(
          this.#destinationPublic,
          artifacts.escrow,
          this.#environment.DESTINATION_ESCROW_ADDRESS,
          'balances',
          [context.migration.migrationId, this.#environment.DESTINATION_DEBT_TOKEN_ADDRESS],
        );
        if (activeBalance < expectedExternalFunding) {
          throw new Error(
            'Finalized supplementary funding is no longer present in settlement escrow.',
          );
        }
      }
      escrowFunding = expectedExternalFunding;
    }
    let solverPrincipal = BigInt(financing.solverPrincipalUnits);
    let solverFee = BigInt(financing.solverFeeUnits);
    if (afterSourceClose) {
      const exposure = await this.#readSolverExposure(
        artifacts.vault,
        context.migration.migrationId as Hex,
      );
      const expectedStatus = checkpoint === 'AFTER_SETTLEMENT' ? 3 : 2;
      if (
        exposure.reservationStatus !== expectedStatus ||
        exposure.principalReceivableUnits === 0n ||
        exposure.principalReceivableUnits > BigInt(plan.principalMaxUnits) ||
        exposure.feeClaimUnits !== BigInt(plan.feeMaxUnits)
      ) {
        throw new Error(`Source vault exposure is invalid at ${checkpoint}.`);
      }
      solverPrincipal = exposure.principalReceivableUnits;
      solverFee = exposure.feeClaimUnits;
    }
    const capitalizedCost = BigInt(financing.capitalizedCostUnits);
    const totalRequired = solverPrincipal + solverFee + capitalizedCost;
    const requiredBorrow = totalRequired > escrowFunding ? totalRequired - escrowFunding : 0n;
    const targetPosition = await this.#readPosition(
      this.#destinationPublic,
      artifacts.targetLending,
      this.#environment.DESTINATION_LENDING_ADDRESS,
      plan.borrower,
    );
    if (targetAlreadyOpen) {
      if (
        targetPosition[0] < BigInt(plan.minDestinationCollateralUnits) ||
        targetPosition[1] !== requiredBorrow
      ) {
        throw new Error(`Target position does not match signed financing at ${checkpoint}.`);
      }
    } else if (targetPosition[0] !== 0n || targetPosition[1] !== 0n) {
      throw new Error(`Target position already exists before checkpoint ${checkpoint}.`);
    }

    const collateralUnits = targetAlreadyOpen
      ? targetPosition[0]
      : context.transportLeg.observedOutputUnits === null
        ? BigInt(plan.minDestinationCollateralUnits)
        : BigInt(context.transportLeg.observedOutputUnits);
    if (collateralUnits < BigInt(plan.minDestinationCollateralUnits)) {
      throw new Error(`Destination collateral is below the signed minimum at ${checkpoint}.`);
    }
    const [priceWad, protocolMaximumLtv, targetBorrowAprBps, currentLiquidity] = await Promise.all([
      this.#readBigInt(
        this.#destinationPublic,
        artifacts.targetLending,
        this.#environment.DESTINATION_LENDING_ADDRESS,
        'collateralPriceInDebtWad',
        [],
      ),
      this.#readUnsigned(
        this.#destinationPublic,
        artifacts.targetLending,
        this.#environment.DESTINATION_LENDING_ADDRESS,
        'maximumLtvBps',
        [],
      ),
      this.#readUnsigned(
        this.#destinationPublic,
        artifacts.targetLending,
        this.#environment.DESTINATION_LENDING_ADDRESS,
        'borrowAprBps',
        [],
      ),
      this.#readBigInt(
        this.#destinationPublic,
        artifacts.token,
        this.#environment.DESTINATION_DEBT_TOKEN_ADDRESS,
        'balanceOf',
        [this.#environment.DESTINATION_LENDING_ADDRESS],
      ),
    ]);
    const collateralScale = 10n ** BigInt(plan.destinationCollateralAsset.decimals);
    const debtScale = 10n ** BigInt(plan.destinationDebtAsset.decimals);
    const collateralValue =
      (collateralUnits * priceWad * debtScale) / (collateralScale * 10n ** 18n);
    const stressedCollateralValue =
      (collateralValue * BigInt(10_000 - financing.stressCollateralDropBps)) / 10_000n;
    const protocolCapacity = (collateralValue * protocolMaximumLtv) / 10_000n;
    const safetyPolicy = context.signedIntent.intent.safetyPolicy;
    if (safetyPolicy.kind !== 'MAX_LTV_BPS') {
      throw new Error('The local Morpho simulator requires a signed maximum-LTV policy.');
    }
    const normalPolicyCapacity = (collateralValue * BigInt(safetyPolicy.maximumLtvBps)) / 10_000n;
    const stressPolicyCapacity =
      (stressedCollateralValue * BigInt(safetyPolicy.stressMaximumLtvBps)) / 10_000n;
    const maximumTargetBorrowAprBps = Math.max(
      0,
      context.sourceSnapshot.borrowAprBps - context.signedIntent.intent.minAprReductionBps,
    );
    const protocolMaximumLtvBps = Number(protocolMaximumLtv);
    const observedTargetBorrowAprBps = Number(targetBorrowAprBps);
    if (
      !Number.isSafeInteger(protocolMaximumLtvBps) ||
      !Number.isSafeInteger(observedTargetBorrowAprBps)
    ) {
      throw new Error(`Destination market parameters exceed safe integer bounds at ${checkpoint}.`);
    }
    const ratePolicyEligible = observedTargetBorrowAprBps <= maximumTargetBorrowAprBps;
    const policyFailureCodes = ratePolicyEligible ? [] : ['TARGET_RATE_EXCEEDS_SIGNED_MAXIMUM'];
    const collateralPolicyCapacity = minBigInt(normalPolicyCapacity, stressPolicyCapacity);
    const policyCapacity = ratePolicyEligible ? collateralPolicyCapacity : 0n;
    const preBorrowLiquidity = targetAlreadyOpen
      ? currentLiquidity + requiredBorrow
      : currentLiquidity;
    const liquidityCapacity =
      (preBorrowLiquidity * 10_000n) / BigInt(10_000 + financing.liquidityBufferBps);
    const signedCapacity = BigInt(financing.signedBorrowCapacityUnits);
    const maximumSafeCapacity = minBigInt(
      protocolCapacity,
      policyCapacity,
      liquidityCapacity,
      signedCapacity,
    );
    const availableFunding = maximumSafeCapacity + escrowFunding;
    const shortfall = totalRequired > availableFunding ? totalRequired - availableFunding : 0n;
    const revalidation: FinancingRevalidation = {
      checkpoint,
      observedAt: new Date().toISOString(),
      originalCapacityEvidenceHash: financing.capacityEvidenceHash,
      sourceState: afterSourceClose ? 'CLOSED' : 'OPEN_MATCHED',
      destinationCollateralUnits: collateralUnits.toString(),
      collateralPriceInDebtWad: priceWad.toString(),
      collateralValueUnits: collateralValue.toString(),
      protocolMaximumLtvBps,
      observedTargetBorrowAprBps,
      maximumTargetBorrowAprBps,
      policyFailureCodes,
      protocolBorrowCapacityUnits: protocolCapacity.toString(),
      policyBorrowCapacityUnits: policyCapacity.toString(),
      liquidityBorrowCapacityUnits: liquidityCapacity.toString(),
      signedBorrowCapacityUnits: signedCapacity.toString(),
      maximumSafeBorrowingCapacityUnits: maximumSafeCapacity.toString(),
      confirmedExternalFundingUnits: escrowFunding.toString(),
      solverPrincipalUnits: solverPrincipal.toString(),
      solverFeeUnits: solverFee.toString(),
      capitalizedCostUnits: capitalizedCost.toString(),
      totalRequiredUnits: totalRequired.toString(),
      requiredDestinationBorrowUnits: requiredBorrow.toString(),
      fundingShortfallUnits: shortfall.toString(),
    };
    if (requiredBorrow > maximumSafeCapacity || shortfall !== 0n) {
      throw new FinancingCapacityFailure(revalidation);
    }

    if (checkpoint === 'BEFORE_SETTLEMENT' || checkpoint === 'AFTER_SETTLEMENT') {
      const payoutBalance = await this.#readBigInt(
        this.#destinationPublic,
        artifacts.token,
        this.#environment.DESTINATION_DEBT_TOKEN_ADDRESS,
        'balanceOf',
        [plan.payoutReceiver],
      );
      if (payoutBalance < solverPrincipal + solverFee) {
        throw new Error('Settlement payout does not cover the signed total repayment obligation.');
      }
    }

    return revalidation;
  }

  async #recordCapacityDeterioration(
    context: MigrationExecutionContext,
    artifacts: LocalArtifacts,
    revalidation: FinancingRevalidation,
  ): Promise<FinalizedChainAction> {
    const migrationId = context.migration.migrationId as Hex;
    const proof = await this.#recordDestinationFeasibility(context, artifacts, revalidation);
    const receipt = await this.#destinationPublic.waitForTransactionReceipt({
      hash: proof.transactionHash,
      confirmations: this.#environment.DESTINATION_FINALITY_CONFIRMATIONS,
    });
    if (receipt.status !== 'success') {
      throw new Error(`Failed destination feasibility receipt reverted: ${proof.transactionHash}`);
    }

    const [collateralCustodyUnits, solverExposure] = await Promise.all([
      this.#readBigInt(
        this.#destinationPublic,
        artifacts.escrow,
        this.#environment.DESTINATION_ESCROW_ADDRESS,
        'categorizedBalances',
        [migrationId, this.#environment.DESTINATION_COLLATERAL_TOKEN_ADDRESS, 0],
      ),
      this.#readSolverExposure(artifacts.vault, migrationId),
    ]);
    const observedCollateral = BigInt(context.transportLeg.observedOutputUnits ?? '0');
    if (collateralCustodyUnits !== observedCollateral || observedCollateral === 0n) {
      throw new Error(
        'Destination collateral custody does not match the finalized transport observation.',
      );
    }

    const collateralCustody = {
      kind: 'COLLATERAL_CUSTODY',
      chainId: this.#environment.DESTINATION_CHAIN_ID,
      escrow: this.#environment.DESTINATION_ESCROW_ADDRESS,
      asset: this.#environment.DESTINATION_COLLATERAL_TOKEN_ADDRESS,
      amountUnits: collateralCustodyUnits.toString(),
      category: 'TRANSPORTED_COLLATERAL',
      disposition: 'HELD_FOR_SIGNED_RECOVERY',
    } as const;
    const solverReceivable = {
      kind: 'SOLVER_RECEIVABLE',
      chainId: this.#environment.SOURCE_CHAIN_ID,
      provider: this.#environment.SOURCE_VAULT_ADDRESS,
      asset: this.#environment.SOURCE_DEBT_TOKEN_ADDRESS,
      principalUnits: solverExposure.principalReceivableUnits.toString(),
      feeUnits: solverExposure.feeClaimUnits.toString(),
      totalClaimUnits: solverExposure.totalClaimUnits.toString(),
      reservationStatus: solverExposure.reservationStatus,
      disposition: 'UNSETTLED_EXPLICIT_CLAIM',
    } as const;
    const supplementaryFunding = context.signedPlan.plan.financing.externalFunding.map(
      (funding) => ({
        kind: 'SUPPLEMENTARY_FUNDING_CUSTODY',
        chainId: funding.asset.chainId,
        escrow: funding.escrow,
        asset: funding.asset.address,
        amountUnits: funding.amountUnits,
        evidenceId: funding.evidenceId,
        refundReceiver: funding.refundReceiver,
        deadline: funding.expiresAt,
        disposition: 'LOCKED_UNTIL_SIGNED_REFUND_CONDITION',
      }),
    );

    return finalizedAction(
      this.#environment.DESTINATION_CHAIN_ID,
      receipt,
      this.#environment.DESTINATION_FINALITY_CONFIRMATIONS,
      {
        action: 'recordCapacityDeterioration',
        reason: 'DESTINATION_CAPACITY_DETERIORATED_AFTER_SOURCE_CLOSE',
        policy: 'RETURN_KNOWN_COLLATERAL_PRESERVE_SOLVER_RECEIVABLE',
        failedFeasibility: {
          feasibilityHash: proof.feasibilityHash,
          transactionHash: proof.transactionHash,
        },
        financingRevalidation: revalidation,
        collateralCustody,
        solverExposure: solverReceivable,
        supplementaryFunding,
        residualAssets: [collateralCustody, solverReceivable, ...supplementaryFunding],
      },
    );
  }

  async #readSolverExposure(artifact: FoundryArtifact, migrationId: Hex): Promise<SolverExposure> {
    const result = await this.#sourcePublic.readContract({
      address: this.#environment.SOURCE_VAULT_ADDRESS,
      abi: artifact.abi,
      functionName: 'reservations',
      args: [migrationId],
    });
    const values = Array.isArray(result) ? result : undefined;
    const feeClaimUnits = values?.[4];
    const reservationStatus = values?.[6];
    const principalReceivableUnits = values?.[8];
    const recoveryReserveProvider = values?.[9];
    const recoveryReserveUnits = values?.[10];
    if (
      typeof feeClaimUnits !== 'bigint' ||
      (typeof reservationStatus !== 'number' && typeof reservationStatus !== 'bigint') ||
      typeof principalReceivableUnits !== 'bigint' ||
      typeof recoveryReserveProvider !== 'string' ||
      typeof recoveryReserveUnits !== 'bigint'
    ) {
      throw new Error('Unexpected source liquidity reservation response.');
    }
    return {
      principalReceivableUnits,
      feeClaimUnits,
      totalClaimUnits: principalReceivableUnits + feeClaimUnits,
      reservationStatus: Number(reservationStatus),
      recoveryReserveProvider: recoveryReserveProvider as Address,
      recoveryReserveUnits,
    };
  }

  #assertRecoveryReserve(
    exposure: SolverExposure,
    context: MigrationExecutionContext,
    expectedStatus: number,
  ): void {
    const plan = context.signedPlan.plan;
    const expectedUnits = BigInt(plan.principalMaxUnits) + BigInt(plan.feeMaxUnits);
    if (
      exposure.reservationStatus !== expectedStatus ||
      (expectedStatus === 1
        ? exposure.principalReceivableUnits !== 0n
        : exposure.principalReceivableUnits === 0n) ||
      !sameAddress(exposure.recoveryReserveProvider, this.#account.address) ||
      exposure.recoveryReserveUnits !== expectedUnits
    ) {
      throw new Error('The sandbox migration-specific recovery reserve is not fully locked.');
    }
  }

  async #withRecoveryReserveSettlement(
    action: FinalizedChainAction,
    context: MigrationExecutionContext,
    artifacts: LocalArtifacts,
  ): Promise<FinalizedChainAction> {
    const migrationId = context.migration.migrationId as Hex;
    const exposure = await this.#readSolverExposure(artifacts.vault, migrationId);
    if (exposure.reservationStatus === 3) {
      return {
        ...action,
        payload: {
          ...action.payload,
          recoveryReserveSettlement: { status: 'ALREADY_SETTLED' },
        },
      };
    }
    this.#assertRecoveryReserve(exposure, context, 2);
    const settlement = await this.#writeAction(
      this.#sourceWallet,
      this.#sourcePublic,
      this.#environment.SOURCE_CHAIN_ID,
      artifacts.vault,
      this.#environment.SOURCE_VAULT_ADDRESS,
      'settleFromRecoveryReserve',
      [migrationId],
      {
        action: 'settleRecoveryReserve',
        provider: exposure.recoveryReserveProvider,
        principalUnits: exposure.principalReceivableUnits.toString(),
        feeUnits: exposure.feeClaimUnits.toString(),
      },
    );
    return {
      ...action,
      payload: {
        ...action.payload,
        recoveryReserveSettlement: {
          status: 'SETTLED_FROM_ISOLATED_RESERVE',
          transactionHash: settlement.transactionHash,
          blockNumber: settlement.blockNumber,
          blockHash: settlement.blockHash,
          principalUnits: exposure.principalReceivableUnits.toString(),
          feeUnits: exposure.feeClaimUnits.toString(),
        },
      },
    };
  }

  async #releaseFailedReservation(
    context: MigrationExecutionContext,
    artifacts: LocalArtifacts,
    revalidation: FinancingRevalidation,
  ): Promise<FinalizedChainAction> {
    const migrationId = context.migration.migrationId as Hex;
    const existing = await this.#eventAction(
      this.#sourcePublic,
      this.#environment.SOURCE_CHAIN_ID,
      this.#environment.SOURCE_VAULT_ADDRESS,
      eventTopics.reservationReleased,
      [migrationId],
      { action: 'releaseFailedReservation', reconciled: true },
    );
    if (existing !== undefined) {
      return this.#releasedReservationAction(context, artifacts, revalidation, existing);
    }

    const evidence = await this.#buildSourceFeasibilityEvidence(context, artifacts, revalidation);
    const action = await this.#writeAction(
      this.#sourceWallet,
      this.#sourcePublic,
      this.#environment.SOURCE_CHAIN_ID,
      artifacts.vault,
      this.#environment.SOURCE_VAULT_ADDRESS,
      'recordFailedFeasibilityAndRelease',
      [migrationId, evidence],
      { action: 'releaseFailedReservation' },
    );
    return this.#releasedReservationAction(context, artifacts, revalidation, action);
  }

  async #releasedReservationAction(
    context: MigrationExecutionContext,
    artifacts: LocalArtifacts,
    revalidation: FinancingRevalidation,
    action: FinalizedChainAction,
  ): Promise<FinalizedChainAction> {
    const migrationId = context.migration.migrationId as Hex;
    const [feasibilityHash, reservation, sourcePosition] = await Promise.all([
      this.#readHex(
        this.#sourcePublic,
        artifacts.vault,
        this.#environment.SOURCE_VAULT_ADDRESS,
        'latestFeasibilityHash',
        [migrationId],
      ),
      this.#readSolverExposure(artifacts.vault, migrationId),
      this.#readPosition(
        this.#sourcePublic,
        artifacts.sourceLending,
        this.#environment.SOURCE_LENDING_ADDRESS,
        context.signedPlan.plan.borrower,
      ),
    ]);
    if (reservation.reservationStatus !== 4 || reservation.principalReceivableUnits !== 0n) {
      throw new Error('Failed feasibility did not release the undrawn source reservation.');
    }
    if (
      sourcePosition[0] < BigInt(context.signedPlan.plan.sourceCollateralMinUnits) ||
      sourcePosition[1] !== BigInt(context.signedPlan.plan.sourceRepaymentMaxUnits)
    ) {
      throw new Error('Source position changed during pre-source reservation release.');
    }
    return {
      ...action,
      payload: {
        ...action.payload,
        reason: 'DESTINATION_CAPACITY_DETERIORATED_BEFORE_SOURCE_CLOSE',
        outcome: 'REQUOTE_REQUIRED',
        feasibilityHash,
        financingRevalidation: revalidation,
        reservation: {
          provider: this.#environment.SOURCE_VAULT_ADDRESS,
          asset: this.#environment.SOURCE_DEBT_TOKEN_ADDRESS,
          principalUnits: context.signedPlan.plan.principalMaxUnits,
          feeCapUnits: context.signedPlan.plan.feeMaxUnits,
          status: 'RELEASED',
          principalReceivableUnits: '0',
        },
        sourcePosition: {
          borrower: context.signedPlan.plan.borrower,
          collateralUnits: sourcePosition[0].toString(),
          debtUnits: sourcePosition[1].toString(),
          disposition: 'UNCHANGED',
        },
      },
    };
  }

  async #recordFeasibility(
    context: MigrationExecutionContext,
    artifacts: LocalArtifacts,
    revalidation: FinancingRevalidation,
  ): Promise<{ readonly feasibilityHash: Hex; readonly transactionHash: Hex }> {
    const evidence = await this.#buildSourceFeasibilityEvidence(context, artifacts, revalidation);
    const transactionHash = await this.#writeHash(
      this.#sourceWallet,
      this.#sourcePublic,
      artifacts.vault,
      this.#environment.SOURCE_VAULT_ADDRESS,
      'recordFeasibility',
      [context.migration.migrationId, evidence],
    );
    const feasibilityHash = await this.#readHex(
      this.#sourcePublic,
      artifacts.vault,
      this.#environment.SOURCE_VAULT_ADDRESS,
      'latestFeasibilityHash',
      [context.migration.migrationId],
    );
    return { feasibilityHash, transactionHash };
  }

  async #buildSourceFeasibilityEvidence(
    context: MigrationExecutionContext,
    artifacts: LocalArtifacts,
    revalidation: FinancingRevalidation,
  ): Promise<SourceFeasibilityEvidenceInput> {
    const plan = context.signedPlan.plan;
    const financing = plan.financing;
    const externalFundingEvidenceHash = this.#fundingEvidenceHash(context);
    const sequence =
      (await this.#readBigInt(
        this.#sourcePublic,
        artifacts.vault,
        this.#environment.SOURCE_VAULT_ADDRESS,
        'latestFeasibilitySequence',
        [context.migration.migrationId],
      )) + 1n;
    const evaluatedAt = (await this.#sourcePublic.getBlock()).timestamp;
    return {
      planHash: context.signedPlan.planHash,
      analysisHash: keccak256(stringToHex(JSON.stringify(revalidation))),
      externalFundingEvidenceHash,
      liquidityAsset: this.#environment.SOURCE_DEBT_TOKEN_ADDRESS,
      solverPrincipalUnits: BigInt(revalidation.solverPrincipalUnits),
      solverFeeUnits: BigInt(revalidation.solverFeeUnits),
      capitalizedCostUnits: BigInt(revalidation.capitalizedCostUnits),
      totalRequiredUnits: BigInt(revalidation.totalRequiredUnits),
      confirmedExternalFundingUnits: BigInt(revalidation.confirmedExternalFundingUnits),
      maximumSafeBorrowingCapacityUnits: BigInt(revalidation.maximumSafeBorrowingCapacityUnits),
      requiredDestinationBorrowUnits: BigInt(revalidation.requiredDestinationBorrowUnits),
      fundingShortfallUnits: BigInt(revalidation.fundingShortfallUnits),
      sequence,
      evaluatedAt,
      validUntil: BigInt(financing.validUntil),
    };
  }

  async #recordDestinationFeasibility(
    context: MigrationExecutionContext,
    artifacts: LocalArtifacts,
    revalidation: FinancingRevalidation,
  ): Promise<{ readonly feasibilityHash: Hex; readonly transactionHash: Hex }> {
    const financing = context.signedPlan.plan.financing;
    const sequence =
      (await this.#readBigInt(
        this.#destinationPublic,
        artifacts.destinationAdapter,
        this.#environment.DESTINATION_ADAPTER_ADDRESS,
        'latestFeasibilitySequence',
        [context.migration.migrationId],
      )) + 1n;
    const evaluatedAt = (await this.#destinationPublic.getBlock()).timestamp;
    const evidence = {
      planHash: context.signedPlan.planHash,
      analysisHash: keccak256(stringToHex(JSON.stringify(revalidation))),
      externalFundingEvidenceHash: this.#fundingEvidenceHash(context),
      settlementAsset: this.#environment.DESTINATION_DEBT_TOKEN_ADDRESS,
      solverPrincipalUnits: BigInt(revalidation.solverPrincipalUnits),
      solverFeeUnits: BigInt(revalidation.solverFeeUnits),
      capitalizedCostUnits: BigInt(revalidation.capitalizedCostUnits),
      totalRequiredUnits: BigInt(revalidation.totalRequiredUnits),
      confirmedExternalFundingUnits: BigInt(revalidation.confirmedExternalFundingUnits),
      maximumSafeBorrowingCapacityUnits: BigInt(revalidation.maximumSafeBorrowingCapacityUnits),
      requiredDestinationBorrowUnits: BigInt(revalidation.requiredDestinationBorrowUnits),
      fundingShortfallUnits: BigInt(revalidation.fundingShortfallUnits),
      sequence,
      evaluatedAt,
      validUntil: BigInt(financing.validUntil),
    } as const;
    const transactionHash = await this.#writeHash(
      this.#destinationWallet,
      this.#destinationPublic,
      artifacts.destinationAdapter,
      this.#environment.DESTINATION_ADAPTER_ADDRESS,
      'recordFeasibility',
      [context.migration.migrationId, evidence],
    );
    const feasibilityHash = await this.#readHex(
      this.#destinationPublic,
      artifacts.destinationAdapter,
      this.#environment.DESTINATION_ADAPTER_ADDRESS,
      'latestFeasibilityHash',
      [context.migration.migrationId],
    );
    return { feasibilityHash, transactionHash };
  }

  #fundingEvidenceHash(context: MigrationExecutionContext): Hex {
    const financing = context.signedPlan.plan.financing;
    if (BigInt(financing.confirmedExternalFundingUnits) === 0n) {
      if (financing.externalFunding.length !== 0) {
        throw new Error('Zero external funding cannot include funding evidence.');
      }
      return `0x${'00'.repeat(32)}` as Hex;
    }
    return this.#singleExternalFunding(context).evidenceId as Hex;
  }

  #singleExternalFunding(context: MigrationExecutionContext) {
    const funding = context.signedPlan.plan.financing.externalFunding;
    if (funding.length !== 1 || funding[0] === undefined) {
      throw new Error(
        'The destination escrow currently requires exactly one signed supplementary-funding commitment.',
      );
    }
    return funding[0];
  }

  async #readFundingRecord(
    artifact: FoundryArtifact,
    migrationId: Hex,
  ): Promise<EscrowFundingRecord> {
    const result = await this.#destinationPublic.readContract({
      address: this.#environment.DESTINATION_ESCROW_ADDRESS,
      abi: artifact.abi,
      functionName: 'fundingRecord',
      args: [migrationId],
    });
    const record = Array.isArray(result)
      ? {
          evidenceHash: result[0],
          chainId: result[1],
          token: result[2],
          depositor: result[3],
          refundReceiver: result[4],
          amountUnits: result[5],
          authorizedUseHash: result[6],
          deadline: result[7],
          status: result[8],
        }
      : result;
    if (!isRecord(record)) {
      throw new Error('Unexpected supplementary-funding record response.');
    }
    const status = record.status;
    if (
      typeof record.evidenceHash !== 'string' ||
      typeof record.chainId !== 'bigint' ||
      typeof record.token !== 'string' ||
      typeof record.depositor !== 'string' ||
      typeof record.refundReceiver !== 'string' ||
      typeof record.amountUnits !== 'bigint' ||
      typeof record.authorizedUseHash !== 'string' ||
      typeof record.deadline !== 'bigint' ||
      (typeof status !== 'number' && typeof status !== 'bigint')
    ) {
      throw new Error('Malformed supplementary-funding record response.');
    }
    return {
      evidenceHash: record.evidenceHash as Hex,
      chainId: record.chainId,
      token: record.token as Address,
      depositor: record.depositor as Address,
      refundReceiver: record.refundReceiver as Address,
      amountUnits: record.amountUnits,
      authorizedUseHash: record.authorizedUseHash as Hex,
      deadline: record.deadline,
      status: Number(status),
    };
  }

  async #readPosition(
    client: LocalPublicClient,
    artifact: FoundryArtifact,
    address: Address,
    borrower: Address,
  ): Promise<readonly [bigint, bigint]> {
    const result = await client.readContract({
      address,
      abi: artifact.abi,
      functionName: 'positions',
      args: [borrower],
    });
    if (
      !Array.isArray(result) ||
      result.length !== 2 ||
      typeof result[0] !== 'bigint' ||
      typeof result[1] !== 'bigint'
    ) {
      throw new Error(`Unexpected position response from ${address}.`);
    }
    return [result[0], result[1]];
  }

  async #readUnsigned(
    client: LocalPublicClient,
    artifact: FoundryArtifact,
    address: Address,
    functionName: string,
    args: readonly unknown[],
  ): Promise<bigint> {
    const result = await client.readContract({ address, abi: artifact.abi, functionName, args });
    if (typeof result !== 'number' && typeof result !== 'bigint') {
      throw new Error(`Unexpected ${functionName} response from ${address}.`);
    }
    return BigInt(result);
  }

  async #ensureTokenBalance(
    wallet: LocalWalletClient,
    publicClient: LocalPublicClient,
    token: FoundryArtifact,
    address: Address,
    requiredUnits: bigint,
  ): Promise<Hex[]> {
    const balance = await this.#readBigInt(publicClient, token, address, 'balanceOf', [
      this.#account.address,
    ]);
    if (balance >= requiredUnits) return [];
    return [
      await this.#writeHash(wallet, publicClient, token, address, 'mint', [
        this.#account.address,
        requiredUnits - balance,
      ]),
    ];
  }

  async #readBigInt(
    client: LocalPublicClient,
    artifact: FoundryArtifact,
    address: Address,
    functionName: string,
    args: readonly unknown[],
  ): Promise<bigint> {
    const result = await client.readContract({
      address,
      abi: artifact.abi,
      functionName,
      args,
    });
    if (typeof result !== 'bigint') {
      throw new Error(`Unexpected ${functionName} response from ${address}.`);
    }
    return result;
  }

  async #readHex(
    client: LocalPublicClient,
    artifact: FoundryArtifact,
    address: Address,
    functionName: string,
    args: readonly unknown[],
  ): Promise<Hex> {
    const result = await client.readContract({
      address,
      abi: artifact.abi,
      functionName,
      args,
    });
    if (typeof result !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(result)) {
      throw new Error(`Unexpected ${functionName} response from ${address}.`);
    }
    return result as Hex;
  }

  async #writeHash(
    wallet: LocalWalletClient,
    publicClient: LocalPublicClient,
    artifact: FoundryArtifact,
    address: Address,
    functionName: string,
    args: readonly unknown[],
  ): Promise<Hex> {
    const transactionHash = await wallet.writeContract({
      account: wallet.account,
      chain: wallet.chain,
      address,
      abi: artifact.abi,
      functionName,
      args,
    });
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: transactionHash,
      confirmations: this.#confirmationsForClient(publicClient),
    });
    if (receipt.status !== 'success') {
      throw new Error(`${functionName} reverted: ${transactionHash}`);
    }
    return transactionHash;
  }

  async #writeAction(
    wallet: LocalWalletClient,
    publicClient: LocalPublicClient,
    chainId: number,
    artifact: FoundryArtifact,
    address: Address,
    functionName: string,
    args: readonly unknown[],
    payload: Record<string, unknown>,
  ): Promise<FinalizedChainAction> {
    const transactionHash = await wallet.writeContract({
      account: wallet.account,
      chain: wallet.chain,
      address,
      abi: artifact.abi,
      functionName,
      args,
    });
    const confirmations = this.#confirmationsForClient(publicClient);
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: transactionHash,
      confirmations,
    });
    if (receipt.status !== 'success') {
      throw new Error(`${functionName} reverted: ${transactionHash}`);
    }
    return finalizedAction(chainId, receipt, confirmations, payload);
  }

  async #eventAction(
    client: LocalPublicClient,
    chainId: number,
    address: Address,
    eventSignature: Hex,
    indexedTopics: readonly Hex[],
    payload: Record<string, unknown>,
  ): Promise<FinalizedChainAction | undefined> {
    const logs = await client.getLogs({ address, fromBlock: 0n, toBlock: 'latest' });
    const expectedTopics = [eventSignature, ...indexedTopics].map((topic) => topic.toLowerCase());
    const existing = logs.findLast((log) =>
      expectedTopics.every((topic, index) => log.topics[index]?.toLowerCase() === topic),
    );
    if (existing === undefined) return undefined;
    const confirmations = this.#confirmationsForClient(client);
    const receipt = await client.waitForTransactionReceipt({
      hash: existing.transactionHash,
      confirmations,
    });
    if (receipt.status !== 'success') {
      throw new Error(`Previously observed transaction reverted: ${existing.transactionHash}`);
    }
    return finalizedAction(chainId, receipt, confirmations, payload);
  }

  #clientForChain(chainId: number): LocalPublicClient | undefined {
    if (chainId === this.#environment.SOURCE_CHAIN_ID) return this.#sourcePublic;
    if (chainId === this.#environment.DESTINATION_CHAIN_ID) return this.#destinationPublic;
    return undefined;
  }

  #confirmationsForChain(chainId: number): number | undefined {
    if (chainId === this.#environment.SOURCE_CHAIN_ID) {
      return this.#environment.SOURCE_FINALITY_CONFIRMATIONS;
    }
    if (chainId === this.#environment.DESTINATION_CHAIN_ID) {
      return this.#environment.DESTINATION_FINALITY_CONFIRMATIONS;
    }
    return undefined;
  }

  #confirmationsForClient(client: LocalPublicClient): number {
    return client === this.#sourcePublic
      ? this.#environment.SOURCE_FINALITY_CONFIRMATIONS
      : this.#environment.DESTINATION_FINALITY_CONFIRMATIONS;
  }
}

function finalizedAction(
  chainId: number,
  receipt: TransactionReceipt,
  requiredConfirmations: number,
  payload: Record<string, unknown>,
): FinalizedChainAction {
  return {
    chainId,
    transactionHash: receipt.transactionHash,
    blockNumber: receipt.blockNumber.toString(),
    blockHash: receipt.blockHash,
    payload: {
      ...payload,
      finality: { requiredConfirmations, canonicalBlockVerified: true },
    },
  };
}

function eventTopic(signature: string): Hex {
  return keccak256(stringToHex(signature));
}

function addressTopic(address: Address): Hex {
  return padHex(address, { size: 32 });
}

function sameAddress(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function minBigInt(first: bigint, ...rest: readonly bigint[]): bigint {
  return rest.reduce((minimum, value) => (value < minimum ? value : minimum), first);
}

function withFinancingRevalidation(
  action: FinalizedChainAction,
  financingRevalidation: Record<string, unknown>,
): FinalizedChainAction {
  return { ...action, payload: { ...action.payload, financingRevalidation } };
}

function localChain(id: number, name: string, rpcUrl: string): Chain {
  return defineChain({
    id,
    name,
    nativeCurrency: { name: 'Local Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

async function loadArtifacts(): Promise<LocalArtifacts> {
  const [token, vault, escrow, sourceLending, targetLending, sourceAdapter, destinationAdapter] =
    await Promise.all([
      loadFoundryArtifact('TestToken'),
      loadFoundryArtifact('TestLiquidityVault'),
      loadFoundryArtifact('MigrationEscrow'),
      loadFoundryArtifact('MockSourceLending'),
      loadFoundryArtifact('MockTargetLending'),
      loadFoundryArtifact('SourceAdapter'),
      loadFoundryArtifact('DestinationAdapter'),
    ]);
  return {
    token,
    vault,
    escrow,
    sourceLending,
    targetLending,
    sourceAdapter,
    destinationAdapter,
  };
}
