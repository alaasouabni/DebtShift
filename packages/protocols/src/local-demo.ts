import {
  createWalletClient,
  hashTypedData,
  http,
  keccak256,
  stringToHex,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { executionPlanTypes } from '@debtshift/domain';

import { loadFoundryArtifact } from './artifacts.js';
import { startAnvil } from './local-chain.js';
import {
  DEFAULT_ANVIL_DEPLOYER_KEY,
  DEFAULT_ANVIL_BORROWER_KEY,
  deployLocalDebtShift,
  LOCAL_INTENT_HASH,
  LOCAL_MIGRATION_ID,
  LOCAL_PLAN_NONCE,
  LOCAL_TRANSPORT_QUOTE_HASH,
  write,
} from './local-deployment.js';

export type LocalDemoOutcome = 'happy' | 'refund';

export interface LocalDemoResult {
  readonly outcome: LocalDemoOutcome;
  readonly migrationId: Hex;
  readonly sourceChainId: number;
  readonly destinationChainId: number;
  readonly borrower: Address;
  readonly sourcePosition: readonly [bigint, bigint];
  readonly destinationPosition: readonly [bigint, bigint];
  readonly vaultReceivableUnits: bigint;
  readonly borrowerRefundUnits: bigint;
  readonly deployment: Awaited<ReturnType<typeof deployLocalDebtShift>>;
}

export async function runLocalDemo(outcome: LocalDemoOutcome): Promise<LocalDemoResult> {
  const anvilPath = process.env.ANVIL_PATH;
  const sourceChain = await startAnvil({
    chainId: 31_337,
    port: 18_545,
    ...(anvilPath === undefined ? {} : { anvilPath }),
  });
  const destinationChain = await startAnvil({
    chainId: 31_338,
    port: 18_546,
    ...(anvilPath === undefined ? {} : { anvilPath }),
  });

  try {
    const deployment = await deployLocalDebtShift(
      sourceChain.chain,
      sourceChain.publicClient,
      destinationChain.chain,
      destinationChain.publicClient,
    );
    const account = privateKeyToAccount(DEFAULT_ANVIL_DEPLOYER_KEY);
    const borrowerAccount = privateKeyToAccount(DEFAULT_ANVIL_BORROWER_KEY);
    const sourceWallet = createWalletClient({
      account,
      chain: sourceChain.chain,
      transport: http(sourceChain.rpcUrl),
    });
    const destinationWallet = createWalletClient({
      account,
      chain: destinationChain.chain,
      transport: http(destinationChain.rpcUrl),
    });
    const sourceBorrowerWallet = createWalletClient({
      account: borrowerAccount,
      chain: sourceChain.chain,
      transport: http(sourceChain.rpcUrl),
    });
    const [token, sourceLending, targetLending, vault, escrow, sourceAdapter, destinationAdapter] =
      await Promise.all([
        loadFoundryArtifact('TestToken'),
        loadFoundryArtifact('MockSourceLending'),
        loadFoundryArtifact('MockTargetLending'),
        loadFoundryArtifact('TestLiquidityVault'),
        loadFoundryArtifact('MigrationEscrow'),
        loadFoundryArtifact('SourceAdapter'),
        loadFoundryArtifact('DestinationAdapter'),
      ]);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3_600);
    const plan = {
      intentHash: LOCAL_INTENT_HASH,
      migrationId: LOCAL_MIGRATION_ID,
      borrower: deployment.borrower,
      sourcePositionId: keccak256(stringToHex('debtshift.local.source-position.v1')),
      routeHash: keccak256(stringToHex('debtshift.local.route.v1')),
      transportQuoteHash: LOCAL_TRANSPORT_QUOTE_HASH,
      sourceRepaymentMax: 10_000_000_000n,
      sourceCollateralMin: 10n * 10n ** 18n,
      targetDebtMax: 10_100_000_000n,
      minDestinationCollateral: 9_800_000_000_000_000_000n,
      principalMax: 10_000_000_000n,
      feeMax: 50_000_000n,
      destinationReceiver: deployment.destination.escrow,
      refundReceiver: deployment.borrower,
      payoutReceiver: deployment.deployer,
      deadline,
      nonce: LOCAL_PLAN_NONCE,
    } as const;
    const typedPlan = {
      domain: {
        name: 'DebtShift',
        version: '1',
        chainId: sourceChain.chain.id,
        verifyingContract: deployment.source.adapter,
      },
      primaryType: 'ExecutionPlan',
      types: executionPlanTypes,
      message: plan,
    } as const;
    const signature = await sourceBorrowerWallet.signTypedData({
      account: borrowerAccount,
      ...typedPlan,
    });
    const actualPlanHash = hashTypedData(typedPlan);

    await write(
      sourceWallet,
      sourceChain.publicClient,
      vault.abi,
      deployment.source.vault,
      'recordFeasibility',
      [
        LOCAL_MIGRATION_ID,
        {
          planHash: actualPlanHash,
          analysisHash: keccak256(stringToHex('debtshift.local.feasibility.v1')),
          externalFundingEvidenceHash: `0x${'00'.repeat(32)}`,
          liquidityAsset: deployment.source.debtToken,
          solverPrincipalUnits: 10_000_000_000n,
          solverFeeUnits: 50_000_000n,
          capitalizedCostUnits: 0n,
          totalRequiredUnits: 10_050_000_000n,
          confirmedExternalFundingUnits: 0n,
          maximumSafeBorrowingCapacityUnits: 10_050_000_000n,
          requiredDestinationBorrowUnits: 10_050_000_000n,
          fundingShortfallUnits: 0n,
          sequence: 1n,
          evaluatedAt: BigInt(Math.floor(Date.now() / 1000)),
          validUntil: deadline,
        },
      ],
    );
    const feasibilityHash = await readHex(
      sourceChain.publicClient,
      vault.abi,
      deployment.source.vault,
      'latestFeasibilityHash',
      [LOCAL_MIGRATION_ID],
    );

    await write(
      sourceWallet,
      sourceChain.publicClient,
      vault.abi,
      deployment.source.vault,
      'reserve',
      [
        LOCAL_MIGRATION_ID,
        deployment.source.debtToken,
        deployment.source.adapter,
        actualPlanHash,
        feasibilityHash,
        10_000_000_000n,
        50_000_000n,
        deadline,
      ],
    );
    await write(
      sourceWallet,
      sourceChain.publicClient,
      sourceAdapter.abi,
      deployment.source.adapter,
      'closeSource',
      [plan, signature],
    );

    let borrowerRefundUnits = 0n;
    if (outcome === 'refund') {
      await write(
        sourceWallet,
        sourceChain.publicClient,
        escrow.abi,
        deployment.source.escrow,
        'release',
        [
          LOCAL_MIGRATION_ID,
          deployment.source.collateralToken,
          deployment.borrower,
          10n * 10n ** 18n,
        ],
      );
      borrowerRefundUnits = await readBigInt(
        sourceChain.publicClient,
        token.abi,
        deployment.source.collateralToken,
        'balanceOf',
        [deployment.borrower],
      );
    } else {
      await write(
        sourceWallet,
        sourceChain.publicClient,
        escrow.abi,
        deployment.source.escrow,
        'release',
        [
          LOCAL_MIGRATION_ID,
          deployment.source.collateralToken,
          deployment.deployer,
          10n * 10n ** 18n,
        ],
      );
      const deliveredCollateral = 9_900_000_000_000_000_000n;
      await write(
        destinationWallet,
        destinationChain.publicClient,
        token.abi,
        deployment.destination.collateralToken,
        'mint',
        [deployment.deployer, deliveredCollateral],
      );
      await write(
        destinationWallet,
        destinationChain.publicClient,
        token.abi,
        deployment.destination.collateralToken,
        'approve',
        [deployment.destination.escrow, deliveredCollateral],
      );
      await write(
        destinationWallet,
        destinationChain.publicClient,
        escrow.abi,
        deployment.destination.escrow,
        'assign',
        [
          LOCAL_MIGRATION_ID,
          deployment.destination.collateralToken,
          deployment.deployer,
          deliveredCollateral,
        ],
      );
      await write(
        destinationWallet,
        destinationChain.publicClient,
        destinationAdapter.abi,
        deployment.destination.adapter,
        'openDestination',
        [
          {
            migrationId: LOCAL_MIGRATION_ID,
            borrower: deployment.borrower,
            payoutReceiver: deployment.deployer,
            collateralUnits: deliveredCollateral,
            minimumCollateralUnits: 9_800_000_000_000_000_000n,
            borrowUnits: 10_050_000_000n,
            maximumDebtUnits: 10_100_000_000n,
            deadline,
          },
        ],
      );

      await write(
        sourceWallet,
        sourceChain.publicClient,
        token.abi,
        deployment.source.debtToken,
        'mint',
        [deployment.deployer, 10_050_000_000n],
      );
      await write(
        sourceWallet,
        sourceChain.publicClient,
        token.abi,
        deployment.source.debtToken,
        'approve',
        [deployment.source.vault, 10_050_000_000n],
      );
      await write(
        sourceWallet,
        sourceChain.publicClient,
        vault.abi,
        deployment.source.vault,
        'settle',
        [LOCAL_MIGRATION_ID, deployment.deployer, 50_000_000n],
      );
    }

    const sourcePosition = await readPosition(
      sourceChain.publicClient,
      sourceLending.abi,
      deployment.source.lending,
      deployment.borrower,
    );
    const destinationPosition = await readPosition(
      destinationChain.publicClient,
      targetLending.abi,
      deployment.destination.lending,
      deployment.borrower,
    );
    const vaultReceivableUnits = await readBigInt(
      sourceChain.publicClient,
      vault.abi,
      deployment.source.vault,
      'principalReceivable',
      [deployment.source.debtToken],
    );
    assertTerminalState(outcome, sourcePosition, destinationPosition, vaultReceivableUnits);

    return {
      outcome,
      migrationId: LOCAL_MIGRATION_ID,
      sourceChainId: sourceChain.chain.id,
      destinationChainId: destinationChain.chain.id,
      borrower: deployment.borrower,
      sourcePosition,
      destinationPosition,
      vaultReceivableUnits,
      borrowerRefundUnits,
      deployment,
    };
  } finally {
    await Promise.all([sourceChain.stop(), destinationChain.stop()]);
  }
}

