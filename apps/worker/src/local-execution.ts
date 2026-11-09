import type { MigrationExecutionContext } from '@debtshift/database';
import type { DebtShiftEnvironment } from '@debtshift/domain';
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

import type { FinalizedChainAction, LocalExecutionPort } from './handlers.js';

type LocalPublicClient = PublicClient<Transport, Chain>;
type LocalWalletClient = WalletClient<Transport, Chain, PrivateKeyAccount>;

interface LocalArtifacts {
  readonly token: FoundryArtifact;
  readonly vault: FoundryArtifact;
  readonly escrow: FoundryArtifact;
  readonly sourceAdapter: FoundryArtifact;
  readonly destinationAdapter: FoundryArtifact;
}

const eventTopics = {
  liquidityReserved: eventTopic(
    'LiquidityReserved(bytes32,address,address,uint256,uint256,uint64)',
  ),
  sourceClosed: eventTopic('SourceClosed(bytes32,address,uint256,uint256)'),
  balanceReleased: eventTopic('BalanceReleased(bytes32,address,address,uint256)'),
  collateralAssigned: eventTopic('CollateralAssigned(bytes32,address,address,uint256)'),
  destinationOpened: eventTopic('DestinationOpened(bytes32,address,uint256,uint256)'),
  liquiditySettled: eventTopic('LiquiditySettled(bytes32,uint256,uint256)'),
} as const;

/**
 * Executes only the disposable dual-Anvil workflow. This port is deliberately
 * unavailable in any funded mainnet mode; production adapters use separate ports.
 */
export class ViemLocalExecutionPort implements LocalExecutionPort {
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
    if (!['local', 'ci', 'testnet'].includes(environment.DEBTSHIFT_ENV)) {
      throw new Error('The local execution port is disabled outside local, CI, and testnet.');
    }
    if (
      environment.TRANSPORT_PROVIDER !== 'DEBTSHIFT_SIMULATOR' ||
      environment.INTENTS_MODE !== 'simulated'
    ) {
      throw new Error('The local execution port requires the explicitly simulated transport.');
    }
    if (environment.LOCAL_EXECUTOR_PRIVATE_KEY.length === 0) {
      throw new Error('LOCAL_EXECUTOR_PRIVATE_KEY is required by the local execution worker.');
    }

    this.#environment = environment;
    this.#account = privateKeyToAccount(environment.LOCAL_EXECUTOR_PRIVATE_KEY as Hex);
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
    if (existing !== undefined) return existing;

