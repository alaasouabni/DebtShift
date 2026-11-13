import { z } from 'zod';

import { bytes32Schema, canonicalTextSchema, evmAddressSchema } from '../primitives.js';

const unsignedIntegerTextSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);

export const deployedContractRecordSchema = z
  .object({
    artifact: canonicalTextSchema,
    address: evmAddressSchema,
    deploymentTransactionHash: bytes32Schema,
    deploymentBlockNumber: unsignedIntegerTextSchema,
    deploymentBlockHash: bytes32Schema,
    runtimeCodeHash: bytes32Schema,
  })
  .strict();

export const configurationTransactionRecordSchema = z
  .object({
    action: canonicalTextSchema,
    transactionHash: bytes32Schema,
    blockNumber: unsignedIntegerTextSchema,
    blockHash: bytes32Schema,
  })
  .strict();

const sourceDeploymentSchema = z
  .object({
    chainId: z.number().int().positive(),
    deploymentBlockNumber: unsignedIntegerTextSchema,
    protocol: z
      .object({
        kind: z.literal('AAVE_V3'),
        pool: evmAddressSchema,
        dataProvider: evmAddressSchema,
        aToken: evmAddressSchema,
        variableDebtToken: evmAddressSchema,
      })
      .strict(),
    collateralToken: evmAddressSchema,
    debtToken: evmAddressSchema,
    contracts: z
      .object({
        liquidityVault: deployedContractRecordSchema,
        migrationEscrow: deployedContractRecordSchema,
        sourceLending: deployedContractRecordSchema,
        sourceAdapter: deployedContractRecordSchema,
      })
      .strict(),
    configurationTransactions: z.array(configurationTransactionRecordSchema).min(1),
  })
  .strict();

const destinationDeploymentSchema = z
  .object({
    chainId: z.number().int().positive(),
    deploymentBlockNumber: unsignedIntegerTextSchema,
    protocol: z
      .object({
        kind: z.literal('MORPHO_BLUE'),
        morpho: evmAddressSchema,
        marketId: bytes32Schema,
        oracle: evmAddressSchema,
        irm: evmAddressSchema,
        lltv: unsignedIntegerTextSchema,
      })
      .strict(),
    collateralToken: evmAddressSchema,
    debtToken: evmAddressSchema,
    contracts: z
      .object({
        migrationEscrow: deployedContractRecordSchema,
        targetLending: deployedContractRecordSchema,
        destinationAdapter: deployedContractRecordSchema,
      })
      .strict(),
    configurationTransactions: z.array(configurationTransactionRecordSchema).min(1),
  })
  .strict();

export const debtShiftEvmDeploymentManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    environment: z.enum(['testnet', 'mainnet']),
    routeId: canonicalTextSchema,
    routeConfigurationHash: bytes32Schema,
    createdAt: z.iso.datetime(),
    owner: evmAddressSchema,
    executor: evmAddressSchema,
    workflowWriteSwitchEnabled: z.literal(false),
    source: sourceDeploymentSchema,
    destination: destinationDeploymentSchema,
  })
  .strict()
  .superRefine((manifest, context) => {
    if (manifest.source.chainId === manifest.destination.chainId) {
      context.addIssue({
        code: 'custom',
        message: 'Source and destination deployment chains must differ.',
        path: ['destination', 'chainId'],
      });
    }
    if (manifest.source.debtToken === manifest.source.collateralToken) {
      context.addIssue({
        code: 'custom',
        message: 'Source debt and collateral tokens must differ.',
        path: ['source'],
      });
    }
    if (manifest.destination.debtToken === manifest.destination.collateralToken) {
      context.addIssue({
        code: 'custom',
        message: 'Destination debt and collateral tokens must differ.',
        path: ['destination'],
      });
    }
  });

export type DebtShiftEvmDeploymentManifest = z.infer<typeof debtShiftEvmDeploymentManifestSchema>;

export function parseDebtShiftEvmDeploymentManifest(
  input: string,
): Readonly<DebtShiftEvmDeploymentManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error('DebtShift EVM deployment manifest must contain valid JSON.');
  }
  return Object.freeze(debtShiftEvmDeploymentManifestSchema.parse(parsed));
}
