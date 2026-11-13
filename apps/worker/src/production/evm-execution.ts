import type { MigrationExecutionContext } from '@debtshift/database';
import {
  getExecutionPlanTypedData,
  hashCanonicalText,
  parseLiveMarketConfiguration,
  type DebtShiftEnvironment,
  type Evidence,
} from '@debtshift/domain';
import type { TransportObservation } from '@debtshift/intents';
import {
  AaveV3ReadAdapter,
  ChainlinkOracleFreshnessReader,
  MorphoBlueReadAdapter,
  loadFoundryArtifact,
  readAaveReserveTokenAddresses,
  type FoundryArtifact,
} from '@debtshift/protocols';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeAbiParameters,
  getAddress,
  http,
  isAddressEqual,
  keccak256,
  padHex,
  parseAbiParameters,
  stringToHex,
  zeroAddress,
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
  PreSourceCloseFailureError,
  type ChainCanonicalityFailure,
  type FinalizedChainAction,
  type MigrationExecutionPort,
} from '../handlers.js';

type EvmPublicClient = PublicClient<Transport, Chain>;
type EvmWalletClient = WalletClient<Transport, Chain, PrivateKeyAccount>;

class PreBroadcastSimulationError extends Error {
  override readonly name = 'PreBroadcastSimulationError';

  constructor(functionName: string, cause: unknown) {
    super(`${functionName} failed during pre-broadcast simulation.`, { cause });
  }
}

class FinalizedTransactionRevertError extends Error {
  override readonly name = 'FinalizedTransactionRevertError';

  constructor(
    functionName: string,
    readonly transactionHash: Hex,
  ) {
    super(`${functionName} reverted in finalized transaction ${transactionHash}.`);
  }
}

interface ProductionArtifacts {
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
  readonly sourceState: 'OPEN_WITHIN_SIGNED_CAP' | 'CLOSED';
  readonly sourceDebtUnits: string;
  readonly destinationCollateralUnits: string;
  readonly collateralValueUnits: string;
  readonly protocolMaximumLtvBps: number;
  readonly observedTargetBorrowAprBps: number;
  readonly maximumTargetBorrowAprBps: number;
  readonly protocolBorrowCapacityUnits: string;
  readonly policyBorrowCapacityUnits: string;
  readonly liquidityBorrowCapacityUnits: string;
  readonly signedBorrowCapacityUnits: string;
  readonly maximumSafeBorrowingCapacityUnits: string;
  readonly confirmedExternalFundingUnits: string;
  readonly solverPrincipalUnits: string;
  readonly solverFeeUnits: string;
  readonly totalRequiredUnits: string;
  readonly requiredDestinationBorrowUnits: string;
  readonly fundingShortfallUnits: string;
  readonly policyFailureCodes: readonly string[];
  readonly marketBlockNumber: string;
  readonly marketBlockHash: string;
  readonly oracleUpdatedAt: string;
}

interface SolverExposure {
  readonly principalUnits: bigint;
  readonly feeUnits: bigint;
  readonly status: number;
  readonly recoveryReserveProvider: Address;
  readonly recoveryReserveUnits: bigint;
}

interface FeasibilityInput {
  readonly planHash: Hex;
  readonly analysisHash: Hex;
  readonly externalFundingEvidenceHash: Hex;
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
      `Fresh production financing has ${revalidation.fundingShortfallUnits} settlement units of shortfall at ${revalidation.checkpoint}.`,
    );
  }
}

const ERC20_ABI = [
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: 'balance', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: 'allowance', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: 'approved', type: 'bool' }],
  },
] as const;

const eventTopics = {
  liquidityReserved: eventTopic(
    'LiquidityReserved(bytes32,address,address,uint256,uint256,uint64)',
  ),
  reservationReleased: eventTopic('ReservationReleased(bytes32)'),
  sourceClosed: eventTopic('SourceClosed(bytes32,address,uint256,uint256)'),
  balanceReleased: eventTopic('BalanceReleased(bytes32,address,address,uint256)'),
  transportInbound: eventTopic('TransportInboundRegistered(bytes32,address,bytes32,uint256)'),
  destinationOpened: eventTopic('DestinationOpened(bytes32,address,bytes32,uint256,uint256)'),
  liquidityPayout: eventTopic('LiquidityPayout(bytes32,address,address,uint256,uint256)'),
  liquiditySettled: eventTopic('LiquiditySettled(bytes32,uint256,uint256)'),
  transfer: eventTopic('Transfer(address,address,uint256)'),
} as const;

/**
 * Executes the configured Aave V3 -> 1Click -> Morpho Blue route without any
 * mint, faucet, or simulated custody behavior. Provider status is never enough
 * to advance funds: canonical receipts and contract-accounted balances are
 * checked independently at every custody boundary.
 */
export class ProductionEvmExecutionPort implements MigrationExecutionPort {
  readonly #environment: DebtShiftEnvironment;
  readonly #account: PrivateKeyAccount;
  readonly #sourcePublic: EvmPublicClient;
  readonly #destinationPublic: EvmPublicClient;
  readonly #sourceWallet: EvmWalletClient;
  readonly #destinationWallet: EvmWalletClient;
  readonly #aave: AaveV3ReadAdapter;
  readonly #morpho: MorphoBlueReadAdapter;
  readonly #configuration: ReturnType<typeof parseLiveMarketConfiguration>;
  readonly #artifacts: Promise<ProductionArtifacts>;
  readonly #ready: Promise<void>;

