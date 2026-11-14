import {
  getMorphoAuthorizationTypedData,
  hashCanonicalText,
  parseLiveMarketConfiguration,
  persistedSourceLendingAuthorizationSchema,
  persistedTargetLendingAuthorizationSchema,
  preparedSourceLendingAuthorizationSchema,
  preparedTargetLendingAuthorizationSchema,
  signedTargetLendingAuthorizationSchema,
  submittedSourceLendingAuthorizationSchema,
  type ExecutionPlan,
  type LiveMarketConfiguration,
  type PersistedTargetLendingAuthorization,
  type PersistedSourceLendingAuthorization,
  type PositionSnapshot,
  type PreparedTargetLendingAuthorization,
  type PreparedSourceLendingAuthorization,
  type SignedTargetLendingAuthorization,
  type SubmittedSourceLendingAuthorization,
  type TokenReference,
} from '@debtshift/domain';
import {
  AaveV3ReadAdapter,
  buildAaveCollateralClaimAuthorization,
  buildMorphoAuthorizationPair,
  encodeMorphoAuthorizationPair,
  ERC20_METADATA_ABI,
  MORPHO_BLUE_READ_ABI,
  readAaveReserveTokenAddresses,
} from '@debtshift/protocols';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createPublicClient,
  getAddress,
  http,
  isAddressEqual,
  verifyTypedData,
  type Address,
  type PublicClient,
} from 'viem';

import type { DebtShiftRouteDefinition, ProtocolDataPort } from '../market-data/ports.js';

@Injectable()
export class LiveProtocolService implements ProtocolDataPort {
  readonly provider = 'LIVE_READ_ONLY' as const;
  readonly #client: PublicClient;
  readonly #destinationClient: PublicClient;
  readonly #adapter: AaveV3ReadAdapter;
  readonly #configuration: Readonly<LiveMarketConfiguration>;
  readonly #route: DebtShiftRouteDefinition;
  readonly #destinationChainId: number;
  readonly #targetModule: Address;
  readonly #sourceModule: Address;
  readonly #sourceChainId: number;
  readonly #sourceFinalityConfirmations: number;
  readonly #sourceDebtBufferBps: number;

