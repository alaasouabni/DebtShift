import {
  hashCanonicalText,
  persistedSourceLendingAuthorizationSchema,
  persistedTargetLendingAuthorizationSchema,
  positionSnapshotSchema,
  signedTargetLendingAuthorizationSchema,
  type ExecutionPlan,
  type PersistedSourceLendingAuthorization,
  type PersistedTargetLendingAuthorization,
  type PositionSnapshot,
  type PreparedSourceLendingAuthorization,
  type PreparedTargetLendingAuthorization,
  type SubmittedSourceLendingAuthorization,
  type SignedTargetLendingAuthorization,
} from '@debtshift/domain';
import { loadFoundryArtifact } from '@debtshift/protocols';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPublicClient, getAddress, http, type Address, type PublicClient } from 'viem';

import type { DebtShiftRouteDefinition, ProtocolDataPort } from '../market-data/ports.js';

export type LocalRouteDefinition = DebtShiftRouteDefinition;

@Injectable()
export class LocalProtocolService implements ProtocolDataPort {
  readonly provider = 'SIMULATOR' as const;
  readonly #client: PublicClient;
  readonly #sourceLending: Address;
  readonly #environment: string;
  readonly #route: LocalRouteDefinition;
  readonly #sourceLendingArtifact = loadFoundryArtifact('MockSourceLending');