  constructor(environment: DebtShiftEnvironment) {
    if (environment.DEBTSHIFT_MODE !== 'testnet' && environment.DEBTSHIFT_MODE !== 'mainnet') {
      throw new Error(
        'The production EVM execution port is available only in testnet or mainnet mode.',
      );
    }
    if (environment.DEBTSHIFT_MODE === 'mainnet' && !environment.MAINNET_EXECUTION_ENABLED) {
      throw new Error(
        'Production write adapters cannot be constructed while mainnet execution is disabled.',
      );
    }
    if (environment.EXECUTOR_PRIVATE_KEY.length === 0) {
      throw new Error('EXECUTOR_PRIVATE_KEY is required for funded testnet or mainnet execution.');
    }
    this.#environment = environment;
    this.#configuration = parseLiveMarketConfiguration(environment.LIVE_MARKET_CONFIG_JSON);
    this.#account = privateKeyToAccount(environment.EXECUTOR_PRIVATE_KEY as Hex);
    if (!isAddressEqual(this.#account.address, environment.EXECUTOR_ADDRESS)) {
      throw new Error('EXECUTOR_PRIVATE_KEY does not derive the configured EXECUTOR_ADDRESS.');
    }
    const sourceChain = evmChain(
      environment.SOURCE_CHAIN_ID,
      'DebtShift source',
      environment.SOURCE_RPC_URL,
    );
    const destinationChain = evmChain(
      environment.DESTINATION_CHAIN_ID,
      'DebtShift destination',
      environment.DESTINATION_RPC_URL,
    );
    this.#sourcePublic = createPublicClient({
      chain: sourceChain,
      transport: http(environment.SOURCE_RPC_URL),
    });
    this.#destinationPublic = createPublicClient({
      chain: destinationChain,
      transport: http(environment.DESTINATION_RPC_URL),
    });
    this.#sourceWallet = createWalletClient({
      account: this.#account,
      chain: sourceChain,
      transport: http(environment.SOURCE_RPC_URL),
    });
    this.#destinationWallet = createWalletClient({
      account: this.#account,
      chain: destinationChain,
      transport: http(environment.DESTINATION_RPC_URL),
    });
    this.#aave = new AaveV3ReadAdapter(this.#sourcePublic, {
      chainId: environment.SOURCE_CHAIN_ID,
      pool: this.#configuration.source.pool,
      dataProvider: this.#configuration.source.dataProvider,
      collateralAsset: {
        chainId: environment.SOURCE_CHAIN_ID,
        ...this.#configuration.source.collateralAsset,
      },
      debtAsset: {
        chainId: environment.SOURCE_CHAIN_ID,
        ...this.#configuration.source.debtAsset,
      },
    });
    const sequencer = this.#configuration.destination.sequencerUptimeFeed;
    const oracleFreshness = new ChainlinkOracleFreshnessReader(this.#destinationPublic, {
      morphoOracle: this.#configuration.destination.morphoOracle,
      feeds: this.#configuration.destination.morphoOracleFeeds,
      ...(sequencer === undefined ? {} : { sequencerUptimeFeed: sequencer }),
    });
    this.#morpho = new MorphoBlueReadAdapter(
      this.#destinationPublic,
      {
        chainId: environment.DESTINATION_CHAIN_ID,
        morpho: this.#configuration.destination.morpho,
      },
      oracleFreshness,
    );
    this.#artifacts = loadProductionArtifacts();
    this.#ready = this.#verifyDeploymentBindings();
  }

  async verifyCanonicalEvidence(
    records: readonly Evidence[],
  ): Promise<readonly ChainCanonicalityFailure[]> {
    await this.#ready;
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
      const confirmations = this.#confirmationsForChain(evidence.chainId);
      const observedAt = new Date().toISOString();
      if (client === undefined || confirmations === undefined) {
        failures.push({
          evidence,
          reason: 'UNSUPPORTED_CHAIN_ID',
          observedAt,
          requiredConfirmations: 0,
          observedTipBlockNumber: '0',
        });
        continue;
      }
      const tip = await client.getBlockNumber();
      let canonicalHash: Hex | undefined;
      try {
        canonicalHash =
          (await client.getBlock({ blockNumber: BigInt(evidence.blockNumber) })).hash ?? undefined;
      } catch {
        failures.push({
          evidence,
          reason: 'CANONICAL_BLOCK_NOT_FOUND',
          observedAt,
          requiredConfirmations: confirmations,
          observedTipBlockNumber: tip.toString(),
        });
        continue;
      }
      if (canonicalHash?.toLowerCase() !== evidence.blockHash.toLowerCase()) {
        failures.push({
          evidence,
          reason: 'CANONICAL_BLOCK_HASH_MISMATCH',
          observedAt,
          requiredConfirmations: confirmations,
          observedTipBlockNumber: tip.toString(),
          ...(canonicalHash === undefined ? {} : { observedBlockHash: canonicalHash }),
        });
        continue;
      }
      const depth =
        tip >= BigInt(evidence.blockNumber) ? tip - BigInt(evidence.blockNumber) + 1n : 0n;
      if (depth < BigInt(confirmations)) {
        failures.push({
          evidence,
          reason: 'FINALITY_DEPTH_LOST',
          observedAt,
          requiredConfirmations: confirmations,
          observedTipBlockNumber: tip.toString(),
          observedBlockHash: canonicalHash,
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
            requiredConfirmations: confirmations,
            observedTipBlockNumber: tip.toString(),
            observedBlockHash: canonicalHash,
            observedReceiptBlockNumber: receipt.blockNumber.toString(),
            observedReceiptBlockHash: receipt.blockHash,
          });
        }
      } catch {
        failures.push({
          evidence,
          reason: 'TRANSACTION_RECEIPT_NOT_FOUND',
          observedAt,
          requiredConfirmations: confirmations,
          observedTipBlockNumber: tip.toString(),
          observedBlockHash: canonicalHash,
        });
      }
    }
    return failures;
  }

  async reserve(context: MigrationExecutionContext): Promise<FinalizedChainAction> {
    await this.#assertContext(context);
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
      const exposure = await this.#readSolverExposure(artifacts.vault, migrationId);
      this.#assertRecoveryReserve(exposure, context, 1);
      return withRevalidation(existing, await this.#revalidate(context, 'AFTER_RESERVATION'));
    }
    const revalidation = await this.#revalidate(context, 'BEFORE_RESERVATION');
    const proof = await this.#recordSourceFeasibility(context, artifacts, revalidation);
    const plan = context.signedPlan.plan;
    const recoveryReserveUnits = BigInt(plan.principalMaxUnits) + BigInt(plan.feeMaxUnits);
    const recoveryReserveApprovalTransactions = await this.#approveExact(
      this.#sourceWallet,
      this.#sourcePublic,
      this.#environment.SOURCE_DEBT_TOKEN_ADDRESS,
      this.#environment.SOURCE_VAULT_ADDRESS,
      recoveryReserveUnits,
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
        planHash: context.signedPlan.planHash,
        principalUnits: plan.principalMaxUnits,
        feeCapUnits: plan.feeMaxUnits,
        recoveryReserveProvider: this.#account.address,
        recoveryReserveUnits: recoveryReserveUnits.toString(),
        recoveryReserveApprovalTransactions,
        feasibilityHash: proof.feasibilityHash,
        feasibilityTransactionHash: proof.transactionHash,
        financingRevalidation: revalidation,
      },
    );
    const exposure = await this.#readSolverExposure(artifacts.vault, migrationId);
    this.#assertRecoveryReserve(exposure, context, 1);
    return action;
  }

  async cancelBeforeSourceClose(context: MigrationExecutionContext): Promise<FinalizedChainAction> {
    await this.#assertContext(context);
    const artifacts = await this.#artifacts;
    return this.#releaseUndrawnReservation(context, artifacts, {
      action: 'cancelBeforeSourceClose',
      reason: 'BORROWER_REQUESTED_CANCELLATION',
      planHash: context.signedPlan.planHash,
    });
  }

  async closeSource(context: MigrationExecutionContext): Promise<FinalizedChainAction> {
    await this.#assertContext(context);
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
      return withRevalidation(existing, await this.#revalidate(context, 'AFTER_SOURCE_CLOSE'));
    }
    let revalidation: FinancingRevalidation;
    try {
      revalidation = await this.#revalidate(context, 'BEFORE_SOURCE_CLOSE');
    } catch (error) {
      if (!(error instanceof FinancingCapacityFailure)) throw error;
      throw new PreSourceCapacityDeteriorationError(
        await this.#releaseReservation(context, artifacts, error.revalidation),
      );
    }
    await this.#assertExactAaveCollateralAuthorization(context);
    const proof = await this.#recordSourceFeasibility(context, artifacts, revalidation);
    const authorization = getExecutionPlanTypedData(
      plan,
      this.#environment.EIP712_VERIFYING_CONTRACT,
    ).message;
    let action: FinalizedChainAction;
    try {
      action = await this.#writeAction(
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
          sourceRepaymentMaximumUnits: plan.sourceRepaymentMaxUnits,
          sourceCollateralMinimumUnits: plan.sourceCollateralMinUnits,
          feasibilityHash: proof.feasibilityHash,
          feasibilityTransactionHash: proof.transactionHash,
          financingRevalidation: revalidation,
        },
      );
    } catch (error) {
      if (
        !(error instanceof PreBroadcastSimulationError) &&
        !(error instanceof FinalizedTransactionRevertError)
      ) {
        throw error;
      }
      const reconciled = await this.#eventAction(
        this.#sourcePublic,
        this.#environment.SOURCE_CHAIN_ID,
        this.#environment.SOURCE_ADAPTER_ADDRESS,
        eventTopics.sourceClosed,
        [migrationId, addressTopic(plan.borrower)],
        { action: 'closeSource', reconciled: true },
      );
      if (reconciled !== undefined) {
        return withRevalidation(reconciled, await this.#revalidate(context, 'AFTER_SOURCE_CLOSE'));
      }
      const sourcePosition = await this.#aave.readPosition(plan.borrower);
      if (
        sourcePosition === undefined ||
        BigInt(sourcePosition.debtUnits) === 0n ||
        BigInt(sourcePosition.debtUnits) > BigInt(plan.sourceRepaymentMaxUnits) ||
        BigInt(sourcePosition.collateralUnits) < BigInt(plan.sourceCollateralMinUnits)
      ) {
        throw new Error('Source position changed after the failed source-close attempt.', {
          cause: error,
        });
      }
      throw new PreSourceCloseFailureError(
        await this.#releaseUndrawnReservation(context, artifacts, {
          action: 'releaseFailedSourceClose',
          reason: 'SOURCE_CLOSE_REVERTED_BEFORE_STATE_CHANGE',
          outcome: 'REQUOTE_REQUIRED',
          failureStage:
            error instanceof PreBroadcastSimulationError
              ? 'PRE_BROADCAST_SIMULATION'
              : 'FINALIZED_REVERT',
          sourcePosition: {
            borrower: plan.borrower,
            snapshotId: sourcePosition.snapshotId,
            disposition: 'UNCHANGED',
          },
          financingRevalidation: revalidation,
        }),
        error,
      );
    }
    if ((await this.#aave.readPosition(plan.borrower)) !== undefined) {
      throw new Error('Aave source position remains open after the finalized close transaction.');
    }
    const assigned = await this.#readBigInt(
      this.#sourcePublic,
      artifacts.escrow,
      this.#environment.SOURCE_ESCROW_ADDRESS,
      'categorizedBalances',
      [migrationId, this.#environment.SOURCE_COLLATERAL_TOKEN_ADDRESS, 0],
    );
    if (assigned < BigInt(plan.sourceCollateralMinUnits)) {
      throw new Error('Source collateral is not fully assigned to the source recovery escrow.');
    }
    return action;
  }

  async dispatchTransport(context: MigrationExecutionContext): Promise<FinalizedChainAction> {
    await this.#assertContext(context);
    const artifacts = await this.#artifacts;
    const depositAddress =
      this.#environment.DEBTSHIFT_MODE === 'mainnet'
        ? this.#oneClickDepositAddress(context)
        : this.#account.address;
    const migrationId = context.migration.migrationId as Hex;
    const existing = await this.#eventAction(
      this.#sourcePublic,
      this.#environment.SOURCE_CHAIN_ID,
      this.#environment.SOURCE_ESCROW_ADDRESS,
      eventTopics.balanceReleased,
      [
        migrationId,
        addressTopic(this.#environment.SOURCE_COLLATERAL_TOKEN_ADDRESS),
        addressTopic(depositAddress),
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
        depositAddress,
        BigInt(context.quote.amountInUnits),
      ],
      {
        action: 'dispatchTransport',
        provider: context.quote.provider,
        committedQuoteHash: context.quote.quoteHash,
        depositAddress,
        amountInUnits: context.quote.amountInUnits,
      },
    );
  }

  async deliverDestination(
    context: MigrationExecutionContext,
    observation: TransportObservation,
  ): Promise<FinalizedChainAction> {
    await this.#assertContext(context);
    const artifacts = await this.#artifacts;
    const migrationId = context.migration.migrationId as Hex;
    if (observation.destinationTransactionHash === undefined) {
      throw new Error('A successful transport observation has no destination transaction hash.');
    }
    const inboundEvidenceHash = transportInboundEvidenceHash(
      migrationId,
      observation.destinationTransactionHash,
      observation.rawObservationHash,
    );
    const existing = await this.#eventAction(
      this.#destinationPublic,
      this.#environment.DESTINATION_CHAIN_ID,
      this.#environment.DESTINATION_ESCROW_ADDRESS,
      eventTopics.transportInbound,
      [
        migrationId,
        addressTopic(this.#environment.DESTINATION_COLLATERAL_TOKEN_ADDRESS),
        inboundEvidenceHash,
      ],
      { action: 'deliverDestination', reconciled: true },
    );
    if (existing !== undefined) return existing;
    const providerReceipt = await this.#verifiedTokenDelivery(
      this.#destinationPublic,
      observation.destinationTransactionHash,
      this.#environment.DESTINATION_COLLATERAL_TOKEN_ADDRESS,
      this.#environment.DESTINATION_ESCROW_ADDRESS,
      BigInt(observation.observedAmountOutUnits),
      this.#environment.DESTINATION_FINALITY_CONFIRMATIONS,
    );
    const action = await this.#writeAction(
      this.#destinationWallet,
      this.#destinationPublic,
      this.#environment.DESTINATION_CHAIN_ID,
      artifacts.escrow,
      this.#environment.DESTINATION_ESCROW_ADDRESS,
      'registerTransportInbound',
      [
        migrationId,
        this.#environment.DESTINATION_COLLATERAL_TOKEN_ADDRESS,
        BigInt(observation.observedAmountOutUnits),
        inboundEvidenceHash,
      ],
      {
        action: 'deliverDestination',
        amountOutUnits: observation.observedAmountOutUnits,
        providerTransactionHash: observation.destinationTransactionHash,
        providerBlockNumber: providerReceipt.blockNumber.toString(),
        providerBlockHash: providerReceipt.blockHash,
        providerObservationHash: observation.rawObservationHash,
        inboundEvidenceHash,
      },
    );
    const assigned = await this.#readBigInt(
      this.#destinationPublic,
      artifacts.escrow,
      this.#environment.DESTINATION_ESCROW_ADDRESS,
      'categorizedBalances',
      [migrationId, this.#environment.DESTINATION_COLLATERAL_TOKEN_ADDRESS, 0],
    );
    if (assigned < BigInt(observation.observedAmountOutUnits)) {
      throw new Error(
        'Destination escrow did not account for the independently verified delivery.',
      );
    }
    return action;
  }

  async openTarget(context: MigrationExecutionContext): Promise<FinalizedChainAction> {
    await this.#assertContext(context);
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
      const revalidation = await this.#revalidate(context, 'AFTER_TARGET_BORROW');
      await this.#assertLiquidityPayout(
        existing.transactionHash,
        migrationId,
        plan.payoutReceiver,
        BigInt(revalidation.solverPrincipalUnits),
        BigInt(revalidation.solverFeeUnits),
      );
      return withRevalidation(existing, revalidation);
    }
    if (context.transportLeg.observedOutputUnits === null) {
      throw new Error('Destination collateral has not been independently observed and accounted.');
    }
    let revalidation: FinancingRevalidation;
    try {
      revalidation = await this.#revalidate(context, 'BEFORE_TARGET_BORROW');
    } catch (error) {
      if (!(error instanceof FinancingCapacityFailure)) throw error;
      throw new PostSourceCapacityDeteriorationError(
        await this.#recordCapacityDeterioration(context, artifacts, error.revalidation),
      );
    }
    const proof = await this.#recordDestinationFeasibility(context, artifacts, revalidation);
    const authorization = getExecutionPlanTypedData(
      plan,
      this.#environment.EIP712_VERIFYING_CONTRACT,
    ).message;
    const borrowUnits = BigInt(revalidation.requiredDestinationBorrowUnits);
    const action = await this.#writeAction(
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
          fundingEvidenceHash: zeroBytes32(),
          solverPrincipalUnits: BigInt(revalidation.solverPrincipalUnits),
          solverFeeUnits: BigInt(revalidation.solverFeeUnits),
          capitalizedCostUnits: 0n,
          capitalizedCostReceiver: zeroAddress,
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
        financingRevalidation: revalidation,
      },
    );
    await this.#assertLiquidityPayout(
      action.transactionHash,
      migrationId,
      plan.payoutReceiver,
      BigInt(revalidation.solverPrincipalUnits),
      BigInt(revalidation.solverFeeUnits),
    );
    const target = await this.#morpho.readPosition(
      this.#configuration.destination.marketId,
      plan.borrower,
    );
    if (
      BigInt(target.collateralUnits) < BigInt(plan.minDestinationCollateralUnits) ||
      BigInt(target.borrowShares) === 0n
    ) {
      throw new Error(
        'The finalized Morpho position does not match the signed destination bounds.',
      );
    }
    return action;
  }

  async settleLiquidity(context: MigrationExecutionContext): Promise<FinalizedChainAction> {
    await this.#assertContext(context);
    const artifacts = await this.#artifacts;
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
      return withRevalidation(existing, await this.#revalidate(context, 'AFTER_SETTLEMENT'));
    }
    const revalidation = await this.#revalidate(context, 'BEFORE_SETTLEMENT');
    const proof = await this.#recordSourceFeasibility(context, artifacts, revalidation);
    const exposure = await this.#readSolverExposure(artifacts.vault, migrationId);
    if (exposure.status !== 2 || exposure.principalUnits === 0n) {
      throw new Error('The source vault has no drawn solver receivable to settle.');
    }
    const repayment = exposure.principalUnits + exposure.feeUnits;
    this.#assertRecoveryReserve(exposure, context, 2);
    const action = await this.#writeAction(
      this.#sourceWallet,
      this.#sourcePublic,
      this.#environment.SOURCE_CHAIN_ID,
      artifacts.vault,
      this.#environment.SOURCE_VAULT_ADDRESS,
      'settle',
      [migrationId, this.#account.address, exposure.feeUnits],
      {
        action: 'settleLiquidity',
        payer: this.#account.address,
        principalUnits: exposure.principalUnits.toString(),
        feeUnits: exposure.feeUnits.toString(),
        repaymentUnits: repayment.toString(),
        recoveryReserveProvider: exposure.recoveryReserveProvider,
        recoveryReserveMaximumUnits: exposure.recoveryReserveUnits.toString(),
        feasibilityHash: proof.feasibilityHash,
        feasibilityTransactionHash: proof.transactionHash,
        financingRevalidation: revalidation,
      },
    );
    const settled = await this.#readSolverExposure(artifacts.vault, migrationId);
    if (settled.status !== 3) {
      throw new Error('Source vault settlement did not reach the SETTLED contract state.');
    }
    return action;
  }

  async executeRecovery(
    context: MigrationExecutionContext,
    reason: string,
  ): Promise<FinalizedChainAction> {
    await this.#assertContext(context);
    const artifacts = await this.#artifacts;
    const plan = context.signedPlan.plan;
    const migrationId = context.migration.migrationId as Hex;
    const existingDestination = await this.#eventAction(
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
    const existingSource = await this.#eventAction(
      this.#sourcePublic,
      this.#environment.SOURCE_CHAIN_ID,
      this.#environment.SOURCE_ESCROW_ADDRESS,
      eventTopics.balanceReleased,
      [
        migrationId,
        addressTopic(this.#environment.SOURCE_COLLATERAL_TOKEN_ADDRESS),
        addressTopic(plan.refundReceiver),
      ],
      { action: 'executeRecovery', reason, custodyLocation: 'SOURCE_ESCROW', reconciled: true },
    );
    if (existingDestination !== undefined) {
      const recoveryReserveSettlement = await this.#settleRecoveryReserveIfDrawn(
        context,
        artifacts,
      );
      return {
        ...existingDestination,
        payload: { ...existingDestination.payload, recoveryReserveSettlement },
      };
    }
    if (existingSource !== undefined) {
      const recoveryReserveSettlement = await this.#settleRecoveryReserveIfDrawn(
        context,
        artifacts,
      );
      return {
        ...existingSource,
        payload: { ...existingSource.payload, recoveryReserveSettlement },
      };
    }

    const destinationCustody = await this.#readBigInt(
      this.#destinationPublic,
      artifacts.escrow,
      this.#environment.DESTINATION_ESCROW_ADDRESS,
      'categorizedBalances',
      [migrationId, this.#environment.DESTINATION_COLLATERAL_TOKEN_ADDRESS, 0],
    );
    if (destinationCustody > 0n) {
      const exposure = await this.#readSolverExposure(artifacts.vault, migrationId);
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
          destinationCustody,
        ],
        {
          action: 'executeRecovery',
          reason,
          policy: 'RETURN_VERIFIED_COLLATERAL_PRESERVE_SOLVER_RECEIVABLE',
          custodyLocation: 'DESTINATION_ESCROW',
          refundReceiver: plan.refundReceiver,
          refundUnits: destinationCustody.toString(),
          solverReceivable: {
            principalUnits: exposure.principalUnits.toString(),
            feeUnits: exposure.feeUnits.toString(),
            status: exposure.status,
          },
        },
      );
      const recoveryReserveSettlement = await this.#settleRecoveryReserveIfDrawn(
        context,
        artifacts,
      );
      return {
        ...recoveryAction,
        payload: { ...recoveryAction.payload, recoveryReserveSettlement },
      };
    }

    const refundRegistration = await this.#registerVerifiedSourceRefund(context, artifacts);
    const sourceCustody = await this.#readBigInt(
      this.#sourcePublic,
      artifacts.escrow,
      this.#environment.SOURCE_ESCROW_ADDRESS,
      'categorizedBalances',
      [migrationId, this.#environment.SOURCE_COLLATERAL_TOKEN_ADDRESS, 0],
    );
    if (sourceCustody > 0n) {
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
          sourceCustody,
        ],
        {
          action: 'executeRecovery',
          reason,
          policy: 'RETURN_VERIFIED_SOURCE_COLLATERAL',
          custodyLocation: 'SOURCE_ESCROW',
          refundReceiver: plan.refundReceiver,
          refundUnits: sourceCustody.toString(),
          ...(refundRegistration === undefined ? {} : { refundRegistration }),
        },
      );
      const recoveryReserveSettlement = await this.#settleRecoveryReserveIfDrawn(
        context,
        artifacts,
      );
      return {
        ...recoveryAction,
        payload: { ...recoveryAction.payload, recoveryReserveSettlement },
      };
    }

    const exposure = await this.#readSolverExposure(artifacts.vault, migrationId);
    const sourcePosition = await this.#aave.readPosition(plan.borrower);
    if (exposure.status === 1 && sourcePosition !== undefined) {
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
          sourceSnapshotId: sourcePosition.snapshotId,
        },
      );
    }
    throw new Error(
      'Recovery stopped because no independently verified escrow custody or releasable reservation exists.',
    );
  }

  async #assertContext(context: MigrationExecutionContext): Promise<void> {
    await this.#ready;
    const plan = context.signedPlan.plan;
    if (
      plan.sourceMarket.chainId !== this.#environment.SOURCE_CHAIN_ID ||
      plan.targetMarket.chainId !== this.#environment.DESTINATION_CHAIN_ID ||
      plan.sourceMarket.protocol !== 'AAVE_V3' ||
      plan.targetMarket.protocol !== 'MORPHO_BLUE'
    ) {
      throw new Error(
        'The signed plan does not use the configured Aave-to-Morpho production route.',
      );
    }
    if (
      !isAddressEqual(plan.sourceMarket.deployment, this.#configuration.source.pool) ||
      !isAddressEqual(plan.targetMarket.deployment, this.#configuration.destination.morpho) ||
      plan.targetMarket.marketId.toLowerCase() !==
        this.#configuration.destination.marketId.toLowerCase()
    ) {
      throw new Error(
        'The signed lending deployments or Morpho market ID do not match configuration.',
      );
    }
    const addressBindings: readonly [Address, Address, string][] = [
      [plan.sourceDebtAsset.address, this.#environment.SOURCE_DEBT_TOKEN_ADDRESS, 'source debt'],
      [
        plan.sourceCollateralAsset.address,
        this.#environment.SOURCE_COLLATERAL_TOKEN_ADDRESS,
        'source collateral',
      ],
      [
        plan.destinationDebtAsset.address,
        this.#environment.DESTINATION_DEBT_TOKEN_ADDRESS,
        'destination debt',
      ],
      [
        plan.destinationCollateralAsset.address,
        this.#environment.DESTINATION_COLLATERAL_TOKEN_ADDRESS,
        'destination collateral',
      ],
      [
        plan.destinationReceiver,
        this.#environment.DESTINATION_ESCROW_ADDRESS,
        'destination escrow',
      ],
      [
        plan.transportRefundReceiver,
        this.#environment.SOURCE_ESCROW_ADDRESS,
        'transport refund escrow',
      ],
      [plan.fundingProvider, this.#environment.SOURCE_VAULT_ADDRESS, 'source vault'],
      [plan.payoutReceiver, this.#environment.EXECUTOR_ADDRESS, 'permissioned solver payout'],
    ];
    for (const [actual, expected, label] of addressBindings) {
      if (!isAddressEqual(actual, expected)) throw new Error(`Signed ${label} binding is invalid.`);
    }
    if (
      !isAddressEqual(
        this.#environment.EIP712_VERIFYING_CONTRACT,
        this.#environment.SOURCE_ADAPTER_ADDRESS,
      )
    ) {
      throw new Error('EIP-712 verifying contract must equal the deployed source adapter.');
    }
    if (
      context.targetLendingAuthorization.authorization.kind !== 'MORPHO_BLUE' ||
      !isAddressEqual(
        context.targetLendingAuthorization.authorization.module,
        this.#environment.DESTINATION_LENDING_ADDRESS,
      ) ||
      context.targetLendingAuthorization.encodedAuthorization === '0x'
    ) {
      throw new Error('The production plan has no valid native Morpho module authorization.');
    }
    if (
      BigInt(plan.financing.solverAdvancedCostUnits) !== 0n ||
      BigInt(plan.financing.capitalizedCostUnits) !== 0n ||
      BigInt(plan.financing.confirmedExternalFundingUnits) !== 0n ||
      plan.financing.externalFunding.length !== 0 ||
      plan.financing.fundingShortfallUnits !== '0'
    ) {
      throw new Error(
        'The initial production route accepts only zero-shortfall vault financing without solver-advanced, capitalized, or supplementary funding.',
      );
    }
    if (BigInt(plan.financing.validUntil) < BigInt(plan.deadline)) {
      throw new Error('Financing evidence expires before the signed plan deadline.');
    }
    if (
      context.quote.quoteHash !== plan.transportQuoteHash ||
      context.quote.depositAddress !== plan.transportDepositAddress ||
      !sameAddress(context.quote.destinationReceiver, plan.destinationReceiver) ||
      !sameAddress(context.quote.refundReceiver, plan.transportRefundReceiver)
    ) {
      throw new Error('Persisted transport quote is not bound to the signed plan.');
    }
    if (this.#environment.DEBTSHIFT_MODE === 'mainnet') {
      if (context.quote.provider !== 'NEAR_INTENTS_1CLICK' || context.quote.mode !== 'COMMITTED') {
        throw new Error('Mainnet execution requires one committed official 1Click quote.');
      }
      this.#oneClickDepositAddress(context);
    } else if (
      context.quote.provider !== 'DEBTSHIFT_SIMULATOR' ||
      context.quote.mode !== 'SIMULATED'
    ) {
      throw new Error('Testnet execution requires the explicitly simulated transport boundary.');
    }
  }

  async #revalidate(
    context: MigrationExecutionContext,
    checkpoint: FinancingCheckpoint,
  ): Promise<FinancingRevalidation> {
    const plan = context.signedPlan.plan;
    const now = BigInt(Math.floor(Date.now() / 1_000));
    if (now > BigInt(plan.deadline) || now > BigInt(plan.financing.validUntil)) {
      throw new Error(`Signed financing expired at ${checkpoint}.`);
    }
    const afterSourceClose =
      checkpoint === 'AFTER_SOURCE_CLOSE' ||
      checkpoint === 'BEFORE_TARGET_BORROW' ||
      checkpoint === 'AFTER_TARGET_BORROW' ||
      checkpoint === 'BEFORE_SETTLEMENT' ||
      checkpoint === 'AFTER_SETTLEMENT';
    const source = await this.#aave.readPosition(plan.borrower);
    if (afterSourceClose) {
      if (source !== undefined)
        throw new Error(`Aave source position remains open at ${checkpoint}.`);
    } else {
      if (
        source === undefined ||
        BigInt(source.debtUnits) === 0n ||
        BigInt(source.debtUnits) > BigInt(plan.sourceRepaymentMaxUnits) ||
        BigInt(source.collateralUnits) < BigInt(plan.sourceCollateralMinUnits)
      ) {
        throw new Error(`Aave source position exceeds signed bounds at ${checkpoint}.`);
      }
    }

    const targetAlreadyOpen =
      checkpoint === 'AFTER_TARGET_BORROW' ||
      checkpoint === 'BEFORE_SETTLEMENT' ||
      checkpoint === 'AFTER_SETTLEMENT';
    const target = await this.#morpho.readPosition(
      this.#configuration.destination.marketId,
      plan.borrower,
    );
    if (targetAlreadyOpen) {
      if (
        BigInt(target.collateralUnits) < BigInt(plan.minDestinationCollateralUnits) ||
        BigInt(target.borrowShares) === 0n
      ) {
        throw new Error(
          `Morpho target position is not open within signed bounds at ${checkpoint}.`,
        );
      }
    } else if (BigInt(target.collateralUnits) !== 0n || BigInt(target.borrowShares) !== 0n) {
      throw new Error(
        `Borrower already has a position in the selected Morpho market at ${checkpoint}.`,
      );
    }

    let solverPrincipal = BigInt(plan.financing.solverPrincipalUnits);
    let solverFee = BigInt(plan.financing.solverFeeUnits);
    if (afterSourceClose) {
      const exposure = await this.#readSolverExposure(
        (await this.#artifacts).vault,
        context.migration.migrationId as Hex,
      );
      const expectedStatus = checkpoint === 'AFTER_SETTLEMENT' ? 3 : 2;
      if (
        exposure.status !== expectedStatus ||
        exposure.principalUnits === 0n ||
        exposure.principalUnits > BigInt(plan.principalMaxUnits) ||
        exposure.feeUnits !== BigInt(plan.feeMaxUnits) ||
        !isAddressEqual(exposure.recoveryReserveProvider, this.#account.address) ||
        exposure.recoveryReserveUnits !== BigInt(plan.principalMaxUnits) + BigInt(plan.feeMaxUnits)
      ) {
        throw new Error(`Source vault exposure is invalid at ${checkpoint}.`);
      }
      solverPrincipal = exposure.principalUnits;
      solverFee = exposure.feeUnits;
    }
    const totalRequired = solverPrincipal + solverFee;
    const requiredBorrow = totalRequired;
    const market = targetAlreadyOpen
      ? target.market
      : await this.#morpho.readMarket(this.#configuration.destination.marketId, requiredBorrow);
    if (
      !isAddressEqual(market.params.loanToken, this.#environment.DESTINATION_DEBT_TOKEN_ADDRESS) ||
      !isAddressEqual(
        market.params.collateralToken,
        this.#environment.DESTINATION_COLLATERAL_TOKEN_ADDRESS,
      )
    ) {
      throw new Error('Morpho market token identities changed from the allowlisted route.');
    }
    const collateralUnits = targetAlreadyOpen
      ? BigInt(target.collateralUnits)
      : context.transportLeg.observedOutputUnits === null
        ? BigInt(plan.minDestinationCollateralUnits)
        : BigInt(context.transportLeg.observedOutputUnits);
    if (collateralUnits < BigInt(plan.minDestinationCollateralUnits)) {
      throw new Error(`Destination collateral is below the signed minimum at ${checkpoint}.`);
    }
    const collateralValue =
      (collateralUnits * BigInt(market.snapshot.oracle.priceMantissa)) / 10n ** 36n;
    const protocolLtvBps = Number((market.params.lltv * 10_000n) / 10n ** 18n);
    const protocolCapacity = (collateralValue * market.params.lltv) / 10n ** 18n;
    const policy = context.signedIntent.intent.safetyPolicy;
    if (policy.kind !== 'MAX_LTV_BPS') {
      throw new Error('The initial Morpho production route requires a signed maximum-LTV policy.');
    }
    const stressedValue =
      (collateralValue * BigInt(10_000 - plan.financing.stressCollateralDropBps)) / 10_000n;
    const policyCapacity = minBigInt(
      (collateralValue * BigInt(policy.maximumLtvBps)) / 10_000n,
      (stressedValue * BigInt(policy.stressMaximumLtvBps)) / 10_000n,
    );
    const observedApr = targetAlreadyOpen
      ? market.currentBorrowAprBps
      : market.projectedBorrowAprBps;
    const maximumApr = Math.max(
      0,
      context.sourceSnapshot.borrowAprBps - context.signedIntent.intent.minAprReductionBps,
    );
    const rateEligible = observedApr <= maximumApr;
    const rateBoundPolicyCapacity = rateEligible ? policyCapacity : 0n;
    const availableLiquidity =
      BigInt(market.availableBorrowUnits) + (targetAlreadyOpen ? requiredBorrow : 0n);
    const liquidityCapacity =
      (availableLiquidity * 10_000n) / BigInt(10_000 + plan.financing.liquidityBufferBps);
    const signedCapacity = BigInt(plan.financing.signedBorrowCapacityUnits);
    const safeCapacity = minBigInt(
      protocolCapacity,
      rateBoundPolicyCapacity,
      liquidityCapacity,
      signedCapacity,
    );
    const shortfall = totalRequired > safeCapacity ? totalRequired - safeCapacity : 0n;
    const revalidation: FinancingRevalidation = {
      checkpoint,
      observedAt: new Date().toISOString(),
      sourceState: afterSourceClose ? 'CLOSED' : 'OPEN_WITHIN_SIGNED_CAP',
      sourceDebtUnits: source?.debtUnits ?? '0',
      destinationCollateralUnits: collateralUnits.toString(),
      collateralValueUnits: collateralValue.toString(),
      protocolMaximumLtvBps: protocolLtvBps,
      observedTargetBorrowAprBps: observedApr,
      maximumTargetBorrowAprBps: maximumApr,
      protocolBorrowCapacityUnits: protocolCapacity.toString(),
      policyBorrowCapacityUnits: rateBoundPolicyCapacity.toString(),
      liquidityBorrowCapacityUnits: liquidityCapacity.toString(),
      signedBorrowCapacityUnits: signedCapacity.toString(),
      maximumSafeBorrowingCapacityUnits: safeCapacity.toString(),
      confirmedExternalFundingUnits: '0',
      solverPrincipalUnits: solverPrincipal.toString(),
      solverFeeUnits: solverFee.toString(),
      totalRequiredUnits: totalRequired.toString(),
      requiredDestinationBorrowUnits: requiredBorrow.toString(),
      fundingShortfallUnits: shortfall.toString(),
      policyFailureCodes: rateEligible ? [] : ['TARGET_RATE_EXCEEDS_SIGNED_MAXIMUM'],
      marketBlockNumber: market.snapshot.block.number,
      marketBlockHash: market.snapshot.block.hash,
      oracleUpdatedAt: market.snapshot.oracle.updatedAt,
    };
    if (requiredBorrow > safeCapacity || shortfall !== 0n) {
      throw new FinancingCapacityFailure(revalidation);
    }
    if (checkpoint === 'BEFORE_SETTLEMENT' || checkpoint === 'AFTER_SETTLEMENT') {
      const payout = await this.#erc20Balance(
        this.#destinationPublic,
        this.#environment.DESTINATION_DEBT_TOKEN_ADDRESS,
        plan.payoutReceiver,
      );
      if (payout < totalRequired) {
        throw new Error(
          'Destination solver payout balance is below the signed settlement obligation.',
        );
      }
    }
    return revalidation;
  }

  async #recordSourceFeasibility(
    context: MigrationExecutionContext,
    artifacts: ProductionArtifacts,
    revalidation: FinancingRevalidation,
  ): Promise<{ readonly feasibilityHash: Hex; readonly transactionHash: Hex }> {
    const base = await this.#feasibilityInput(
      context,
      this.#sourcePublic,
      artifacts.vault,
      this.#environment.SOURCE_VAULT_ADDRESS,
      revalidation,
    );
    const evidence = {
      ...base,
      liquidityAsset: this.#environment.SOURCE_DEBT_TOKEN_ADDRESS,
    } as const;
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

  async #recordDestinationFeasibility(
    context: MigrationExecutionContext,
    artifacts: ProductionArtifacts,
    revalidation: FinancingRevalidation,
  ): Promise<{ readonly feasibilityHash: Hex; readonly transactionHash: Hex }> {
    const base = await this.#feasibilityInput(
      context,
      this.#destinationPublic,
      artifacts.destinationAdapter,
      this.#environment.DESTINATION_ADAPTER_ADDRESS,
      revalidation,
    );
    const evidence = {
      ...base,
      settlementAsset: this.#environment.DESTINATION_DEBT_TOKEN_ADDRESS,
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

  async #feasibilityInput(
    context: MigrationExecutionContext,
    client: EvmPublicClient,
    artifact: FoundryArtifact,
    address: Address,
    revalidation: FinancingRevalidation,
  ): Promise<FeasibilityInput> {
    const financing = context.signedPlan.plan.financing;
    const sequence =
      (await this.#readBigInt(client, artifact, address, 'latestFeasibilitySequence', [
        context.migration.migrationId,
      ])) + 1n;
    const evaluatedAt = (await client.getBlock({ blockTag: 'latest' })).timestamp;
    return {
      planHash: context.signedPlan.planHash,
      analysisHash: keccak256(stringToHex(JSON.stringify(revalidation))),
      externalFundingEvidenceHash: zeroBytes32(),
      solverPrincipalUnits: BigInt(revalidation.solverPrincipalUnits),
      solverFeeUnits: BigInt(revalidation.solverFeeUnits),
      capitalizedCostUnits: 0n,
      totalRequiredUnits: BigInt(revalidation.totalRequiredUnits),
      confirmedExternalFundingUnits: 0n,
      maximumSafeBorrowingCapacityUnits: BigInt(revalidation.maximumSafeBorrowingCapacityUnits),
      requiredDestinationBorrowUnits: BigInt(revalidation.requiredDestinationBorrowUnits),
      fundingShortfallUnits: BigInt(revalidation.fundingShortfallUnits),
      sequence,
      evaluatedAt,
      validUntil: BigInt(financing.validUntil),
    };
  }

  async #releaseReservation(
    context: MigrationExecutionContext,
    artifacts: ProductionArtifacts,
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
    if (existing !== undefined) return withRevalidation(existing, revalidation);
    const base = await this.#feasibilityInput(
      context,
      this.#sourcePublic,
      artifacts.vault,
      this.#environment.SOURCE_VAULT_ADDRESS,
      revalidation,
    );
    const action = await this.#writeAction(
      this.#sourceWallet,
      this.#sourcePublic,
      this.#environment.SOURCE_CHAIN_ID,
      artifacts.vault,
      this.#environment.SOURCE_VAULT_ADDRESS,
      'recordFailedFeasibilityAndRelease',
      [migrationId, { ...base, liquidityAsset: this.#environment.SOURCE_DEBT_TOKEN_ADDRESS }],
      {
        action: 'releaseFailedReservation',
        reason: 'DESTINATION_CAPACITY_DETERIORATED_BEFORE_SOURCE_CLOSE',
        outcome: 'REQUOTE_REQUIRED',
        financingRevalidation: revalidation,
      },
    );
    const exposure = await this.#readSolverExposure(artifacts.vault, migrationId);
    if (exposure.status !== 4) {
      throw new Error('Failed feasibility did not release the undrawn source reservation.');
    }
    return action;
  }

  async #releaseUndrawnReservation(
    context: MigrationExecutionContext,
    artifacts: ProductionArtifacts,
    payload: Record<string, unknown>,
  ): Promise<FinalizedChainAction> {
    const migrationId = context.migration.migrationId as Hex;
    const existing = await this.#eventAction(
      this.#sourcePublic,
      this.#environment.SOURCE_CHAIN_ID,
      this.#environment.SOURCE_VAULT_ADDRESS,
      eventTopics.reservationReleased,
      [migrationId],
      { ...payload, reconciled: true },
    );
    const action =
      existing ??
      (await this.#writeAction(
        this.#sourceWallet,
        this.#sourcePublic,
        this.#environment.SOURCE_CHAIN_ID,
        artifacts.vault,
        this.#environment.SOURCE_VAULT_ADDRESS,
        'release',
        [migrationId],
        payload,
      ));
    const exposure = await this.#readSolverExposure(artifacts.vault, migrationId);
    if (exposure.status !== 4 || exposure.principalUnits !== 0n) {
      throw new Error('Reservation release did not clear the undrawn source exposure.');
    }
    return action;
  }

  async #recordCapacityDeterioration(
    context: MigrationExecutionContext,
    artifacts: ProductionArtifacts,
    revalidation: FinancingRevalidation,
  ): Promise<FinalizedChainAction> {
    const proof = await this.#recordDestinationFeasibility(context, artifacts, revalidation);
    const receipt = await this.#destinationPublic.waitForTransactionReceipt({
      hash: proof.transactionHash,
      confirmations: this.#environment.DESTINATION_FINALITY_CONFIRMATIONS,
    });
    if (receipt.status !== 'success') {
      throw new Error(`Failed destination feasibility reverted: ${proof.transactionHash}`);
    }
    const migrationId = context.migration.migrationId as Hex;
    const [collateralCustody, exposure] = await Promise.all([
      this.#readBigInt(
        this.#destinationPublic,
        artifacts.escrow,
        this.#environment.DESTINATION_ESCROW_ADDRESS,
        'categorizedBalances',
        [migrationId, this.#environment.DESTINATION_COLLATERAL_TOKEN_ADDRESS, 0],
      ),
      this.#readSolverExposure(artifacts.vault, migrationId),
    ]);
    if (collateralCustody === 0n) {
      throw new Error('Capacity deterioration has no verified destination collateral custody.');
    }
    const collateralClaim = {
      kind: 'COLLATERAL_CUSTODY',
      chainId: this.#environment.DESTINATION_CHAIN_ID,
      escrow: this.#environment.DESTINATION_ESCROW_ADDRESS,
      asset: this.#environment.DESTINATION_COLLATERAL_TOKEN_ADDRESS,
      amountUnits: collateralCustody.toString(),
      disposition: 'HELD_FOR_SIGNED_RECOVERY',
    } as const;
    const solverClaim = {
      kind: 'SOLVER_RECEIVABLE',
      chainId: this.#environment.SOURCE_CHAIN_ID,
      provider: this.#environment.SOURCE_VAULT_ADDRESS,
      asset: this.#environment.SOURCE_DEBT_TOKEN_ADDRESS,
      principalUnits: exposure.principalUnits.toString(),
      feeUnits: exposure.feeUnits.toString(),
      disposition: 'UNSETTLED_EXPLICIT_CLAIM',
    } as const;
    return finalizedAction(
      this.#environment.DESTINATION_CHAIN_ID,
      receipt,
      this.#environment.DESTINATION_FINALITY_CONFIRMATIONS,
      {
        action: 'recordCapacityDeterioration',
        reason: 'DESTINATION_CAPACITY_DETERIORATED_AFTER_SOURCE_CLOSE',
        policy: 'RETURN_VERIFIED_COLLATERAL_PRESERVE_SOLVER_RECEIVABLE',
        feasibilityHash: proof.feasibilityHash,
        financingRevalidation: revalidation,
        residualAssets: [collateralClaim, solverClaim],
      },
    );
  }

  async #registerVerifiedSourceRefund(
    context: MigrationExecutionContext,
    artifacts: ProductionArtifacts,
  ): Promise<Record<string, unknown> | undefined> {
    if (
      context.transportLeg.providerState !== 'REFUNDED' ||
      context.transportLeg.refundTransactionHash === null ||
      context.transportLeg.observedOutputUnits === null
    ) {
      return undefined;
    }
    const migrationId = context.migration.migrationId as Hex;
    const refundHash = context.transportLeg.refundTransactionHash as Hex;
    const evidenceHash = transportInboundEvidenceHash(
      migrationId,
      refundHash,
      hashCanonicalText(
        `debtshift.verified-refund.v1:${context.quote.quoteHash}:${context.transportLeg.providerReference ?? ''}`,
      ),
    );
    const existing = await this.#eventAction(
      this.#sourcePublic,
      this.#environment.SOURCE_CHAIN_ID,
      this.#environment.SOURCE_ESCROW_ADDRESS,
      eventTopics.transportInbound,
      [migrationId, addressTopic(this.#environment.SOURCE_COLLATERAL_TOKEN_ADDRESS), evidenceHash],
      { action: 'registerSourceRefund', reconciled: true },
    );
    if (existing !== undefined) {
      return { evidenceHash, registrationTransactionHash: existing.transactionHash };
    }
    const amount = BigInt(context.transportLeg.observedOutputUnits);
    const providerReceipt = await this.#verifiedTokenDelivery(
      this.#sourcePublic,
      refundHash,
      this.#environment.SOURCE_COLLATERAL_TOKEN_ADDRESS,
      this.#environment.SOURCE_ESCROW_ADDRESS,
      amount,
      this.#environment.SOURCE_FINALITY_CONFIRMATIONS,
    );
    const registration = await this.#writeAction(
      this.#sourceWallet,
      this.#sourcePublic,
      this.#environment.SOURCE_CHAIN_ID,
      artifacts.escrow,
      this.#environment.SOURCE_ESCROW_ADDRESS,
      'registerTransportInbound',
      [migrationId, this.#environment.SOURCE_COLLATERAL_TOKEN_ADDRESS, amount, evidenceHash],
      {
        action: 'registerSourceRefund',
        providerTransactionHash: refundHash,
        providerBlockNumber: providerReceipt.blockNumber.toString(),
        providerBlockHash: providerReceipt.blockHash,
        amountUnits: amount.toString(),
        evidenceHash,
      },
    );
    return { evidenceHash, registrationTransactionHash: registration.transactionHash };
  }

  async #settleRecoveryReserveIfDrawn(
    context: MigrationExecutionContext,
    artifacts: ProductionArtifacts,
  ): Promise<Record<string, unknown>> {
    const migrationId = context.migration.migrationId as Hex;
    const exposure = await this.#readSolverExposure(artifacts.vault, migrationId);
    if (exposure.status === 3) {
      return {
        status: 'ALREADY_SETTLED',
        principalUnits: exposure.principalUnits.toString(),
        feeUnits: exposure.feeUnits.toString(),
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
        principalUnits: exposure.principalUnits.toString(),
        feeUnits: exposure.feeUnits.toString(),
        maximumReserveUnits: exposure.recoveryReserveUnits.toString(),
      },
    );
    return {
      status: 'SETTLED_FROM_ISOLATED_RESERVE',
      transactionHash: settlement.transactionHash,
      blockNumber: settlement.blockNumber,
      blockHash: settlement.blockHash,
      principalUnits: exposure.principalUnits.toString(),
      feeUnits: exposure.feeUnits.toString(),
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
      exposure.status !== expectedStatus ||
      (expectedStatus === 1 ? exposure.principalUnits !== 0n : exposure.principalUnits === 0n) ||
      !isAddressEqual(exposure.recoveryReserveProvider, this.#account.address) ||
      exposure.recoveryReserveUnits !== expectedUnits
    ) {
      throw new Error(
        'The migration-specific source settlement recovery reserve is not fully locked.',
      );
    }
  }

  async #assertExactAaveCollateralAuthorization(context: MigrationExecutionContext): Promise<void> {
    const reserveTokens = await readAaveReserveTokenAddresses(
      this.#sourcePublic,
      this.#configuration.source.dataProvider,
      this.#environment.SOURCE_COLLATERAL_TOKEN_ADDRESS,
    );
    const allowance = await this.#sourcePublic.readContract({
      address: reserveTokens.aToken,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [context.signedPlan.plan.borrower, this.#environment.SOURCE_LENDING_ADDRESS],
    });
    if (allowance !== BigInt(context.signedPlan.plan.sourceCollateralMinUnits)) {
      throw new Error(
        'Borrower must approve exactly the signed aToken collateral amount to the Aave source module.',
      );
    }
  }

  #oneClickDepositAddress(context: MigrationExecutionContext): Address {
    if (context.quote.depositMemo !== undefined) {
      throw new Error(
        'The initial EVM 1Click route does not support memo-based deposit addresses.',
      );
    }
    try {
      return getAddress(context.quote.depositAddress ?? '');
    } catch {
      throw new Error('Committed 1Click deposit address is not a valid EVM address.');
    }
  }

  async #verifyDeploymentBindings(): Promise<void> {
    const artifacts = await this.#artifacts;
    const [sourceChainId, destinationChainId] = await Promise.all([
      this.#sourcePublic.getChainId(),
      this.#destinationPublic.getChainId(),
    ]);
    if (
      sourceChainId !== this.#environment.SOURCE_CHAIN_ID ||
      destinationChainId !== this.#environment.DESTINATION_CHAIN_ID
    ) {
      throw new Error('Configured production RPC endpoints returned unexpected chain IDs.');
    }
    const sourceContracts = [
      this.#environment.SOURCE_VAULT_ADDRESS,
      this.#environment.SOURCE_ESCROW_ADDRESS,
      this.#environment.SOURCE_LENDING_ADDRESS,
      this.#environment.SOURCE_ADAPTER_ADDRESS,
    ] as const;
    const destinationContracts = [
      this.#environment.DESTINATION_ESCROW_ADDRESS,
      this.#environment.DESTINATION_LENDING_ADDRESS,
      this.#environment.DESTINATION_ADAPTER_ADDRESS,
    ] as const;
    const codes = await Promise.all([
      ...sourceContracts.map((address) => this.#sourcePublic.getCode({ address })),
      ...destinationContracts.map((address) => this.#destinationPublic.getCode({ address })),
    ]);
    if (codes.some((code) => code === undefined || code === '0x')) {
      throw new Error('One or more configured DebtShift deployment addresses contain no code.');
    }

    assertAddressBindings([
      [
        this.#environment.EIP712_VERIFYING_CONTRACT,
        this.#environment.SOURCE_ADAPTER_ADDRESS,
        'EIP-712 verifying contract',
      ],
      [
        this.#environment.SOURCE_COLLATERAL_TOKEN_ADDRESS,
        this.#configuration.source.collateralAsset.address,
        'source collateral configuration',
      ],
      [
        this.#environment.SOURCE_DEBT_TOKEN_ADDRESS,
        this.#configuration.source.debtAsset.address,
        'source debt configuration',
      ],
      [
        this.#environment.DESTINATION_COLLATERAL_TOKEN_ADDRESS,
        this.#configuration.destination.collateralAsset.address,
        'destination collateral configuration',
      ],
      [
        this.#environment.DESTINATION_DEBT_TOKEN_ADDRESS,
        this.#configuration.destination.debtAsset.address,
        'destination debt configuration',
      ],
    ]);

    const reserveTokens = await readAaveReserveTokenAddresses(
      this.#sourcePublic,
      this.#configuration.source.dataProvider,
      this.#environment.SOURCE_COLLATERAL_TOKEN_ADDRESS,
    );
    const [
      sourceAdapterVault,
      sourceAdapterLending,
      sourceAdapterEscrow,
      sourceAdapterDebtToken,
      sourceAdapterCollateralToken,
      sourceLendingPool,
      sourceLendingAToken,
      sourceLendingVariableDebtToken,
      sourceLendingCollateralToken,
      sourceLendingDebtToken,
      sourceLendingAdapter,
      destinationAdapterLending,
      destinationAdapterEscrow,
      destinationAdapterDebtToken,
      destinationAdapterCollateralToken,
      targetLendingMorpho,
      targetLendingCollateralToken,
      targetLendingDebtToken,
      targetLendingAdapter,
      targetMarketId,
    ] = await Promise.all([
      this.#readAddress(
        this.#sourcePublic,
        artifacts.sourceAdapter,
        this.#environment.SOURCE_ADAPTER_ADDRESS,
        'vault',
        [],
      ),
      this.#readAddress(
        this.#sourcePublic,
        artifacts.sourceAdapter,
        this.#environment.SOURCE_ADAPTER_ADDRESS,
        'lending',
        [],
      ),
      this.#readAddress(
        this.#sourcePublic,
        artifacts.sourceAdapter,
        this.#environment.SOURCE_ADAPTER_ADDRESS,
        'escrow',
        [],
      ),
      this.#readAddress(
        this.#sourcePublic,
        artifacts.sourceAdapter,
        this.#environment.SOURCE_ADAPTER_ADDRESS,
        'debtToken',
        [],
      ),
      this.#readAddress(
        this.#sourcePublic,
        artifacts.sourceAdapter,
        this.#environment.SOURCE_ADAPTER_ADDRESS,
        'collateralToken',
        [],
      ),
      this.#readAddress(
        this.#sourcePublic,
        artifacts.sourceLending,
        this.#environment.SOURCE_LENDING_ADDRESS,
        'pool',
        [],
      ),
      this.#readAddress(
        this.#sourcePublic,
        artifacts.sourceLending,
        this.#environment.SOURCE_LENDING_ADDRESS,
        'aToken',
        [],
      ),
      this.#readAddress(
        this.#sourcePublic,
        artifacts.sourceLending,
        this.#environment.SOURCE_LENDING_ADDRESS,
        'variableDebtToken',
        [],
      ),
      this.#readAddress(
        this.#sourcePublic,
        artifacts.sourceLending,
        this.#environment.SOURCE_LENDING_ADDRESS,
        'collateralToken',
        [],
      ),
      this.#readAddress(
        this.#sourcePublic,
        artifacts.sourceLending,
        this.#environment.SOURCE_LENDING_ADDRESS,
        'debtToken',
        [],
      ),
      this.#readAddress(
        this.#sourcePublic,
        artifacts.sourceLending,
        this.#environment.SOURCE_LENDING_ADDRESS,
        'sourceAdapter',
        [],
      ),
      this.#readAddress(
        this.#destinationPublic,
        artifacts.destinationAdapter,
        this.#environment.DESTINATION_ADAPTER_ADDRESS,
        'lending',
        [],
      ),
      this.#readAddress(
        this.#destinationPublic,
        artifacts.destinationAdapter,
        this.#environment.DESTINATION_ADAPTER_ADDRESS,
        'escrow',
        [],
      ),
      this.#readAddress(
        this.#destinationPublic,
        artifacts.destinationAdapter,
        this.#environment.DESTINATION_ADAPTER_ADDRESS,
        'debtToken',
        [],
      ),
      this.#readAddress(
        this.#destinationPublic,
        artifacts.destinationAdapter,
        this.#environment.DESTINATION_ADAPTER_ADDRESS,
        'collateralToken',
        [],
      ),
      this.#readAddress(
        this.#destinationPublic,
        artifacts.targetLending,
        this.#environment.DESTINATION_LENDING_ADDRESS,
        'morpho',
        [],
      ),
      this.#readAddress(
        this.#destinationPublic,
        artifacts.targetLending,
        this.#environment.DESTINATION_LENDING_ADDRESS,
        'collateralToken',
        [],
      ),
      this.#readAddress(
        this.#destinationPublic,
        artifacts.targetLending,
        this.#environment.DESTINATION_LENDING_ADDRESS,
        'debtToken',
        [],
      ),
      this.#readAddress(
        this.#destinationPublic,
        artifacts.targetLending,
        this.#environment.DESTINATION_LENDING_ADDRESS,
        'destinationAdapter',
        [],
      ),
      this.#readHex(
        this.#destinationPublic,
        artifacts.targetLending,
        this.#environment.DESTINATION_LENDING_ADDRESS,
        'marketId',
        [],
      ),
    ]);
    assertAddressBindings([
      [sourceAdapterVault, this.#environment.SOURCE_VAULT_ADDRESS, 'source adapter vault'],
      [sourceAdapterLending, this.#environment.SOURCE_LENDING_ADDRESS, 'source adapter lending'],
      [sourceAdapterEscrow, this.#environment.SOURCE_ESCROW_ADDRESS, 'source adapter escrow'],
      [
        sourceAdapterDebtToken,
        this.#environment.SOURCE_DEBT_TOKEN_ADDRESS,
        'source adapter debt token',
      ],
      [
        sourceAdapterCollateralToken,
        this.#environment.SOURCE_COLLATERAL_TOKEN_ADDRESS,
        'source adapter collateral token',
      ],
      [sourceLendingPool, this.#configuration.source.pool, 'Aave source pool'],
      [sourceLendingAToken, reserveTokens.aToken, 'Aave source aToken'],
      [
        sourceLendingVariableDebtToken,
        reserveTokens.variableDebtToken,
        'Aave source variable debt token',
      ],
      [
        sourceLendingCollateralToken,
        this.#environment.SOURCE_COLLATERAL_TOKEN_ADDRESS,
        'Aave source collateral token',
      ],
      [
        sourceLendingDebtToken,
        this.#environment.SOURCE_DEBT_TOKEN_ADDRESS,
        'Aave source debt token',
      ],
      [sourceLendingAdapter, this.#environment.SOURCE_ADAPTER_ADDRESS, 'Aave source adapter'],
      [
        destinationAdapterLending,
        this.#environment.DESTINATION_LENDING_ADDRESS,
        'destination adapter lending',
      ],
      [
        destinationAdapterEscrow,
        this.#environment.DESTINATION_ESCROW_ADDRESS,
        'destination adapter escrow',
      ],
      [
        destinationAdapterDebtToken,
        this.#environment.DESTINATION_DEBT_TOKEN_ADDRESS,
        'destination adapter debt token',
      ],
      [
        destinationAdapterCollateralToken,
        this.#environment.DESTINATION_COLLATERAL_TOKEN_ADDRESS,
        'destination adapter collateral token',
      ],
      [targetLendingMorpho, this.#configuration.destination.morpho, 'Morpho deployment'],
      [
        targetLendingCollateralToken,
        this.#environment.DESTINATION_COLLATERAL_TOKEN_ADDRESS,
        'Morpho target collateral token',
      ],
      [
        targetLendingDebtToken,
        this.#environment.DESTINATION_DEBT_TOKEN_ADDRESS,
        'Morpho target debt token',
      ],
      [
        targetLendingAdapter,
        this.#environment.DESTINATION_ADAPTER_ADDRESS,
        'Morpho destination adapter',
      ],
    ]);
    if (targetMarketId.toLowerCase() !== this.#configuration.destination.marketId.toLowerCase()) {
      throw new Error('Morpho target module market ID does not match the allowlisted route.');
    }
    const [
      sourcePaused,
      sourceExecutor,
      destinationPaused,
      destinationExecutor,
      destinationVerifier,
    ] = await Promise.all([
      this.#readBoolean(
        this.#sourcePublic,
        artifacts.sourceAdapter,
        this.#environment.SOURCE_ADAPTER_ADDRESS,
        'paused',
        [],
      ),
      this.#readBoolean(
        this.#sourcePublic,
        artifacts.sourceAdapter,
        this.#environment.SOURCE_ADAPTER_ADDRESS,
        'executors',
        [this.#account.address],
      ),
      this.#readBoolean(
        this.#destinationPublic,
        artifacts.destinationAdapter,
        this.#environment.DESTINATION_ADAPTER_ADDRESS,
        'paused',
        [],
      ),
      this.#readBoolean(
        this.#destinationPublic,
        artifacts.destinationAdapter,
        this.#environment.DESTINATION_ADAPTER_ADDRESS,
        'executors',
        [this.#account.address],
      ),
      this.#readBoolean(
        this.#destinationPublic,
        artifacts.destinationAdapter,
        this.#environment.DESTINATION_ADAPTER_ADDRESS,
        'verifiers',
        [this.#account.address],
      ),
    ]);
    if (
      sourcePaused ||
      destinationPaused ||
      !sourceExecutor ||
      !destinationExecutor ||
      !destinationVerifier
    ) {
      throw new Error(
        'DebtShift deployment pause state or executor/verifier roles are not execution-ready.',
      );
    }
    const planDomain = keccak256(
      encodeAbiParameters(parseAbiParameters('uint256, address'), [
        BigInt(this.#environment.SOURCE_CHAIN_ID),
        this.#environment.SOURCE_ADAPTER_ADDRESS,
      ]),
    );
    const [
      vaultOperator,
      vaultVerifier,
      vaultAdapter,
      vaultAsset,
      sourceEscrowOperator,
      sourceEscrowDepositor,
      destinationEscrowOperator,
      destinationAdapterEscrowOperator,
      destinationPlanDomain,
    ] = await Promise.all([
      this.#readBoolean(
        this.#sourcePublic,
        artifacts.vault,
        this.#environment.SOURCE_VAULT_ADDRESS,
        'operators',
        [this.#account.address],
      ),
      this.#readBoolean(
        this.#sourcePublic,
        artifacts.vault,
        this.#environment.SOURCE_VAULT_ADDRESS,
        'verifiers',
        [this.#account.address],
      ),
      this.#readBoolean(
        this.#sourcePublic,
        artifacts.vault,
        this.#environment.SOURCE_VAULT_ADDRESS,
        'adapters',
        [this.#environment.SOURCE_ADAPTER_ADDRESS],
      ),
      this.#readBoolean(
        this.#sourcePublic,
        artifacts.vault,
        this.#environment.SOURCE_VAULT_ADDRESS,
        'assets',
        [this.#environment.SOURCE_DEBT_TOKEN_ADDRESS],
      ),
      this.#readBoolean(
        this.#sourcePublic,
        artifacts.escrow,
        this.#environment.SOURCE_ESCROW_ADDRESS,
        'operators',
        [this.#account.address],
      ),
      this.#readBoolean(
        this.#sourcePublic,
        artifacts.escrow,
        this.#environment.SOURCE_ESCROW_ADDRESS,
        'depositors',
        [this.#environment.SOURCE_ADAPTER_ADDRESS],
      ),
      this.#readBoolean(
        this.#destinationPublic,
        artifacts.escrow,
        this.#environment.DESTINATION_ESCROW_ADDRESS,
        'operators',
        [this.#account.address],
      ),
      this.#readBoolean(
        this.#destinationPublic,
        artifacts.escrow,
        this.#environment.DESTINATION_ESCROW_ADDRESS,
        'operators',
        [this.#environment.DESTINATION_ADAPTER_ADDRESS],
      ),
      this.#readBoolean(
        this.#destinationPublic,
        artifacts.destinationAdapter,
        this.#environment.DESTINATION_ADAPTER_ADDRESS,
        'planDomains',
        [planDomain],
      ),
    ]);
    if (
      !vaultOperator ||
      !vaultVerifier ||
      !vaultAdapter ||
      !vaultAsset ||
      !sourceEscrowOperator ||
      !sourceEscrowDepositor ||
      !destinationEscrowOperator ||
      !destinationAdapterEscrowOperator ||
      !destinationPlanDomain
    ) {
      throw new Error(
        'Vault, escrow, or destination plan-domain allowlists are not execution-ready.',
      );
    }
  }

  async #verifiedTokenDelivery(
    client: EvmPublicClient,
    transactionHash: Hex,
    token: Address,
    receiver: Address,
    minimumUnits: bigint,
    confirmations: number,
  ): Promise<TransactionReceipt> {
    if (minimumUnits <= 0n) throw new Error('Verified token delivery must be positive.');
    const receipt = await client.waitForTransactionReceipt({
      hash: transactionHash,
      confirmations,
    });
    if (receipt.status !== 'success') {
      throw new Error(`Provider custody transaction reverted: ${transactionHash}`);
    }
    const receiverTopic = addressTopic(receiver).toLowerCase();
    const transferred = receipt.logs
      .filter(
        (log) =>
          isAddressEqual(log.address, token) &&
          log.topics[0]?.toLowerCase() === eventTopics.transfer.toLowerCase() &&
          log.topics[2]?.toLowerCase() === receiverTopic &&
          /^0x[0-9a-fA-F]{64}$/.test(log.data),
      )
      .reduce((total, log) => total + BigInt(log.data), 0n);
    if (transferred < minimumUnits) {
      throw new Error(
        `Provider receipt proves only ${transferred} of ${minimumUnits} required token units to the bound escrow.`,
      );
    }
    const tip = await client.getBlockNumber();
    const depth = tip >= receipt.blockNumber ? tip - receipt.blockNumber + 1n : 0n;
    if (depth < BigInt(confirmations)) {
      throw new Error(
        `Provider receipt has only ${depth} of ${confirmations} required confirmations.`,
      );
    }
    const canonical = await client.getBlock({ blockNumber: receipt.blockNumber });
    if (canonical.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) {
      throw new Error('Provider custody receipt is no longer in the canonical block.');
    }
    return receipt;
  }

  async #assertLiquidityPayout(
    transactionHash: Hex,
    migrationId: Hex,
    receiver: Address,
    principalUnits: bigint,
    feeUnits: bigint,
  ): Promise<void> {
    const receipt = await this.#destinationPublic.getTransactionReceipt({ hash: transactionHash });
    const expectedTopics = [
      eventTopics.liquidityPayout,
      migrationId,
      addressTopic(receiver),
      addressTopic(this.#environment.DESTINATION_DEBT_TOKEN_ADDRESS),
    ].map((topic) => topic.toLowerCase());
    const expectedData = encodeAbiParameters(parseAbiParameters('uint256, uint256'), [
      principalUnits,
      feeUnits,
    ]).toLowerCase();
    const found = receipt.logs.some(
      (log) =>
        isAddressEqual(log.address, this.#environment.DESTINATION_ADAPTER_ADDRESS) &&
        expectedTopics.every((topic, index) => log.topics[index]?.toLowerCase() === topic) &&
        log.data.toLowerCase() === expectedData,
    );
    if (!found) {
      throw new Error(
        'Destination receipt does not prove the exact per-migration solver principal and fee payout.',
      );
    }
  }

  async #readSolverExposure(artifact: FoundryArtifact, migrationId: Hex): Promise<SolverExposure> {
    const result = await this.#sourcePublic.readContract({
      address: this.#environment.SOURCE_VAULT_ADDRESS,
      abi: artifact.abi,
      functionName: 'reservations',
      args: [migrationId],
    });
    const values = Array.isArray(result) ? result : undefined;
    const feeUnits = values?.[4];
    const status = values?.[6];
    const principalUnits = values?.[8];
    const recoveryReserveProvider = values?.[9];
    const recoveryReserveUnits = values?.[10];
    if (
      typeof feeUnits !== 'bigint' ||
      (typeof status !== 'number' && typeof status !== 'bigint') ||
      typeof principalUnits !== 'bigint' ||
      typeof recoveryReserveProvider !== 'string' ||
      typeof recoveryReserveUnits !== 'bigint'
    ) {
      throw new Error('Unexpected source vault reservation response.');
    }
    return {
      principalUnits,
      feeUnits,
      status: Number(status),
      recoveryReserveProvider: getAddress(recoveryReserveProvider),
      recoveryReserveUnits,
    };
  }

  async #approveExact(
    wallet: EvmWalletClient,
    client: EvmPublicClient,
    token: Address,
    spender: Address,
    amount: bigint,
  ): Promise<readonly Hex[]> {
    const allowance = await client.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [this.#account.address, spender],
    });
    if (allowance === amount) return [];
    const hashes: Hex[] = [];
    if (allowance !== 0n) {
      hashes.push(await this.#writeErc20Approval(wallet, client, token, spender, 0n));
    }
    hashes.push(await this.#writeErc20Approval(wallet, client, token, spender, amount));
    return hashes;
  }

  async #writeErc20Approval(
    wallet: EvmWalletClient,
    client: EvmPublicClient,
    token: Address,
    spender: Address,
    amount: bigint,
  ): Promise<Hex> {
    const simulation = await client.simulateContract({
      account: this.#account,
      address: token,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [spender, amount],
    });
    const hash = await wallet.writeContract(simulation.request);
    const receipt = await client.waitForTransactionReceipt({
      hash,
      confirmations: this.#confirmationsForClient(client),
    });
    if (receipt.status !== 'success') throw new Error(`ERC-20 approval reverted: ${hash}`);
    return hash;
  }

  async #erc20Balance(client: EvmPublicClient, token: Address, account: Address): Promise<bigint> {
    return client.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [account],
    });
  }

  async #readBoolean(
    client: EvmPublicClient,
    artifact: FoundryArtifact,
    address: Address,
    functionName: string,
    args: readonly unknown[],
  ): Promise<boolean> {
    const result = await client.readContract({
      address,
      abi: artifact.abi,
      functionName,
      args,
    });
    if (typeof result !== 'boolean') {
      throw new Error(`Unexpected ${functionName} response from ${address}.`);
    }
    return result;
  }

  async #readAddress(
    client: EvmPublicClient,
    artifact: FoundryArtifact,
    address: Address,
    functionName: string,
    args: readonly unknown[],
  ): Promise<Address> {
    const result = await client.readContract({ address, abi: artifact.abi, functionName, args });
    if (typeof result !== 'string') {
      throw new Error(`Unexpected ${functionName} response from ${address}.`);
    }
    try {
      return getAddress(result);
    } catch {
      throw new Error(`Invalid address returned by ${functionName} on ${address}.`);
    }
  }

  async #readBigInt(
    client: EvmPublicClient,
    artifact: FoundryArtifact,
    address: Address,
    functionName: string,
    args: readonly unknown[],
  ): Promise<bigint> {
    const result = await client.readContract({ address, abi: artifact.abi, functionName, args });
    if (typeof result !== 'bigint') {
      throw new Error(`Unexpected ${functionName} response from ${address}.`);
    }
    return result;
  }

  async #readHex(
    client: EvmPublicClient,
    artifact: FoundryArtifact,
    address: Address,
    functionName: string,
    args: readonly unknown[],
  ): Promise<Hex> {
    const result = await client.readContract({ address, abi: artifact.abi, functionName, args });
    if (typeof result !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(result)) {
      throw new Error(`Unexpected ${functionName} response from ${address}.`);
    }
    return result as Hex;
  }

  async #writeHash(
    wallet: EvmWalletClient,
    client: EvmPublicClient,
    artifact: FoundryArtifact,
    address: Address,
    functionName: string,
    args: readonly unknown[],
  ): Promise<Hex> {
    const simulation = await client.simulateContract({
      account: this.#account,
      address,
      abi: artifact.abi,
      functionName,
      args,
    });
    const hash = await wallet.writeContract(simulation.request);
    const receipt = await client.waitForTransactionReceipt({
      hash,
      confirmations: this.#confirmationsForClient(client),
    });
    if (receipt.status !== 'success') throw new Error(`${functionName} reverted: ${hash}`);
    return hash;
  }

  async #writeAction(
    wallet: EvmWalletClient,
    client: EvmPublicClient,
    chainId: number,
    artifact: FoundryArtifact,
    address: Address,
    functionName: string,
    args: readonly unknown[],
    payload: Record<string, unknown>,
  ): Promise<FinalizedChainAction> {
    const simulation = await client
      .simulateContract({
        account: this.#account,
        address,
        abi: artifact.abi,
        functionName,
        args,
      })
      .catch((error: unknown) => {
        throw new PreBroadcastSimulationError(functionName, error);
      });
    const hash = await wallet.writeContract(simulation.request);
    const confirmations = this.#confirmationsForClient(client);
    const receipt = await client.waitForTransactionReceipt({ hash, confirmations });
    if (receipt.status !== 'success') throw new FinalizedTransactionRevertError(functionName, hash);
    return finalizedAction(chainId, receipt, confirmations, payload);
  }

  async #eventAction(
    client: EvmPublicClient,
    chainId: number,
    address: Address,
    eventSignature: Hex,
    indexedTopics: readonly Hex[],
    payload: Record<string, unknown>,
  ): Promise<FinalizedChainAction | undefined> {
    const logs = await client.getLogs({
      address,
      fromBlock: this.#deploymentBlockForClient(client),
      toBlock: 'latest',
    });
    const expected = [eventSignature, ...indexedTopics].map((topic) => topic.toLowerCase());
    const found = logs.findLast((log) =>
      expected.every((topic, index) => log.topics[index]?.toLowerCase() === topic),
    );
    if (found === undefined) return undefined;
    const confirmations = this.#confirmationsForClient(client);
    const receipt = await client.waitForTransactionReceipt({
      hash: found.transactionHash,
      confirmations,
    });
    if (receipt.status !== 'success') {
      throw new Error(`Previously observed transaction reverted: ${found.transactionHash}`);
    }
    return finalizedAction(chainId, receipt, confirmations, payload);
  }

  #clientForChain(chainId: number): EvmPublicClient | undefined {
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

  #confirmationsForClient(client: EvmPublicClient): number {
    return client === this.#sourcePublic
      ? this.#environment.SOURCE_FINALITY_CONFIRMATIONS
      : this.#environment.DESTINATION_FINALITY_CONFIRMATIONS;
  }

  #deploymentBlockForClient(client: EvmPublicClient): bigint {
    return BigInt(
      client === this.#sourcePublic
        ? this.#environment.SOURCE_DEPLOYMENT_BLOCK_NUMBER
        : this.#environment.DESTINATION_DEPLOYMENT_BLOCK_NUMBER,
    );
  }
}

