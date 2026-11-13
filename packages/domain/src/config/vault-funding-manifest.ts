import { z } from 'zod';

import {
  baseUnitAmountSchema,
  bytes32Schema,
  canonicalTextSchema,
  chainIdSchema,
  evmAddressSchema,
  isoTimestampSchema,
  positiveBaseUnitAmountSchema,
  uint64StringSchema,
} from '../primitives.js';

const sourceCommitSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/, 'Expected a full lowercase Git commit.');

const fundingTransactionSchema = z
  .object({
    transactionHash: bytes32Schema,
    transactionInputHash: bytes32Schema,
    sender: evmAddressSchema,
    target: evmAddressSchema,
    nonce: uint64StringSchema,
    blockNumber: uint64StringSchema,
    blockHash: bytes32Schema,
    gasUsed: positiveBaseUnitAmountSchema,
  })
  .strict();

const fundingStateSchema = z
  .object({
    blockNumber: uint64StringSchema,
    blockHash: bytes32Schema,
    funderBalanceUnits: baseUnitAmountSchema,
    vaultBalanceUnits: baseUnitAmountSchema,
    vaultFreeLiquidityUnits: baseUnitAmountSchema,
    vaultAllowanceUnits: baseUnitAmountSchema,
    reservedUndrawnUnits: baseUnitAmountSchema,
    lockedRecoveryReserveUnits: baseUnitAmountSchema,
  })
  .strict();

export const testnetVaultFundingManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    environment: z.literal('testnet'),
    createdAt: isoTimestampSchema,
    sourceCommit: sourceCommitSchema,
    routeId: canonicalTextSchema,
    routeConfigurationHash: bytes32Schema,
    routeDependenciesHash: bytes32Schema,
    evmDeploymentManifestHash: bytes32Schema,
    workflowWriteSwitchEnabled: z.literal(false),
    chainId: chainIdSchema,
    confirmations: z.number().int().positive().max(1_000),
    funder: evmAddressSchema,
    vault: evmAddressSchema,
    asset: evmAddressSchema,
    amountUnits: positiveBaseUnitAmountSchema,
    before: fundingStateSchema,
    transactions: z
      .object({
        approveExact: fundingTransactionSchema.extend({
          action: z.literal('APPROVE_EXACT_VAULT_FUNDING'),
        }),
        deposit: fundingTransactionSchema.extend({
          action: z.literal('DEPOSIT_EXACT_VAULT_FUNDING'),
        }),
        revokeAllowance: fundingTransactionSchema.extend({
          action: z.literal('REVOKE_VAULT_ALLOWANCE'),
        }),
      })
      .strict(),
    after: fundingStateSchema,
  })
  .strict()
  .superRefine((manifest, context) => {
    if (
      manifest.before.vaultAllowanceUnits !== '0' ||
      manifest.before.reservedUndrawnUnits !== '0' ||
      manifest.before.lockedRecoveryReserveUnits !== '0' ||
      manifest.after.vaultAllowanceUnits !== '0' ||
      manifest.after.reservedUndrawnUnits !== '0' ||
      manifest.after.lockedRecoveryReserveUnits !== '0'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Vault funding requires zero allowances and no active or recovery reservations.',
        path: ['after'],
      });
    }

    const amount = BigInt(manifest.amountUnits);
    const exactDeltas =
      BigInt(manifest.before.funderBalanceUnits) - BigInt(manifest.after.funderBalanceUnits) ===
        amount &&
      BigInt(manifest.after.vaultBalanceUnits) - BigInt(manifest.before.vaultBalanceUnits) ===
        amount &&
      BigInt(manifest.after.vaultFreeLiquidityUnits) -
        BigInt(manifest.before.vaultFreeLiquidityUnits) ===
        amount;
    if (!exactDeltas) {
      context.addIssue({
        code: 'custom',
        message:
          'Vault funding manifest does not prove exact funder, vault, and free-liquidity deltas.',
        path: ['after'],
      });
    }

    const transactions = [
      manifest.transactions.approveExact,
      manifest.transactions.deposit,
      manifest.transactions.revokeAllowance,
    ];
    if (new Set(transactions.map(({ transactionHash }) => transactionHash)).size !== 3) {
      context.addIssue({
        code: 'custom',
        message: 'Vault funding transaction hashes must be unique.',
        path: ['transactions'],
      });
    }
    for (const transaction of transactions) {
      if (transaction.sender !== manifest.funder) {
        context.addIssue({
          code: 'custom',
          message: 'Every vault funding transaction must be sent by the manifested funder.',
          path: ['transactions'],
        });
        break;
      }
    }
    if (
      manifest.transactions.approveExact.target !== manifest.asset ||
      manifest.transactions.revokeAllowance.target !== manifest.asset ||
      manifest.transactions.deposit.target !== manifest.vault
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Vault funding transaction targets do not match the manifested asset and vault.',
        path: ['transactions'],
      });
    }
    const approvalBlock = BigInt(manifest.transactions.approveExact.blockNumber);
    const depositBlock = BigInt(manifest.transactions.deposit.blockNumber);
    const revokeBlock = BigInt(manifest.transactions.revokeAllowance.blockNumber);
    if (
      BigInt(manifest.before.blockNumber) > approvalBlock ||
      approvalBlock > depositBlock ||
      depositBlock > revokeBlock ||
      revokeBlock > BigInt(manifest.after.blockNumber)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Vault funding blocks must be monotonically ordered.',
        path: ['transactions'],
      });
    }
  });

export type TestnetVaultFundingManifest = z.infer<typeof testnetVaultFundingManifestSchema>;

export function parseTestnetVaultFundingManifest(
  input: string,
): Readonly<TestnetVaultFundingManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error('Testnet vault funding manifest must contain valid JSON.');
  }
  return Object.freeze(testnetVaultFundingManifestSchema.parse(parsed));
}