  constructor(@Inject(ConfigService) config: ConfigService) {
    this.#environment = config.getOrThrow<string>('DEBTSHIFT_MODE');
    const sourceChainId = config.getOrThrow<number>('SOURCE_CHAIN_ID');
    const destinationChainId = config.getOrThrow<number>('DESTINATION_CHAIN_ID');
    this.#sourceLending = config.getOrThrow<Address>('SOURCE_LENDING_ADDRESS');
    this.#client = createPublicClient({
      transport: http(config.getOrThrow<string>('SOURCE_RPC_URL')),
    });
    this.#route = {
      sourceMarket: {
        chainId: sourceChainId,
        protocol: 'LOCAL_AAVE_MOCK',
        deployment: this.#sourceLending,
        marketId: hashCanonicalText('debtshift.local.source-market.v1'),
      },
      targetMarket: {
        chainId: destinationChainId,
        protocol: 'LOCAL_MORPHO_MOCK',
        deployment: config.getOrThrow<Address>('DESTINATION_LENDING_ADDRESS'),
        marketId: hashCanonicalText('debtshift.local.destination-market.v1'),
      },
      sourceDebtAsset: {
        chainId: sourceChainId,
        address: config.getOrThrow<Address>('SOURCE_DEBT_TOKEN_ADDRESS'),
        decimals: 6,
        symbol: 'sUSDC',
      },
      sourceCollateralAsset: {
        chainId: sourceChainId,
        address: config.getOrThrow<Address>('SOURCE_COLLATERAL_TOKEN_ADDRESS'),
        decimals: 18,
        symbol: 'sWETH',
      },
      destinationDebtAsset: {
        chainId: destinationChainId,
        address: config.getOrThrow<Address>('DESTINATION_DEBT_TOKEN_ADDRESS'),
        decimals: 6,
        symbol: 'dUSDC',
      },
      destinationCollateralAsset: {
        chainId: destinationChainId,
        address: config.getOrThrow<Address>('DESTINATION_COLLATERAL_TOKEN_ADDRESS'),
        decimals: 18,
        symbol: 'dWETH',
      },
      execution: {
        kind: 'EXECUTABLE',
        mode: 'sandbox',
        destinationEscrow: config.getOrThrow<Address>('DESTINATION_ESCROW_ADDRESS'),
        sourceEscrow: config.getOrThrow<Address>('SOURCE_ESCROW_ADDRESS'),
        sourceVault: config.getOrThrow<Address>('SOURCE_VAULT_ADDRESS'),
        executor: config.getOrThrow<Address>('EXECUTOR_ADDRESS'),
      },
    };
  }

  get route(): LocalRouteDefinition {
    this.#assertSimulatorEnvironment();
    return this.#route;
  }

  async getSourcePosition(borrowerInput: string): Promise<PositionSnapshot> {
    this.#assertSimulatorEnvironment();
    const borrower = getAddress(borrowerInput);
    const block = await this.#client.getBlock({ blockTag: 'latest' });
    if (block.hash === null) throw new Error('The latest source block is not canonical.');
    const [collateralUnits, debtUnits] = await this.#readPosition(borrower, block.number);
    if (collateralUnits === 0n || debtUnits === 0n) {
      throw new Error('No supported local source position was found for this wallet.');
    }
    const observedAt = new Date(Number(block.timestamp) * 1000).toISOString();
    return positionSnapshotSchema.parse({
      snapshotId: hashCanonicalText(
        [
          'debtshift.position-snapshot.v1',
          this.#route.sourceMarket.chainId,
          borrower,
          block.hash,
          collateralUnits,
          debtUnits,
        ].join(':'),
      ),
      position: {
        market: this.#route.sourceMarket,
        borrower,
        collateralAsset: this.#route.sourceCollateralAsset,
        debtAsset: this.#route.sourceDebtAsset,
      },
      collateralUnits: collateralUnits.toString(),
      debtUnits: debtUnits.toString(),
      health: { kind: 'AAVE_HEALTH_FACTOR', healthFactorWad: '1500000000000000000' },
      borrowAprBps: 700,
      block: {
        number: block.number.toString(),
        hash: block.hash,
        observedAt,
      },
    });
  }

  async verifySourceSnapshot(snapshot: PositionSnapshot): Promise<void> {
    this.#assertSimulatorEnvironment();
    const blockNumber = BigInt(snapshot.block.number);
    const canonicalBlock = await this.#client.getBlock({ blockNumber });
    if (canonicalBlock.hash?.toLowerCase() !== snapshot.block.hash.toLowerCase()) {
      throw new Error('Source snapshot block is no longer canonical.');
    }
    const historical = await this.#readPosition(snapshot.position.borrower, blockNumber);
    if (
      historical[0] !== BigInt(snapshot.collateralUnits) ||
      historical[1] !== BigInt(snapshot.debtUnits)
    ) {
      throw new Error('Source snapshot does not match the referenced block state.');
    }
    const current = await this.#readPosition(snapshot.position.borrower);
    if (current[0] !== historical[0] || current[1] !== historical[1]) {
      throw new Error('Source position changed after route preparation.');
    }
  }

  async prepareSourceAuthorization(
    _plan: ExecutionPlan,
  ): Promise<PreparedSourceLendingAuthorization> {
    this.#assertSimulatorEnvironment();
    return { kind: 'NONE' };
  }

  async verifySourceAuthorization(
    input: SubmittedSourceLendingAuthorization,
    _plan: ExecutionPlan,
  ): Promise<PersistedSourceLendingAuthorization> {
    this.#assertSimulatorEnvironment();
    if (input.kind !== 'NONE') {
      throw new Error('The sandbox source adapter does not accept an ERC-20 claim approval.');
    }
    return persistedSourceLendingAuthorizationSchema.parse({
      kind: 'NONE',
      authorization: input,
    });
  }

  async prepareTargetAuthorization(): Promise<PreparedTargetLendingAuthorization> {
    this.#assertSimulatorEnvironment();
    return { kind: 'NONE' };
  }

  async verifyTargetAuthorization(
    input: SignedTargetLendingAuthorization,
  ): Promise<PersistedTargetLendingAuthorization> {
    this.#assertSimulatorEnvironment();
    const authorization = signedTargetLendingAuthorizationSchema.parse(input);
    if (authorization.kind !== 'NONE') {
      throw new Error('The sandbox target adapter does not accept a Morpho authorization pair.');
    }
    return persistedTargetLendingAuthorizationSchema.parse({
      authorization,
      encodedAuthorization: '0x',
    });
  }

  async #readPosition(borrower: Address, blockNumber?: bigint): Promise<readonly [bigint, bigint]> {
    const artifact = await this.#sourceLendingArtifact;
    const result = await this.#client.readContract({
      address: this.#sourceLending,
      abi: artifact.abi,
      functionName: 'positions',
      args: [borrower],
      ...(blockNumber === undefined ? {} : { blockNumber }),
    });
    if (
      !Array.isArray(result) ||
      result.length !== 2 ||
      typeof result[0] !== 'bigint' ||
      typeof result[1] !== 'bigint'
    ) {
      throw new Error('Unexpected local source position response.');
    }
    return [result[0], result[1]];
  }

  #assertSimulatorEnvironment(): void {
    if (this.#environment !== 'sandbox') {
      throw new Error('Contract sandbox routes are disabled outside sandbox mode.');
    }
  }
}