function finalizedAction(
  chainId: number,
  receipt: TransactionReceipt,
  confirmations: number,
  payload: Record<string, unknown>,
): FinalizedChainAction {
  return {
    chainId,
    transactionHash: receipt.transactionHash,
    blockNumber: receipt.blockNumber.toString(),
    blockHash: receipt.blockHash,
    payload: {
      ...payload,
      finality: { requiredConfirmations: confirmations, canonicalBlockVerified: true },
    },
  };
}

function transportInboundEvidenceHash(
  migrationId: Hex,
  transactionHash: Hex,
  observationHash: Hex,
): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters('bytes32, bytes32, bytes32'), [
      migrationId,
      transactionHash,
      observationHash,
    ]),
  );
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

function assertAddressBindings(bindings: readonly (readonly [Address, Address, string])[]): void {
  for (const [actual, expected, label] of bindings) {
    if (!isAddressEqual(actual, expected)) {
      throw new Error(`${label} is bound to ${actual}, expected ${expected}.`);
    }
  }
}

function zeroBytes32(): Hex {
  return `0x${'00'.repeat(32)}`;
}

function minBigInt(first: bigint, ...values: readonly bigint[]): bigint {
  return values.reduce((minimum, value) => (value < minimum ? value : minimum), first);
}

function withRevalidation(
  action: FinalizedChainAction,
  financingRevalidation: FinancingRevalidation,
): FinalizedChainAction {
  return { ...action, payload: { ...action.payload, financingRevalidation } };
}

function evmChain(id: number, name: string, rpcUrl: string): Chain {
  return defineChain({
    id,
    name,
    nativeCurrency: { name: 'Native gas token', symbol: 'GAS', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

async function loadProductionArtifacts(): Promise<ProductionArtifacts> {
  const [vault, escrow, sourceLending, targetLending, sourceAdapter, destinationAdapter] =
    await Promise.all([
      loadFoundryArtifact('LiquidityVault'),
      loadFoundryArtifact('MigrationEscrow'),
      loadFoundryArtifact('AaveV3SourceLending'),
      loadFoundryArtifact('MorphoBlueTargetLending'),
      loadFoundryArtifact('SourceAdapter'),
      loadFoundryArtifact('DestinationAdapter'),
    ]);
  return { vault, escrow, sourceLending, targetLending, sourceAdapter, destinationAdapter };
}
