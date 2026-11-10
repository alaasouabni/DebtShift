import { spawnSync } from 'node:child_process';

import type { MigrationExecutionContext } from '@debtshift/database';
import { parseDebtShiftEnvironment } from '@debtshift/domain';
import {
  DeterministicTransportSimulator,
  transportQuoteRequestSchema,
  type TransportObservation,
} from '@debtshift/intents';
import {
  DEFAULT_ANVIL_DEPLOYER_KEY,
  deployLocalDebtShift,
  loadFoundryArtifact,
  resolveAnvilPath,
  startAnvil,
  type LocalAnvilChain,
  type LocalDebtShiftDeployment,
} from '@debtshift/protocols';
import type { Abi, Address } from 'viem';
import { describe, expect, it } from 'vitest';

import { DualAnvilSimulationExecutionPort } from './simulator/dual-anvil-execution.js';

const ANVIL_PATH = resolveAnvilPath();
const ANVIL_AVAILABLE = spawnSync(ANVIL_PATH, ['--version'], { windowsHide: true }).status === 0;
const BORROW_UNITS = 10_000_000_000n;
const FEE_UNITS = 50_000_000n;
const COLLATERAL_UNITS = 10n * 10n ** 18n;

describe.skipIf(!ANVIL_AVAILABLE)('dual-Anvil simulation execution port', () => {
  it('executes and reconciles the complete successful dual-chain workflow', async () => {
    await withDeployment(
      async ({ source, destination, deployment, execution, context, simulator }) => {
        const reservation = await execution.reserve(context);
        const replayedReservation = await execution.reserve(context);
        expect(replayedReservation.transactionHash).toBe(reservation.transactionHash);

        const sourceClose = await execution.closeSource(context);
        expect((await execution.closeSource(context)).transactionHash).toBe(
          sourceClose.transactionHash,
        );
        const dispatch = await execution.dispatchTransport(context);
        const replayedDispatch = await execution.dispatchTransport(context);
        expect(replayedDispatch.transactionHash).toBe(dispatch.transactionHash);

        await simulator.submitOrigin({
          quoteHash: context.quote.quoteHash as `0x${string}`,
          originTransactionHash: dispatch.transactionHash,
        });
        const observation = await simulator.getStatus(context.quote.quoteId);
        expect(observation.status).toBe('SUCCESS');
        const delivery = await execution.deliverDestination(context, observation);
        expect((await execution.deliverDestination(context, observation)).transactionHash).toBe(
          delivery.transactionHash,
        );
        const fundedContext = observedContext(context, observation);
        const targetOpen = await execution.openTarget(fundedContext);
        expect((await execution.openTarget(fundedContext)).transactionHash).toBe(
          targetOpen.transactionHash,
        );
        const settlement = await execution.settleLiquidity(fundedContext);
        expect((await execution.settleLiquidity(fundedContext)).transactionHash).toBe(
          settlement.transactionHash,
        );

        const sourcePosition = await readTuple(
          source,
          'MockSourceLending',
          deployment.source.lending,
          'positions',
          [deployment.borrower],
        );
        const destinationPosition = await readTuple(
          destination,
          'MockTargetLending',
          deployment.destination.lending,
          'positions',
          [deployment.borrower],
        );
        const receivable = await readBigInt(
          source,
          'TestLiquidityVault',
          deployment.source.vault,
          'principalReceivable',
          [deployment.source.debtToken],
        );

        expect(sourcePosition).toEqual([0n, 0n]);
        expect(destinationPosition).toEqual([9_900_000_000_000_000_000n, BORROW_UNITS + FEE_UNITS]);
        expect(receivable).toBe(0n);
      },
    );
  }, 60_000);

  it('returns all source collateral after a verified refund outcome', async () => {
    await withDeployment(
      async ({ source, destination, deployment, execution, context, simulator }) => {
        await execution.reserve(context);
        await execution.closeSource(context);
        const dispatch = await execution.dispatchTransport(context);
        await simulator.submitOrigin({
          quoteHash: context.quote.quoteHash as `0x${string}`,
          originTransactionHash: dispatch.transactionHash,
        });
        const observation = await simulator.getStatus(context.quote.quoteId);
        expect(observation.status).toBe('REFUNDED');
        const recovery = await execution.executeRecovery(context, 'TRANSPORT_REFUNDED');
        expect(
          (await execution.executeRecovery(context, 'TRANSPORT_REFUNDED')).transactionHash,
        ).toBe(recovery.transactionHash);

        const borrowerRefund = await readBigInt(
          source,
          'TestToken',
          deployment.source.collateralToken,
          'balanceOf',
          [deployment.borrower],
        );
        const destinationPosition = await readTuple(
          destination,
          'MockTargetLending',
          deployment.destination.lending,
          'positions',
          [deployment.borrower],
        );
        const receivable = await readBigInt(
          source,
          'TestLiquidityVault',
          deployment.source.vault,
          'principalReceivable',
          [deployment.source.debtToken],
        );

        expect(borrowerRefund).toBe(COLLATERAL_UNITS);
        expect(destinationPosition).toEqual([0n, 0n]);
        expect(receivable).toBe(BORROW_UNITS);
      },
      'REFUNDED',
    );
  }, 60_000);
});

