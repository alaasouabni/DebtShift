import type { TestnetVaultFundingManifest } from '@debtshift/domain';
import {
  encodeFunctionData,
  getAddress,
  isAddressEqual,
  keccak256,
  type Address,
  type Chain,
  type Hex,
  type PrivateKeyAccount,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';

type FundingWallet = WalletClient<Transport, Chain, PrivateKeyAccount>;
type FundingAction =
  'APPROVE_EXACT_VAULT_FUNDING' | 'DEPOSIT_EXACT_VAULT_FUNDING' | 'REVOKE_VAULT_ALLOWANCE';

interface FundingState {
  readonly blockNumber: string;
  readonly blockHash: Hex;
  readonly funderBalanceUnits: string;
  readonly vaultBalanceUnits: string;
  readonly vaultFreeLiquidityUnits: string;
  readonly vaultAllowanceUnits: string;
  readonly reservedUndrawnUnits: string;
  readonly lockedRecoveryReserveUnits: string;
}

interface FundingTransaction<Action extends FundingAction = FundingAction> {
  readonly action: Action;
  readonly transactionHash: Hex;
  readonly transactionInputHash: Hex;
  readonly sender: Address;
  readonly target: Address;
  readonly nonce: string;
  readonly blockNumber: string;
  readonly blockHash: Hex;
  readonly gasUsed: string;
}

interface FundingTransactions {
  readonly approveExact: FundingTransaction<'APPROVE_EXACT_VAULT_FUNDING'>;
  readonly deposit: FundingTransaction<'DEPOSIT_EXACT_VAULT_FUNDING'>;
  readonly revokeAllowance: FundingTransaction<'REVOKE_VAULT_ALLOWANCE'>;
}

export const VAULT_FUNDING_TOKEN_ABI = [
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
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: 'balance', type: 'uint256' }],
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