    const plan = context.signedPlan.plan;
    return this.#writeAction(
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
        BigInt(plan.principalMaxUnits),
        BigInt(plan.feeMaxUnits),
        BigInt(plan.deadline),
      ],
      {
        action: 'reserve',
        principalUnits: plan.principalMaxUnits,
        feeCapUnits: plan.feeMaxUnits,
      },
    );
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
    if (existing !== undefined) return existing;

    return this.#writeAction(
      this.#sourceWallet,
      this.#sourcePublic,
      this.#environment.SOURCE_CHAIN_ID,
      artifacts.sourceAdapter,
      this.#environment.SOURCE_ADAPTER_ADDRESS,
      'closeSource',
      [
        {
          migrationId,
          borrower: plan.borrower,
          maximumDebtUnits: BigInt(plan.sourceRepaymentMaxUnits),
          minimumCollateralUnits: BigInt(plan.sourceCollateralMinUnits),
          deadline: BigInt(plan.deadline),
        },
      ],
      {
        action: 'closeSource',
        borrower: plan.borrower,
        maximumDebtUnits: plan.sourceRepaymentMaxUnits,
        minimumCollateralUnits: plan.sourceCollateralMinUnits,
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
    if (existing !== undefined) return existing;

    if (context.transportLeg.observedOutputUnits === null) {
      throw new Error('Destination collateral has not been independently observed.');
    }
    const borrowUnits = BigInt(plan.principalMaxUnits) + BigInt(plan.feeMaxUnits);
    return this.#writeAction(
      this.#destinationWallet,
      this.#destinationPublic,
      this.#environment.DESTINATION_CHAIN_ID,
      artifacts.destinationAdapter,
      this.#environment.DESTINATION_ADAPTER_ADDRESS,
      'openDestination',
      [
        {
          migrationId,
          borrower: plan.borrower,
          payoutReceiver: plan.payoutReceiver,
          collateralUnits: BigInt(context.transportLeg.observedOutputUnits),
          minimumCollateralUnits: BigInt(plan.minDestinationCollateralUnits),
          borrowUnits,
          maximumDebtUnits: BigInt(plan.targetDebtMaxUnits),
          deadline: BigInt(plan.deadline),
        },
      ],
      {
        action: 'openTarget',
        borrower: plan.borrower,
        collateralUnits: context.transportLeg.observedOutputUnits,
        borrowUnits: borrowUnits.toString(),
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
    if (existing !== undefined) return existing;

    const repayment = BigInt(plan.principalMaxUnits) + BigInt(plan.feeMaxUnits);
    const auxiliaryTransactions = await this.#ensureTokenBalance(
      this.#sourceWallet,
      this.#sourcePublic,
      artifacts.token,
      this.#environment.SOURCE_DEBT_TOKEN_ADDRESS,
      repayment,
    );
    auxiliaryTransactions.push(
      await this.#writeHash(
        this.#sourceWallet,
        this.#sourcePublic,
        artifacts.token,
        this.#environment.SOURCE_DEBT_TOKEN_ADDRESS,
        'approve',
        [this.#environment.SOURCE_VAULT_ADDRESS, repayment],
      ),
    );
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
        auxiliaryTransactions,
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
    const existing = await this.#eventAction(
      this.#sourcePublic,
      this.#environment.SOURCE_CHAIN_ID,
      this.#environment.SOURCE_ESCROW_ADDRESS,
      eventTopics.balanceReleased,
      [
        migrationId,
        addressTopic(this.#environment.SOURCE_COLLATERAL_TOKEN_ADDRESS),
        addressTopic(plan.refundReceiver),
      ],
      { action: 'executeRecovery', reason, reconciled: true },
    );
    if (existing !== undefined) return existing;

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
    if (BigInt(context.quote.amountInUnits) > BigInt(context.sourceSnapshot.collateralUnits)) {
      throw new Error('The transport amount exceeds the observed source collateral.');
    }
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
    const receipt = await publicClient.waitForTransactionReceipt({ hash: transactionHash });
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
    const receipt = await publicClient.waitForTransactionReceipt({ hash: transactionHash });
    if (receipt.status !== 'success') {
      throw new Error(`${functionName} reverted: ${transactionHash}`);
    }
    return finalizedAction(chainId, receipt, payload);
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
    const receipt = await client.getTransactionReceipt({ hash: existing.transactionHash });
    if (receipt.status !== 'success') {
      throw new Error(`Previously observed transaction reverted: ${existing.transactionHash}`);
    }
    return finalizedAction(chainId, receipt, payload);
  }
}

function finalizedAction(
  chainId: number,
  receipt: TransactionReceipt,
  payload: Record<string, unknown>,
): FinalizedChainAction {
  return {
    chainId,
    transactionHash: receipt.transactionHash,
    blockNumber: receipt.blockNumber.toString(),
    blockHash: receipt.blockHash,
    payload,
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

function localChain(id: number, name: string, rpcUrl: string): Chain {
  return defineChain({
    id,
    name,
    nativeCurrency: { name: 'Local Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

async function loadArtifacts(): Promise<LocalArtifacts> {
  const [token, vault, escrow, sourceAdapter, destinationAdapter] = await Promise.all([
    loadFoundryArtifact('TestToken'),
    loadFoundryArtifact('TestLiquidityVault'),
    loadFoundryArtifact('MigrationEscrow'),
    loadFoundryArtifact('SourceAdapter'),
    loadFoundryArtifact('DestinationAdapter'),
  ]);
  return { token, vault, escrow, sourceAdapter, destinationAdapter };
}