interface DeploymentFixture {
  readonly source: LocalAnvilChain;
  readonly destination: LocalAnvilChain;
  readonly deployment: LocalDebtShiftDeployment;
  readonly execution: DualAnvilSimulationExecutionPort;
  readonly context: MigrationExecutionContext;
  readonly simulator: DeterministicTransportSimulator;
}

async function withDeployment(
  test: (fixture: DeploymentFixture) => Promise<void>,
  outcome: 'SUCCESS' | 'REFUNDED' = 'SUCCESS',
): Promise<void> {
  const source = await startAnvil({ chainId: 31_337, port: 19_545, anvilPath: ANVIL_PATH });
  const destination = await startAnvil({ chainId: 31_338, port: 19_546, anvilPath: ANVIL_PATH });
  try {
    const deployment = await deployLocalDebtShift(
      source.chain,
      source.publicClient,
      destination.chain,
      destination.publicClient,
    );
    const environment = parseDebtShiftEnvironment({
      DEBTSHIFT_ENV: 'local',
      SOURCE_RPC_URL: source.rpcUrl,
      DESTINATION_RPC_URL: destination.rpcUrl,
      LOCAL_EXECUTOR_PRIVATE_KEY: DEFAULT_ANVIL_DEPLOYER_KEY,
      SOURCE_DEBT_TOKEN_ADDRESS: deployment.source.debtToken,
      SOURCE_COLLATERAL_TOKEN_ADDRESS: deployment.source.collateralToken,
      SOURCE_VAULT_ADDRESS: deployment.source.vault,
      SOURCE_ESCROW_ADDRESS: deployment.source.escrow,
      SOURCE_ADAPTER_ADDRESS: deployment.source.adapter,
      DESTINATION_DEBT_TOKEN_ADDRESS: deployment.destination.debtToken,
      DESTINATION_COLLATERAL_TOKEN_ADDRESS: deployment.destination.collateralToken,
      DESTINATION_ESCROW_ADDRESS: deployment.destination.escrow,
      DESTINATION_ADAPTER_ADDRESS: deployment.destination.adapter,
    });
    const simulator = new DeterministicTransportSimulator({
      feeBps: 100,
      processingPolls: 0,
      outcome,
    });
    const context = await buildContext(deployment, simulator);
    await test({
      source,
      destination,
      deployment,
      execution: new DualAnvilSimulationExecutionPort(environment),
      context,
      simulator,
    });
  } finally {
    await Promise.all([source.stop(), destination.stop()]);
  }
}

