import type { MigrationExecutionContext } from '@debtshift/database';
import type { DebtShiftEnvironment } from '@debtshift/domain';
import {
  type DeterministicTransportSimulator,
  type SimulatorTransportState,
  type TransportObservation,
} from '@debtshift/intents';
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  isAddressEqual,
  type Address,
  type Chain,
  type Hex,
  type PrivateKeyAccount,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import type { TransportExecutionPort } from '../handlers.js';

type EvmPublicClient = PublicClient<Transport, Chain>;
type EvmWalletClient = WalletClient<Transport, Chain, PrivateKeyAccount>;

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
    name: 'transfer',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: 'transferred', type: 'bool' }],
  },
] as const;

/**
 * Simulates only the unavailable 1Click testnet boundary. Both the source
 * deposit and terminal delivery/refund are real public-testnet ERC-20
 * transactions funded by the configured transport/executor account.
 */
export class FundedTestnetTransportExecutionPort implements TransportExecutionPort {
  readonly provider = 'DEBTSHIFT_SIMULATOR' as const;
  readonly #account: PrivateKeyAccount;
  readonly #sourcePublic: EvmPublicClient;
  readonly #destinationPublic: EvmPublicClient;
  readonly #sourceWallet: EvmWalletClient;
  readonly #destinationWallet: EvmWalletClient;
  readonly #ready: Promise<void>;

  constructor(
    private readonly environment: DebtShiftEnvironment,
    private readonly simulator: DeterministicTransportSimulator,
  ) {
    if (environment.DEBTSHIFT_MODE !== 'testnet') {
      throw new Error('The funded simulated transport is available only in testnet mode.');
    }
    if (environment.EXECUTOR_PRIVATE_KEY.length === 0) {
      throw new Error('EXECUTOR_PRIVATE_KEY is required for funded testnet transport.');
    }
    this.#account = privateKeyToAccount(environment.EXECUTOR_PRIVATE_KEY as Hex);
    if (!isAddressEqual(this.#account.address, environment.EXECUTOR_ADDRESS)) {
      throw new Error('Testnet transport signer does not match EXECUTOR_ADDRESS.');
    }
    const sourceChain = chain(environment.SOURCE_CHAIN_ID, environment.SOURCE_RPC_URL);
    const destinationChain = chain(
      environment.DESTINATION_CHAIN_ID,
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
    this.#ready = this.#verifyReadiness();
  }

  async assertReady(): Promise<void> {
    await this.#ready;
  }

  async bindOrigin(
    context: MigrationExecutionContext,
    originTransactionHash: Hex,
  ): Promise<{ readonly providerReference: string; readonly observationCount: number }> {
    await this.#ready;
    this.#restore(context);
    const providerReference = await this.simulator.submitOrigin({
      quoteHash: context.quote.quoteHash as Hex,
      originTransactionHash,
    });
    return {
      providerReference,
      observationCount: this.simulator.getState(providerReference).pollCount,
    };
  }

  async observe(context: MigrationExecutionContext): Promise<{
    readonly observation: TransportObservation;
    readonly observationCount: number;
  }> {
    await this.#ready;
    this.#restore(context);
    const providerReference = context.transportLeg.providerReference ?? context.quote.quoteId;
    const observed = await this.simulator.getStatus(providerReference);
    let observation = observed;
    if (observed.status === 'SUCCESS') {
      const transactionHash =
        context.transportLeg.destinationTransactionHash === null
          ? await this.#transfer(
              this.#destinationWallet,
              this.#destinationPublic,
              this.environment.DESTINATION_COLLATERAL_TOKEN_ADDRESS,
              this.environment.DESTINATION_ESCROW_ADDRESS,
              BigInt(observed.observedAmountOutUnits),
              this.environment.DESTINATION_FINALITY_CONFIRMATIONS,
            )
          : (context.transportLeg.destinationTransactionHash as Hex);
      observation = { ...observed, destinationTransactionHash: transactionHash };
    } else if (observed.status === 'REFUNDED') {
      const transactionHash =
        context.transportLeg.refundTransactionHash === null
          ? await this.#transfer(
              this.#sourceWallet,
              this.#sourcePublic,
              this.environment.SOURCE_COLLATERAL_TOKEN_ADDRESS,
              this.environment.SOURCE_ESCROW_ADDRESS,
              BigInt(observed.observedAmountOutUnits),
              this.environment.SOURCE_FINALITY_CONFIRMATIONS,
            )
          : (context.transportLeg.refundTransactionHash as Hex);
      observation = { ...observed, refundTransactionHash: transactionHash };
    }
    return {
      observation,
      observationCount: this.simulator.getState(providerReference).pollCount,
    };
  }