  constructor(@Inject(ConfigService) config: ConfigService) {
    if (config.getOrThrow<string>('MARKET_DATA_PROVIDER') !== 'LIVE_READ_ONLY') {
      throw new Error('Live protocol data requires MARKET_DATA_PROVIDER=LIVE_READ_ONLY.');
    }
    this.#configuration = parseLiveMarketConfiguration(
      config.getOrThrow<string>('LIVE_MARKET_CONFIG_JSON'),
    );
    const sourceChainId = config.getOrThrow<number>('SOURCE_CHAIN_ID');
    const destinationChainId = config.getOrThrow<number>('DESTINATION_CHAIN_ID');
    this.#destinationChainId = destinationChainId;
    this.#targetModule = config.getOrThrow<Address>('DESTINATION_LENDING_ADDRESS');
    this.#sourceModule = config.getOrThrow<Address>('SOURCE_LENDING_ADDRESS');
    this.#sourceChainId = sourceChainId;
    this.#sourceFinalityConfirmations = config.getOrThrow<number>('SOURCE_FINALITY_CONFIRMATIONS');
    this.#sourceDebtBufferBps = config.get<number>('SOURCE_DEBT_BUFFER_BPS') ?? 10;
    const mode = config.getOrThrow<'testnet' | 'mainnet-readonly' | 'mainnet'>('DEBTSHIFT_MODE');
    this.#client = createPublicClient({
      transport: http(config.getOrThrow<string>('SOURCE_RPC_URL')),
    });
    this.#destinationClient = createPublicClient({
      transport: http(config.getOrThrow<string>('DESTINATION_RPC_URL')),
    });
    const sourceCollateralAsset = token(sourceChainId, this.#configuration.source.collateralAsset);
    const sourceDebtAsset = token(sourceChainId, this.#configuration.source.debtAsset);
    const destinationCollateralAsset = token(
      destinationChainId,
      this.#configuration.destination.collateralAsset,
    );
    const destinationDebtAsset = token(
      destinationChainId,
      this.#configuration.destination.debtAsset,
    );
    this.#adapter = new AaveV3ReadAdapter(this.#client, {
      chainId: sourceChainId,
      pool: this.#configuration.source.pool,
      dataProvider: this.#configuration.source.dataProvider,
      collateralAsset: sourceCollateralAsset,
      debtAsset: sourceDebtAsset,
    });
    this.#route = {
      sourceMarket: {
        chainId: sourceChainId,
        protocol: 'AAVE_V3',
        deployment: getAddress(this.#configuration.source.pool),
        marketId: hashCanonicalText(
          `debtshift.aave-v3-market.v1:${sourceChainId}:${this.#configuration.source.pool.toLowerCase()}`,
        ),
      },
      targetMarket: {
        chainId: destinationChainId,
        protocol: 'MORPHO_BLUE',
        deployment: getAddress(this.#configuration.destination.morpho),
        marketId: this.#configuration.destination.marketId,
      },
      sourceDebtAsset,
      sourceCollateralAsset,
      destinationDebtAsset,
      destinationCollateralAsset,
      execution:
        mode === 'mainnet-readonly'
          ? { kind: 'READ_ONLY' }
          : {
              kind: 'EXECUTABLE',
              mode,
              destinationEscrow: config.getOrThrow<Address>('DESTINATION_ESCROW_ADDRESS'),
              sourceEscrow: config.getOrThrow<Address>('SOURCE_ESCROW_ADDRESS'),
              sourceVault: config.getOrThrow<Address>('SOURCE_VAULT_ADDRESS'),
              executor: config.getOrThrow<Address>('EXECUTOR_ADDRESS'),
            },
    };
  }

  get route(): DebtShiftRouteDefinition {
    return this.#route;
  }

  get configuration(): Readonly<LiveMarketConfiguration> {
    return this.#configuration;
  }

  get sourceClient(): PublicClient {
    return this.#client;
  }

  async getSourcePosition(borrowerInput: string): Promise<PositionSnapshot> {
    const position = await this.#adapter.readPosition(getAddress(borrowerInput));
    if (position === undefined) {
      throw new Error('No supported Aave V3 source position was found for this wallet.');
    }
    return position;
  }

  async verifySourceSnapshot(snapshot: PositionSnapshot): Promise<void> {
    if (snapshot.position.market.protocol !== 'AAVE_V3') {
      throw new Error('Live source verification accepts only Aave V3 snapshots.');
    }
    const blockNumber = BigInt(snapshot.block.number);
    const canonicalBlock = await this.#client.getBlock({ blockNumber });
    if (canonicalBlock.hash?.toLowerCase() !== snapshot.block.hash.toLowerCase()) {
      throw new Error('Aave source snapshot block is no longer canonical.');
    }
    const historical = await this.#adapter.readPosition(snapshot.position.borrower, blockNumber);
    if (historical === undefined || historical.snapshotId !== snapshot.snapshotId) {
      throw new Error('Aave source snapshot does not match its referenced block state.');
    }
    const current = await this.#adapter.readPosition(snapshot.position.borrower);
    if (
      current === undefined ||
      current.position.market.marketId !== snapshot.position.market.marketId ||
      !isWithinAaveAccrualBounds({
        snapshotCollateralUnits: BigInt(snapshot.collateralUnits),
        snapshotDebtUnits: BigInt(snapshot.debtUnits),
        currentCollateralUnits: BigInt(current.collateralUnits),
        currentDebtUnits: BigInt(current.debtUnits),
        debtBufferBps: this.#sourceDebtBufferBps,
      })
    ) {
      throw new Error('Aave source position changed after route preparation.');
    }
  }

  async prepareSourceAuthorization(
    plan: ExecutionPlan,
  ): Promise<PreparedSourceLendingAuthorization> {
    if (
      plan.sourceMarket.protocol !== 'AAVE_V3' ||
      plan.sourceMarket.chainId !== this.#sourceChainId
    ) {
      throw new Error('Source authorization is available only for the configured Aave route.');
    }
    const reserveTokens = await readAaveReserveTokenAddresses(
      this.#client,
      this.#configuration.source.dataProvider,
      this.#configuration.source.collateralAsset.address,
    );
    const transaction = buildAaveCollateralClaimAuthorization(
      reserveTokens.aToken,
      this.#sourceModule,
      BigInt(plan.sourceCollateralMinUnits),
    );
    return preparedSourceLendingAuthorizationSchema.parse({
      kind: 'ERC20_APPROVAL',
      chainId: this.#sourceChainId,
      token: reserveTokens.aToken,
      spender: this.#sourceModule,
      amountUnits: plan.sourceCollateralMinUnits,
      transaction: {
        to: transaction.to,
        data: transaction.data,
        valueUnits: transaction.value.toString(),
      },
    });
  }

  async verifySourceAuthorization(
    input: SubmittedSourceLendingAuthorization,
    plan: ExecutionPlan,
  ): Promise<PersistedSourceLendingAuthorization> {
    const authorization = submittedSourceLendingAuthorizationSchema.parse(input);
    if (authorization.kind !== 'ERC20_APPROVAL') {
      throw new Error('The production Aave source requires an exact aToken approval.');
    }
    const expected = await this.prepareSourceAuthorization(plan);
    if (
      expected.kind !== 'ERC20_APPROVAL' ||
      authorization.chainId !== expected.chainId ||
      !isAddressEqual(authorization.token, expected.token) ||
      !isAddressEqual(authorization.spender, expected.spender) ||
      authorization.amountUnits !== expected.amountUnits ||
      !isAddressEqual(authorization.transaction.to, expected.transaction.to) ||
      authorization.transaction.data.toLowerCase() !== expected.transaction.data.toLowerCase() ||
      authorization.transaction.valueUnits !== '0'
    ) {
      throw new Error('Aave source approval does not match the signed execution plan.');
    }
    const receipt = await this.#client.waitForTransactionReceipt({
      hash: authorization.transactionHash,
      confirmations: this.#sourceFinalityConfirmations,
    });
    if (receipt.status !== 'success') throw new Error('Aave source approval transaction reverted.');
    const transaction = await this.#client.getTransaction({ hash: authorization.transactionHash });
    if (
      !isAddressEqual(transaction.from, plan.borrower) ||
      transaction.to === null ||
      !isAddressEqual(transaction.to, expected.token) ||
      transaction.input.toLowerCase() !== expected.transaction.data.toLowerCase() ||
      transaction.value !== 0n
    ) {
      throw new Error('Aave approval receipt is not the borrower-authorized exact transaction.');
    }
    const [allowance, canonicalBlock] = await Promise.all([
      this.#client.readContract({
        address: expected.token,
        abi: ERC20_METADATA_ABI,
        functionName: 'allowance',
        args: [plan.borrower, expected.spender],
      }),
      this.#client.getBlock({ blockNumber: receipt.blockNumber }),
    ]);
    if (allowance !== BigInt(expected.amountUnits)) {
      throw new Error('Aave collateral claim allowance is not the exact signed amount.');
    }
    if (canonicalBlock.hash?.toLowerCase() !== receipt.blockHash.toLowerCase()) {
      throw new Error('Aave source approval receipt is no longer canonical.');
    }
    return persistedSourceLendingAuthorizationSchema.parse({
      kind: 'ERC20_APPROVAL',
      authorization,
      blockNumber: receipt.blockNumber.toString(),
      blockHash: receipt.blockHash,
    });
  }

  async prepareTargetAuthorization(
    borrowerInput: Address,
    deadline: bigint,
  ): Promise<PreparedTargetLendingAuthorization> {
    const borrower = getAddress(borrowerInput);
    const morpho = getAddress(this.#configuration.destination.morpho);
    const [nonce, alreadyAuthorized] = await Promise.all([
      this.#destinationClient.readContract({
        address: morpho,
        abi: MORPHO_BLUE_READ_ABI,
        functionName: 'nonce',
        args: [borrower],
      }),
      this.#destinationClient.readContract({
        address: morpho,
        abi: MORPHO_BLUE_READ_ABI,
        functionName: 'isAuthorized',
        args: [borrower, this.#targetModule],
      }),
    ]);
    if (alreadyAuthorized) {
      throw new Error('The DebtShift Morpho module is already authorized by this borrower.');
    }
    const pair = buildMorphoAuthorizationPair(borrower, this.#targetModule, nonce, deadline);
    return preparedTargetLendingAuthorizationSchema.parse({
      kind: 'MORPHO_BLUE',
      chainId: this.#destinationChainId,
      morpho,
      module: this.#targetModule,
      enable: serializeMorphoAuthorization(pair.enable),
      disable: serializeMorphoAuthorization(pair.disable),
    });
  }

  async verifyTargetAuthorization(
    input: SignedTargetLendingAuthorization,
    borrowerInput: Address,
    planDeadline: bigint,
  ): Promise<PersistedTargetLendingAuthorization> {
    const authorization = signedTargetLendingAuthorizationSchema.parse(input);
    if (authorization.kind !== 'MORPHO_BLUE') {
      throw new Error(
        'The production Morpho target requires an enable/disable authorization pair.',
      );
    }
    const borrower = getAddress(borrowerInput);
    const expectedMorpho = getAddress(this.#configuration.destination.morpho);
    if (
      authorization.chainId !== this.#destinationChainId ||
      !isAddressEqual(authorization.morpho, expectedMorpho) ||
      !isAddressEqual(authorization.module, this.#targetModule) ||
      !isAddressEqual(authorization.enable.authorizer, borrower) ||
      BigInt(authorization.enable.deadline) !== planDeadline ||
      BigInt(authorization.enable.deadline) <= BigInt(Math.floor(Date.now() / 1_000))
    ) {
      throw new Error(
        'Morpho authorization does not match the borrower, module, chain, or deadline.',
      );
    }
    const prepared = preparedTargetLendingAuthorizationSchema.parse({
      kind: authorization.kind,
      chainId: authorization.chainId,
      morpho: authorization.morpho,
      module: authorization.module,
      enable: authorization.enable,
      disable: authorization.disable,
    });
    if (prepared.kind !== 'MORPHO_BLUE') throw new Error('Morpho authorization invariant failed.');
    const [currentNonce, alreadyAuthorized, enableValid, disableValid] = await Promise.all([
      this.#destinationClient.readContract({
        address: expectedMorpho,
        abi: MORPHO_BLUE_READ_ABI,
        functionName: 'nonce',
        args: [borrower],
      }),
      this.#destinationClient.readContract({
        address: expectedMorpho,
        abi: MORPHO_BLUE_READ_ABI,
        functionName: 'isAuthorized',
        args: [borrower, this.#targetModule],
      }),
      verifyTypedData({
        address: borrower,
        ...getMorphoAuthorizationTypedData(prepared, 'enable'),
        signature: authorization.enableSignature,
      }),
      verifyTypedData({
        address: borrower,
        ...getMorphoAuthorizationTypedData(prepared, 'disable'),
        signature: authorization.disableSignature,
      }),
    ]);
    if (
      alreadyAuthorized ||
      currentNonce !== BigInt(authorization.enable.nonce) ||
      !enableValid ||
      !disableValid
    ) {
      throw new Error('Morpho authorization signatures or current nonce are invalid.');
    }
    const pair = buildMorphoAuthorizationPair(
      borrower,
      this.#targetModule,
      currentNonce,
      BigInt(authorization.enable.deadline),
    );
    return persistedTargetLendingAuthorizationSchema.parse({
      authorization,
      encodedAuthorization: encodeMorphoAuthorizationPair(
        pair,
        authorization.enableSignature,
        authorization.disableSignature,
      ),
    });
  }
}