async function buildContext(
  deployment: LocalDebtShiftDeployment,
  simulator: DeterministicTransportSimulator,
): Promise<MigrationExecutionContext> {
  const quote = await simulator.getQuote(
    transportQuoteRequestSchema.parse({
      inputAsset: {
        chainId: 31_337,
        address: deployment.source.collateralToken,
        decimals: 18,
        symbol: 'sWETH',
      },
      outputAsset: {
        chainId: 31_338,
        address: deployment.destination.collateralToken,
        decimals: 18,
        symbol: 'dWETH',
      },
      amountInUnits: COLLATERAL_UNITS.toString(),
      maxSlippageBps: 100,
      destinationReceiver: deployment.destination.escrow,
      refundReceiver: deployment.borrower,
    }),
  );
  const migrationId = `0x${'ab'.repeat(32)}` as const;
  const now = new Date();
  const deadline = Math.floor(Date.now() / 1000) + 3_600;
  return {
    migration: {
      migrationId,
      intentHash: `0x${'01'.repeat(32)}`,
      planHash: `0x${'02'.repeat(32)}`,
      quoteHash: quote.quoteHash,
      phase: 'AUTHORIZED',
      version: 0,
      expiresAt: new Date(quote.expiresAt),
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    },
    signedIntent: {
      intent: {
        safetyPolicy: {
          kind: 'MAX_LTV_BPS',
          maximumLtvBps: 7000,
          stressMaximumLtvBps: 6500,
        },
      },
    } as unknown as MigrationExecutionContext['signedIntent'],
    signedPlan: {
      plan: {
        migrationId,
        borrower: deployment.borrower,
        sourceMarket: {
          chainId: 31_337,
          deployment: deployment.source.lending,
        },
        targetMarket: {
          chainId: 31_338,
          deployment: deployment.destination.lending,
        },
        sourceDebtAsset: { address: deployment.source.debtToken },
        sourceCollateralAsset: { address: deployment.source.collateralToken },
        destinationDebtAsset: { address: deployment.destination.debtToken, decimals: 6 },
        destinationCollateralAsset: {
          address: deployment.destination.collateralToken,
          decimals: 18,
        },
        sourceRepaymentMaxUnits: BORROW_UNITS.toString(),
        sourceCollateralMinUnits: COLLATERAL_UNITS.toString(),
        minDestinationCollateralUnits: '9800000000000000000',
        targetDebtMaxUnits: '10100000000',
        principalMaxUnits: BORROW_UNITS.toString(),
        feeMaxUnits: FEE_UNITS.toString(),
        financing: {
          validUntil: deadline.toString(),
          capacityEvidenceHash: `0x${'cd'.repeat(32)}`,
          liquidityBufferBps: 1000,
          stressCollateralDropBps: 1000,
          fundingShortfallUnits: '0',
          confirmedExternalFundingUnits: '0',
          externalFunding: [],
          totalRequiredRepaymentAndFinancedCostUnits: (BORROW_UNITS + FEE_UNITS).toString(),
          signedBorrowCapacityUnits: '10100000000',
          requiredDestinationBorrowUnits: (BORROW_UNITS + FEE_UNITS).toString(),
        },
        destinationReceiver: deployment.destination.escrow,
        refundReceiver: deployment.borrower,
        fundingProvider: deployment.source.vault,
        payoutReceiver: deployment.deployer,
        deadline: deadline.toString(),
      },
    } as unknown as MigrationExecutionContext['signedPlan'],
    sourceSnapshot: {
      collateralUnits: COLLATERAL_UNITS.toString(),
      debtUnits: BORROW_UNITS.toString(),
    } as unknown as MigrationExecutionContext['sourceSnapshot'],
    quote,
    transportLeg: {
      migrationId,
      legIndex: 0,
      provider: 'DEBTSHIFT_SIMULATOR',
      quoteHash: quote.quoteHash,
      inputAsset: quote.inputAsset,
      outputAsset: quote.outputAsset,
      inputUnits: quote.amountInUnits,
      minimumOutputUnits: quote.minAmountOutUnits,
      observedOutputUnits: null,
      providerState: 'QUOTED',
      providerReference: quote.quoteId,
      depositAddress: quote.depositAddress ?? null,
      originTransactionHash: null,
      destinationTransactionHash: null,
      refundTransactionHash: null,
      observationCount: 0,
      createdAt: now,
      updatedAt: now,
    },
  };
}

function observedContext(
  context: MigrationExecutionContext,
  observation: TransportObservation,
): MigrationExecutionContext {
  return {
    ...context,
    transportLeg: {
      ...context.transportLeg,
      providerState: observation.status,
      observedOutputUnits: observation.observedAmountOutUnits,
      destinationTransactionHash: observation.destinationTransactionHash ?? null,
    },
  };
}

async function readBigInt(
  chain: LocalAnvilChain,
  contractName: string,
  address: Address,
  functionName: string,
  args: readonly unknown[],
): Promise<bigint> {
  const artifact = await loadFoundryArtifact(contractName);
  const result = await chain.publicClient.readContract({
    address,
    abi: artifact.abi,
    functionName,
    args,
  });
  if (typeof result !== 'bigint') throw new Error(`Unexpected ${functionName} result.`);
  return result;
}

async function readTuple(
  chain: LocalAnvilChain,
  contractName: string,
  address: Address,
  functionName: string,
  args: readonly unknown[],
): Promise<readonly [bigint, bigint]> {
  const artifact = await loadFoundryArtifact(contractName);
  const result = await read(chain.publicClient, artifact.abi, address, functionName, args);
  if (
    !Array.isArray(result) ||
    result.length !== 2 ||
    typeof result[0] !== 'bigint' ||
    typeof result[1] !== 'bigint'
  ) {
    throw new Error(`Unexpected ${functionName} tuple.`);
  }
  return [result[0], result[1]];
}

async function read(
  client: LocalAnvilChain['publicClient'],
  abi: Abi,
  address: Address,
  functionName: string,
  args: readonly unknown[],
): Promise<unknown> {
  return client.readContract({ address, abi, functionName, args });
}