export const LIQUIDITY_VAULT_FUNDING_ABI = [
  {
    type: 'function',
    name: 'assets',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [{ name: 'allowed', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'asset', type: 'address' },
      { name: 'amountUnits', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'freeLiquidity',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [{ name: 'units', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'reservedUndrawn',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [{ name: 'units', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'lockedRecoveryReserves',
    stateMutability: 'view',
    inputs: [{ name: 'asset', type: 'address' }],
    outputs: [{ name: 'units', type: 'uint256' }],
  },
] as const;

export interface TestnetVaultFundingInput {
  readonly publicClient: PublicClient;
  readonly wallet: FundingWallet;
  readonly chainId: number;
  readonly confirmations: number;
  readonly vault: Address;
  readonly asset: Address;
  readonly amountUnits: bigint;
}

export interface TestnetVaultFundingEvidence {
  readonly before: FundingState;
  readonly transactions: FundingTransactions;
  readonly after: FundingState;
}

export interface TestnetVaultFundingVerificationReport {
  readonly verifiedAt: string;
  readonly chainId: number;
  readonly finalizedBlockNumber: string;
  readonly amountUnits: string;
  readonly fundedVaultBalanceUnits: string;
  readonly fundedVaultFreeLiquidityUnits: string;
  readonly currentVaultAllowanceUnits: string;
  readonly verifiedTransactionCount: 3;
  readonly workflowWriteSwitchEnabled: false;
}

export async function fundTestnetLiquidityVault(
  input: TestnetVaultFundingInput,
): Promise<Readonly<TestnetVaultFundingEvidence>> {
  assertFundingInput(input);
  const vault = getAddress(input.vault);
  const asset = getAddress(input.asset);
  const funder = input.wallet.account.address;
  const [actualChainId, vaultCode, assetCode, allowedAsset, beforeBlock] = await Promise.all([
    input.publicClient.getChainId(),
    input.publicClient.getCode({ address: vault }),
    input.publicClient.getCode({ address: asset }),
    input.publicClient.readContract({
      address: vault,
      abi: LIQUIDITY_VAULT_FUNDING_ABI,
      functionName: 'assets',
      args: [asset],
    }),
    input.publicClient.getBlock({ blockTag: 'latest' }),
  ]);
  if (actualChainId !== input.chainId) {
    throw new Error(`Vault funding RPC chain mismatch: ${actualChainId}.`);
  }
  if (
    vaultCode === undefined ||
    vaultCode === '0x' ||
    assetCode === undefined ||
    assetCode === '0x' ||
    !allowedAsset ||
    beforeBlock.hash === null
  ) {
    throw new Error('Vault funding contracts, asset allowlist, or canonical block are not ready.');
  }
  const before = await readFundingState(
    input.publicClient,
    funder,
    vault,
    asset,
    beforeBlock.number,
    beforeBlock.hash,
  );
  if (
    before.vaultAllowanceUnits !== '0' ||
    before.reservedUndrawnUnits !== '0' ||
    before.lockedRecoveryReserveUnits !== '0'
  ) {
    throw new Error('Vault funding requires zero prior allowance and no active reservations.');
  }
  if (BigInt(before.funderBalanceUnits) < input.amountUnits) {
    throw new Error('Vault funder balance is below the exact funding amount.');
  }

  try {
    const approveExact = await writeFundingTransaction(
      input,
      asset,
      VAULT_FUNDING_TOKEN_ABI,
      'approve',
      [vault, input.amountUnits],
      'APPROVE_EXACT_VAULT_FUNDING',
    );
    const approvedAllowance = await readAllowance(
      input.publicClient,
      asset,
      funder,
      vault,
      BigInt(approveExact.blockNumber),
    );
    if (approvedAllowance !== input.amountUnits) {
      throw new Error('Exact vault funding allowance was not established.');
    }

    const deposit = await writeFundingTransaction(
      input,
      vault,
      LIQUIDITY_VAULT_FUNDING_ABI,
      'deposit',
      [asset, input.amountUnits],
      'DEPOSIT_EXACT_VAULT_FUNDING',
    );
    const depositedState = await readFundingStateAtTransaction(
      input.publicClient,
      funder,
      vault,
      asset,
      deposit,
    );
    assertExactFundingDelta(before, depositedState, input.amountUnits);

    const revokeAllowance = await writeFundingTransaction(
      input,
      asset,
      VAULT_FUNDING_TOKEN_ABI,
      'approve',
      [vault, 0n],
      'REVOKE_VAULT_ALLOWANCE',
    );
    const after = await readFundingStateAtTransaction(
      input.publicClient,
      funder,
      vault,
      asset,
      revokeAllowance,
    );
    assertExactFundingDelta(before, after, input.amountUnits);
    if (
      after.vaultAllowanceUnits !== '0' ||
      after.reservedUndrawnUnits !== '0' ||
      after.lockedRecoveryReserveUnits !== '0'
    ) {
      throw new Error('Vault funding did not finish with zero allowance and reservations.');
    }

    return Object.freeze({
      before,
      transactions: Object.freeze({ approveExact, deposit, revokeAllowance }),
      after,
    });
  } catch (error) {
    return clearAllowanceAfterFundingFailure(input, asset, vault, funder, error);
  }
}

export async function verifyTestnetLiquidityVaultFunding(input: {
  readonly manifest: Readonly<TestnetVaultFundingManifest>;
  readonly publicClient: PublicClient;
}): Promise<Readonly<TestnetVaultFundingVerificationReport>> {
  const { manifest, publicClient } = input;
  const vault = getAddress(manifest.vault);
  const asset = getAddress(manifest.asset);
  const funder = getAddress(manifest.funder);
  const [chainId, finalizedBlock, allowedAsset] = await Promise.all([
    publicClient.getChainId(),
    publicClient.getBlock({ blockTag: 'finalized' }),
    publicClient.readContract({
      address: vault,
      abi: LIQUIDITY_VAULT_FUNDING_ABI,
      functionName: 'assets',
      args: [asset],
    }),
  ]);
  if (chainId !== manifest.chainId || finalizedBlock.hash === null || !allowedAsset) {
    throw new Error('Vault funding verification chain, finality, or asset allowlist mismatch.');
  }
  if (finalizedBlock.number < BigInt(manifest.after.blockNumber)) {
    throw new Error('Vault funding transactions are not finalized yet.');
  }

  const expectedInputs = {
    approveExact: encodeFunctionData({
      abi: VAULT_FUNDING_TOKEN_ABI,
      functionName: 'approve',
      args: [vault, BigInt(manifest.amountUnits)],
    }),
    deposit: encodeFunctionData({
      abi: LIQUIDITY_VAULT_FUNDING_ABI,
      functionName: 'deposit',
      args: [asset, BigInt(manifest.amountUnits)],
    }),
    revokeAllowance: encodeFunctionData({
      abi: VAULT_FUNDING_TOKEN_ABI,
      functionName: 'approve',
      args: [vault, 0n],
    }),
  };
  await Promise.all([
    verifyFundingTransaction(
      publicClient,
      manifest.transactions.approveExact,
      funder,
      asset,
      expectedInputs.approveExact,
    ),
    verifyFundingTransaction(
      publicClient,
      manifest.transactions.deposit,
      funder,
      vault,
      expectedInputs.deposit,
    ),
    verifyFundingTransaction(
      publicClient,
      manifest.transactions.revokeAllowance,
      funder,
      asset,
      expectedInputs.revokeAllowance,
    ),
  ]);
  const [beforeBlock, afterBlock] = await Promise.all([
    publicClient.getBlock({ blockNumber: BigInt(manifest.before.blockNumber) }),
    publicClient.getBlock({ blockNumber: BigInt(manifest.after.blockNumber) }),
  ]);
  if (
    beforeBlock.hash?.toLowerCase() !== manifest.before.blockHash.toLowerCase() ||
    afterBlock.hash?.toLowerCase() !== manifest.after.blockHash.toLowerCase()
  ) {
    throw new Error('Vault funding observation block is no longer canonical.');
  }
  const [historicalBefore, historicalAfter, currentAllowance] = await Promise.all([
    readFundingState(
      publicClient,
      funder,
      vault,
      asset,
      BigInt(manifest.before.blockNumber),
      manifest.before.blockHash,
    ),
    readFundingState(
      publicClient,
      funder,
      vault,
      asset,
      BigInt(manifest.after.blockNumber),
      manifest.after.blockHash,
    ),
    readAllowance(publicClient, asset, funder, vault, finalizedBlock.number),
  ]);
  if (
    JSON.stringify(historicalBefore) !== JSON.stringify(manifest.before) ||
    JSON.stringify(historicalAfter) !== JSON.stringify(manifest.after)
  ) {
    throw new Error('Historical vault funding balances do not match the manifest.');
  }
  if (currentAllowance !== 0n) throw new Error('Vault funder has a residual current allowance.');

  return Object.freeze({
    verifiedAt: new Date().toISOString(),
    chainId: manifest.chainId,
    finalizedBlockNumber: finalizedBlock.number.toString(),
    amountUnits: manifest.amountUnits,
    fundedVaultBalanceUnits: manifest.after.vaultBalanceUnits,
    fundedVaultFreeLiquidityUnits: manifest.after.vaultFreeLiquidityUnits,
    currentVaultAllowanceUnits: currentAllowance.toString(),
    verifiedTransactionCount: 3,
    workflowWriteSwitchEnabled: false,
  });
}

async function readFundingStateAtTransaction(
  client: PublicClient,
  funder: Address,
  vault: Address,
  asset: Address,
  transaction: FundingTransaction,
): Promise<FundingState> {
  return readFundingState(
    client,
    funder,
    vault,
    asset,
    BigInt(transaction.blockNumber),
    transaction.blockHash,
  );
}

async function readFundingState(
  client: PublicClient,
  funder: Address,
  vault: Address,
  asset: Address,
  blockNumber: bigint,
  blockHash: Hex,
): Promise<FundingState> {
  const [funderBalance, vaultBalance, freeLiquidity, allowance, reserved, recovery] =
    await Promise.all([
      client.readContract({
        address: asset,
        abi: VAULT_FUNDING_TOKEN_ABI,
        functionName: 'balanceOf',
        args: [funder],
        blockNumber,
      }),
      client.readContract({
        address: asset,
        abi: VAULT_FUNDING_TOKEN_ABI,
        functionName: 'balanceOf',
        args: [vault],
        blockNumber,
      }),
      client.readContract({
        address: vault,
        abi: LIQUIDITY_VAULT_FUNDING_ABI,
        functionName: 'freeLiquidity',
        args: [asset],
        blockNumber,
      }),
      readAllowance(client, asset, funder, vault, blockNumber),
      client.readContract({
        address: vault,
        abi: LIQUIDITY_VAULT_FUNDING_ABI,
        functionName: 'reservedUndrawn',
        args: [asset],
        blockNumber,
      }),
      client.readContract({
        address: vault,
        abi: LIQUIDITY_VAULT_FUNDING_ABI,
        functionName: 'lockedRecoveryReserves',
        args: [asset],
        blockNumber,
      }),
    ]);
  return Object.freeze({
    blockNumber: blockNumber.toString(),
    blockHash,
    funderBalanceUnits: funderBalance.toString(),
    vaultBalanceUnits: vaultBalance.toString(),
    vaultFreeLiquidityUnits: freeLiquidity.toString(),
    vaultAllowanceUnits: allowance.toString(),
    reservedUndrawnUnits: reserved.toString(),
    lockedRecoveryReserveUnits: recovery.toString(),
  });
}

function readAllowance(
  client: PublicClient,
  asset: Address,
  funder: Address,
  vault: Address,
  blockNumber: bigint,
) {
  return client.readContract({
    address: asset,
    abi: VAULT_FUNDING_TOKEN_ABI,
    functionName: 'allowance',
    args: [funder, vault],
    blockNumber,
  });
}

async function clearAllowanceAfterFundingFailure(
  input: TestnetVaultFundingInput,
  asset: Address,
  vault: Address,
  funder: Address,
  fundingError: unknown,
): Promise<never> {
  try {
    const latestBlock = await input.publicClient.getBlockNumber();
    const allowance = await readAllowance(input.publicClient, asset, funder, vault, latestBlock);
    if (allowance !== 0n) {
      const cleanup = await writeFundingTransaction(
        input,
        asset,
        VAULT_FUNDING_TOKEN_ABI,
        'approve',
        [vault, 0n],
        'REVOKE_VAULT_ALLOWANCE',
      );
      const cleanedAllowance = await readAllowance(
        input.publicClient,
        asset,
        funder,
        vault,
        BigInt(cleanup.blockNumber),
      );
      if (cleanedAllowance !== 0n) {
        throw new Error('Emergency vault allowance cleanup did not reach zero.');
      }
      throw new Error('Vault funding failed; emergency allowance cleanup succeeded.', {
        cause: fundingError,
      });
    }
  } catch (cleanupError) {
    if (
      cleanupError instanceof Error &&
      cleanupError.message === 'Vault funding failed; emergency allowance cleanup succeeded.'
    ) {
      throw cleanupError;
    }
    throw new AggregateError(
      [fundingError, cleanupError],
      'Vault funding failed and the allowance cleanup could not be proven. Stop and reconcile the funder allowance before retrying.',
      { cause: cleanupError },
    );
  }
  throw fundingError;
}

async function writeFundingTransaction<Action extends FundingAction>(
  input: TestnetVaultFundingInput,
  target: Address,
  abi: typeof VAULT_FUNDING_TOKEN_ABI | typeof LIQUIDITY_VAULT_FUNDING_ABI,
  functionName: 'approve' | 'deposit',
  args: readonly [Address, bigint],
  action: Action,
): Promise<FundingTransaction<Action>> {
  const simulation = await input.publicClient.simulateContract({
    account: input.wallet.account,
    address: target,
    abi,
    functionName,
    args,
  });
  const hash = await input.wallet.writeContract(simulation.request);
  const receipt = await input.publicClient.waitForTransactionReceipt({
    hash,
    confirmations: input.confirmations,
  });
  if (receipt.status !== 'success') throw new Error(`${action} reverted: ${hash}.`);
  const [transaction, canonicalBlock] = await Promise.all([
    input.publicClient.getTransaction({ hash }),
    input.publicClient.getBlock({ blockNumber: receipt.blockNumber }),
  ]);
  if (
    canonicalBlock.hash?.toLowerCase() !== receipt.blockHash.toLowerCase() ||
    !isAddressEqual(transaction.from, input.wallet.account.address) ||
    transaction.to === null ||
    !isAddressEqual(transaction.to, target)
  ) {
    throw new Error(`${action} receipt or transaction identity mismatch.`);
  }
  return Object.freeze({
    action,
    transactionHash: hash,
    transactionInputHash: keccak256(transaction.input),
    sender: getAddress(transaction.from),
    target: getAddress(transaction.to),
    nonce: transaction.nonce.toString(),
    blockNumber: receipt.blockNumber.toString(),
    blockHash: receipt.blockHash,
    gasUsed: receipt.gasUsed.toString(),
  });
}

async function verifyFundingTransaction(
  client: PublicClient,
  record: FundingTransaction,
  expectedSender: Address,
  expectedTarget: Address,
  expectedInput: Hex,
): Promise<void> {
  const [transaction, receipt] = await Promise.all([
    client.getTransaction({ hash: record.transactionHash }),
    client.getTransactionReceipt({ hash: record.transactionHash }),
  ]);
  const canonicalBlock = await client.getBlock({ blockNumber: receipt.blockNumber });
  if (
    receipt.status !== 'success' ||
    receipt.blockNumber.toString() !== record.blockNumber ||
    receipt.blockHash.toLowerCase() !== record.blockHash.toLowerCase() ||
    canonicalBlock.hash?.toLowerCase() !== record.blockHash.toLowerCase() ||
    receipt.gasUsed.toString() !== record.gasUsed ||
    transaction.nonce.toString() !== record.nonce ||
    !isAddressEqual(transaction.from, expectedSender) ||
    transaction.to === null ||
    !isAddressEqual(transaction.to, expectedTarget) ||
    transaction.input.toLowerCase() !== expectedInput.toLowerCase() ||
    keccak256(transaction.input).toLowerCase() !== record.transactionInputHash.toLowerCase()
  ) {
    throw new Error(`Vault funding transaction evidence mismatch for ${record.action}.`);
  }
}

function assertExactFundingDelta(before: FundingState, after: FundingState, amount: bigint): void {
  if (
    BigInt(before.funderBalanceUnits) - BigInt(after.funderBalanceUnits) !== amount ||
    BigInt(after.vaultBalanceUnits) - BigInt(before.vaultBalanceUnits) !== amount ||
    BigInt(after.vaultFreeLiquidityUnits) - BigInt(before.vaultFreeLiquidityUnits) !== amount
  ) {
    throw new Error('Vault funding did not produce the exact required balance deltas.');
  }
}

function assertFundingInput(input: TestnetVaultFundingInput): void {
  if (input.wallet.account === undefined || input.amountUnits <= 0n) {
    throw new Error('Vault funding requires an account and positive amount.');
  }
  if (!Number.isInteger(input.confirmations) || input.confirmations < 1) {
    throw new Error('Vault funding confirmations must be a positive integer.');
  }
  if (isAddressEqual(input.vault, input.asset)) {
    throw new Error('Vault and funding asset addresses must differ.');
  }
}