async function readPosition(
  client: PublicClient,
  abi: Abi,
  address: Address,
  borrower: Address,
): Promise<readonly [bigint, bigint]> {
  const result = await client.readContract({
    address,
    abi,
    functionName: 'positions',
    args: [borrower],
  });
  if (
    !Array.isArray(result) ||
    result.length !== 2 ||
    typeof result[0] !== 'bigint' ||
    typeof result[1] !== 'bigint'
  ) {
    throw new Error('Unexpected position response.');
  }
  return [result[0], result[1]];
}

async function readBigInt(
  client: PublicClient,
  abi: Abi,
  address: Address,
  functionName: string,
  args: readonly unknown[],
): Promise<bigint> {
  const result = await client.readContract({ address, abi, functionName, args });
  if (typeof result !== 'bigint') throw new Error(`Unexpected ${functionName} response.`);
  return result;
}

async function readHex(
  client: PublicClient,
  abi: Abi,
  address: Address,
  functionName: string,
  args: readonly unknown[],
): Promise<Hex> {
  const result = await client.readContract({ address, abi, functionName, args });
  if (typeof result !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(result)) {
    throw new Error(`Unexpected ${functionName} response.`);
  }
  return result as Hex;
}

function assertTerminalState(
  outcome: LocalDemoOutcome,
  sourcePosition: readonly [bigint, bigint],
  destinationPosition: readonly [bigint, bigint],
  vaultReceivableUnits: bigint,
): void {
  if (sourcePosition[0] !== 0n || sourcePosition[1] !== 0n) {
    throw new Error('Source position was not closed.');
  }
  if (outcome === 'happy') {
    if (
      destinationPosition[0] !== 9_900_000_000_000_000_000n ||
      destinationPosition[1] !== 10_050_000_000n ||
      vaultReceivableUnits !== 0n
    ) {
      throw new Error('Happy-path terminal balances do not reconcile.');
    }
  } else if (
    destinationPosition[0] !== 0n ||
    destinationPosition[1] !== 0n ||
    vaultReceivableUnits !== 10_000_000_000n
  ) {
    throw new Error('Refund-path residual obligation was not preserved.');
  }
}

async function main(): Promise<void> {
  const requested = process.argv[2] ?? 'happy';
  if (requested !== 'happy' && requested !== 'refund') {
    throw new Error('Usage: local-demo.js [happy|refund]');
  }
  const result = await runLocalDemo(requested);
  process.stdout.write(
    `${JSON.stringify(result, (_, value: unknown) =>
      typeof value === 'bigint' ? value.toString() : value,
    )}\n`,
  );
}

const isEntryPoint = process.argv[1]?.endsWith('local-demo.js') ?? false;
if (isEntryPoint) {
  await main();
}