  #restore(context: MigrationExecutionContext): void {
    const state: SimulatorTransportState = {
      pollCount: context.transportLeg.observationCount,
      ...(context.transportLeg.originTransactionHash === null
        ? {}
        : { originTransactionHash: context.transportLeg.originTransactionHash as Hex }),
    };
    this.simulator.restoreQuote(context.quote, state);
  }

  async #transfer(
    wallet: EvmWalletClient,
    client: EvmPublicClient,
    token: Address,
    receiver: Address,
    amount: bigint,
    confirmations: number,
  ): Promise<Hex> {
    const balance = await client.readContract({
      address: token,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [this.#account.address],
    });
    if (balance < amount) {
      throw new Error(
        `Testnet transport account is missing ${amount - balance} pre-funded token units.`,
      );
    }
    const simulation = await client.simulateContract({
      account: this.#account,
      address: token,
      abi: ERC20_ABI,
      functionName: 'transfer',
      args: [receiver, amount],
    });
    const transactionHash = await wallet.writeContract(simulation.request);
    const receipt = await client.waitForTransactionReceipt({
      hash: transactionHash,
      confirmations,
    });
    if (receipt.status !== 'success') {
      throw new Error(`Testnet transport custody transfer reverted: ${transactionHash}`);
    }
    return transactionHash;
  }

  async #verifyReadiness(): Promise<void> {
    const [
      sourceChainId,
      destinationChainId,
      sourceTokenCode,
      destinationTokenCode,
      sourceNativeBalanceWei,
      destinationNativeBalanceWei,
      sourceCollateralBalanceUnits,
      destinationCollateralBalanceUnits,
    ] = await Promise.all([
      this.#sourcePublic.getChainId(),
      this.#destinationPublic.getChainId(),
      this.#sourcePublic.getCode({
        address: this.environment.SOURCE_COLLATERAL_TOKEN_ADDRESS,
      }),
      this.#destinationPublic.getCode({
        address: this.environment.DESTINATION_COLLATERAL_TOKEN_ADDRESS,
      }),
      this.#sourcePublic.getBalance({ address: this.#account.address }),
      this.#destinationPublic.getBalance({ address: this.#account.address }),
      this.#sourcePublic.readContract({
        address: this.environment.SOURCE_COLLATERAL_TOKEN_ADDRESS,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [this.#account.address],
      }),
      this.#destinationPublic.readContract({
        address: this.environment.DESTINATION_COLLATERAL_TOKEN_ADDRESS,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [this.#account.address],
      }),
    ]);
    assertFundedTestnetTransportReadiness(this.environment, {
      sourceChainId,
      destinationChainId,
      sourceTokenCodePresent: sourceTokenCode !== undefined && sourceTokenCode !== '0x',
      destinationTokenCodePresent:
        destinationTokenCode !== undefined && destinationTokenCode !== '0x',
      sourceNativeBalanceWei,
      destinationNativeBalanceWei,
      sourceCollateralBalanceUnits,
      destinationCollateralBalanceUnits,
    });
  }
}

export interface FundedTestnetTransportReadiness {
  readonly sourceChainId: number;
  readonly destinationChainId: number;
  readonly sourceTokenCodePresent: boolean;
  readonly destinationTokenCodePresent: boolean;
  readonly sourceNativeBalanceWei: bigint;
  readonly destinationNativeBalanceWei: bigint;
  readonly sourceCollateralBalanceUnits: bigint;
  readonly destinationCollateralBalanceUnits: bigint;
}

export function assertFundedTestnetTransportReadiness(
  environment: Pick<DebtShiftEnvironment, 'SOURCE_CHAIN_ID' | 'DESTINATION_CHAIN_ID'>,
  readiness: FundedTestnetTransportReadiness,
): void {
  if (
    readiness.sourceChainId !== environment.SOURCE_CHAIN_ID ||
    readiness.destinationChainId !== environment.DESTINATION_CHAIN_ID
  ) {
    throw new Error('Testnet transport RPC chain IDs do not match runtime configuration.');
  }
  if (!readiness.sourceTokenCodePresent || !readiness.destinationTokenCodePresent) {
    throw new Error('Testnet transport collateral token deployment is missing.');
  }
  if (readiness.sourceNativeBalanceWei === 0n || readiness.destinationNativeBalanceWei === 0n) {
    throw new Error('Testnet transport executor requires native gas on both chains.');
  }
  if (
    readiness.sourceCollateralBalanceUnits === 0n ||
    readiness.destinationCollateralBalanceUnits === 0n
  ) {
    throw new Error('Testnet transport executor requires pre-funded collateral on both chains.');
  }
}

function chain(id: number, rpcUrl: string): Chain {
  return defineChain({
    id,
    name: `DebtShift testnet ${id}`,
    nativeCurrency: { name: 'Test gas token', symbol: 'TEST', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}