function serializeMorphoAuthorization(authorization: {
  readonly authorizer: Address;
  readonly authorized: Address;
  readonly isAuthorized: boolean;
  readonly nonce: bigint;
  readonly deadline: bigint;
}) {
  return {
    ...authorization,
    nonce: authorization.nonce.toString(),
    deadline: authorization.deadline.toString(),
  };
}

export function isWithinAaveAccrualBounds(input: {
  readonly snapshotCollateralUnits: bigint;
  readonly snapshotDebtUnits: bigint;
  readonly currentCollateralUnits: bigint;
  readonly currentDebtUnits: bigint;
  readonly debtBufferBps: number;
}): boolean {
  const maximumDebtUnits =
    (input.snapshotDebtUnits * BigInt(10_000 + input.debtBufferBps) + 9_999n) / 10_000n;
  return (
    input.currentCollateralUnits >= input.snapshotCollateralUnits &&
    input.currentDebtUnits >= input.snapshotDebtUnits &&
    input.currentDebtUnits <= maximumDebtUnits
  );
}

function token(
  chainId: number,
  configuration: {
    readonly address: Address;
    readonly decimals: number;
    readonly symbol: string;
    readonly providerAssetId?: string | undefined;
  },
): TokenReference & { readonly symbol: string } {
  return {
    chainId,
    address: getAddress(configuration.address),
    decimals: configuration.decimals,
    symbol: configuration.symbol,
    ...(configuration.providerAssetId === undefined
      ? {}
      : { providerAssetId: configuration.providerAssetId }),
  };
}
