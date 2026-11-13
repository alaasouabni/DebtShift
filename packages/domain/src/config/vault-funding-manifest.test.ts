import { describe, expect, it } from 'vitest';

import { parseTestnetVaultFundingManifest } from './vault-funding-manifest.js';

describe('testnet vault funding manifest', () => {
  it('accepts exact funding deltas, zero allowance, and three canonical transactions', () => {
    const parsed = parseTestnetVaultFundingManifest(JSON.stringify(validManifest()));

    expect(parsed.amountUnits).toBe('1000');
    expect(parsed.after.vaultFreeLiquidityUnits).toBe('1100');
    expect(parsed.workflowWriteSwitchEnabled).toBe(false);
  });

  it('rejects balance drift, residual allowance, identity drift, and duplicate receipts', () => {
    const balanceDrift = validManifest();
    balanceDrift.after.vaultBalanceUnits = '1099';
    expect(() => parseTestnetVaultFundingManifest(JSON.stringify(balanceDrift))).toThrow(
      'exact funder, vault, and free-liquidity deltas',
    );

    const residualAllowance = validManifest();
    residualAllowance.after.vaultAllowanceUnits = '1';
    expect(() => parseTestnetVaultFundingManifest(JSON.stringify(residualAllowance))).toThrow(
      'zero allowances',
    );

    const wrongSender = validManifest();
    wrongSender.transactions.deposit.sender = '0x1000000000000000000000000000000000000002';
    expect(() => parseTestnetVaultFundingManifest(JSON.stringify(wrongSender))).toThrow(
      'manifested funder',
    );

    const duplicate = validManifest();
    duplicate.transactions.deposit.transactionHash =
      duplicate.transactions.approveExact.transactionHash;
    expect(() => parseTestnetVaultFundingManifest(JSON.stringify(duplicate))).toThrow(
      'hashes must be unique',
    );
  });
});

function validManifest() {
  const funder = '0x1000000000000000000000000000000000000001';
  const asset = '0x2000000000000000000000000000000000000001';
  const vault = '0x3000000000000000000000000000000000000001';
  const transaction = (
    action:
      'APPROVE_EXACT_VAULT_FUNDING' | 'DEPOSIT_EXACT_VAULT_FUNDING' | 'REVOKE_VAULT_ALLOWANCE',
    seed: string,
    target: string,
    blockNumber: string,
  ) => ({
    action,
    transactionHash: `0x${seed.repeat(64)}`,
    transactionInputHash: `0x${seed.repeat(64)}`,
    sender: funder,
    target,
    nonce: blockNumber,
    blockNumber,
    blockHash: `0x${seed.repeat(64)}`,
    gasUsed: '50000',
  });
  return {
    schemaVersion: 1,
    environment: 'testnet',
    createdAt: '2026-11-13T18:00:00.000Z',
    sourceCommit: '1'.repeat(40),
    routeId: 'ethereum-sepolia-aave-to-base-sepolia-morpho-v1',
    routeConfigurationHash: `0x${'2'.repeat(64)}`,
    routeDependenciesHash: `0x${'3'.repeat(64)}`,
    evmDeploymentManifestHash: `0x${'4'.repeat(64)}`,
    workflowWriteSwitchEnabled: false,
    chainId: 11_155_111,
    confirmations: 2,
    funder,
    vault,
    asset,
    amountUnits: '1000',
    before: {
      blockNumber: '100',
      blockHash: `0x${'5'.repeat(64)}`,
      funderBalanceUnits: '2000',
      vaultBalanceUnits: '100',
      vaultFreeLiquidityUnits: '100',
      vaultAllowanceUnits: '0',
      reservedUndrawnUnits: '0',
      lockedRecoveryReserveUnits: '0',
    },
    transactions: {
      approveExact: transaction('APPROVE_EXACT_VAULT_FUNDING', '6', asset, '101'),
      deposit: transaction('DEPOSIT_EXACT_VAULT_FUNDING', '7', vault, '102'),
      revokeAllowance: transaction('REVOKE_VAULT_ALLOWANCE', '8', asset, '103'),
    },
    after: {
      blockNumber: '103',
      blockHash: `0x${'8'.repeat(64)}`,
      funderBalanceUnits: '1000',
      vaultBalanceUnits: '1100',
      vaultFreeLiquidityUnits: '1100',
      vaultAllowanceUnits: '0',
      reservedUndrawnUnits: '0',
      lockedRecoveryReserveUnits: '0',
    },
  };
}
