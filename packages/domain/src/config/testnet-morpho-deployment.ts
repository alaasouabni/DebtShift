import { z } from 'zod';

import { bytes32Schema, canonicalTextSchema, evmAddressSchema } from '../primitives.js';

const unsignedIntegerTextSchema = z.string().regex(/^(0|[1-9][0-9]*)$/);
const sourceCommitSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{40}$/)
  .transform((value) => value.toLowerCase());
const tokenOrFeedRecordSchema = z
  .object({
    address: evmAddressSchema,
    decimals: z.number().int().min(0).max(36),
    runtimeCodeHash: bytes32Schema,
  })
  .strict();

export const testnetMorphoContractRecordSchema = z
  .object({
    artifact: canonicalTextSchema,
    address: evmAddressSchema,
    artifactCreationCodeHash: bytes32Schema,
    deploymentTransactionHash: bytes32Schema,
    deploymentTransactionInputHash: bytes32Schema,
    deploymentBlockNumber: unsignedIntegerTextSchema,
    deploymentBlockHash: bytes32Schema,
    runtimeCodeHash: bytes32Schema,
  })
  .strict();

export const testnetMorphoTransactionRecordSchema = z
  .object({
    action: canonicalTextSchema,
    transactionHash: bytes32Schema,
    transactionInputHash: bytes32Schema,
    sender: evmAddressSchema,
    target: evmAddressSchema,
    blockNumber: unsignedIntegerTextSchema,
    blockHash: bytes32Schema,
  })
  .strict();

export const testnetMorphoDeploymentManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    environment: z.literal('testnet'),
    createdAt: z.iso.datetime(),
    sourceCommit: sourceCommitSchema,
    routeId: canonicalTextSchema,
    routeDependenciesHash: bytes32Schema,
    workflowWriteSwitchEnabled: z.literal(false),
    upstream: z
      .object({
        repository: z.literal('https://github.com/morpho-org/morpho-blue'),
        commit: sourceCommitSchema,
        sourceManifestHash: bytes32Schema,
        compilerVersion: z.literal('0.8.19'),
        evmVersion: z.literal('paris'),
        viaIr: z.literal(true),
        optimizerRuns: z.literal(999_999),
      })
      .strict(),
    chainId: z.number().int().positive(),
    deploymentBlockNumber: unsignedIntegerTextSchema,
    deployer: evmAddressSchema,
    owner: evmAddressSchema,
    contracts: z
      .object({
        morpho: testnetMorphoContractRecordSchema,
        irm: testnetMorphoContractRecordSchema,
        oracle: testnetMorphoContractRecordSchema,
      })
      .strict(),
    tokens: z
      .object({
        collateral: tokenOrFeedRecordSchema,
        loan: tokenOrFeedRecordSchema,
      })
      .strict(),
    feeds: z
      .object({
        collateral: tokenOrFeedRecordSchema,
        loan: tokenOrFeedRecordSchema,
        sequencerUptime: tokenOrFeedRecordSchema.nullable(),
        collateralMaxPriceAgeSeconds: unsignedIntegerTextSchema,
        loanMaxPriceAgeSeconds: unsignedIntegerTextSchema,
        sequencerGracePeriodSeconds: unsignedIntegerTextSchema,
      })
      .strict(),
    market: z
      .object({
        id: bytes32Schema,
        loanToken: evmAddressSchema,
        collateralToken: evmAddressSchema,
        oracle: evmAddressSchema,
        irm: evmAddressSchema,
        lltv: unsignedIntegerTextSchema,
        seedLiquidityOwner: evmAddressSchema,
        seedLiquidityAssets: unsignedIntegerTextSchema,
        seedLiquidityShares: unsignedIntegerTextSchema,
        oraclePriceAtDeployment: unsignedIntegerTextSchema,
        totalSupplyAssetsAtDeployment: unsignedIntegerTextSchema,
        availableLiquidityAtDeployment: unsignedIntegerTextSchema,
      })
      .strict(),
    configurationTransactions: z.array(testnetMorphoTransactionRecordSchema).min(6).max(8),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (manifest.tokens.collateral.address === manifest.tokens.loan.address) {
      context.addIssue({
        code: 'custom',
        message: 'Morpho testnet collateral and loan tokens must differ.',
        path: ['tokens'],
      });
    }
    const bindings: readonly [string, string, string, readonly (string | number)[]][] = [
      [
        'market collateral token',
        manifest.market.collateralToken,
        manifest.tokens.collateral.address,
        ['market', 'collateralToken'],
      ],
      [
        'market loan token',
        manifest.market.loanToken,
        manifest.tokens.loan.address,
        ['market', 'loanToken'],
      ],
      [
        'market oracle',
        manifest.market.oracle,
        manifest.contracts.oracle.address,
        ['market', 'oracle'],
      ],
      ['market IRM', manifest.market.irm, manifest.contracts.irm.address, ['market', 'irm']],
    ];
    for (const [label, actual, expected, path] of bindings) {
      if (actual !== expected) {
        context.addIssue({ code: 'custom', message: `${label} does not match.`, path: [...path] });
      }
    }
    if (BigInt(manifest.market.seedLiquidityAssets) === 0n) {
      context.addIssue({
        code: 'custom',
        message: 'Morpho testnet seed liquidity must be positive.',
        path: ['market', 'seedLiquidityAssets'],
      });
    }
    if (BigInt(manifest.market.seedLiquidityShares) === 0n) {
      context.addIssue({
        code: 'custom',
        message: 'Morpho testnet seed liquidity shares must be positive.',
        path: ['market', 'seedLiquidityShares'],
      });
    }
    if (BigInt(manifest.market.oraclePriceAtDeployment) === 0n) {
      context.addIssue({
        code: 'custom',
        message: 'Morpho testnet oracle price at deployment must be positive.',
        path: ['market', 'oraclePriceAtDeployment'],
      });
    }
    for (const field of ['collateralMaxPriceAgeSeconds', 'loanMaxPriceAgeSeconds'] as const) {
      if (BigInt(manifest.feeds[field]) === 0n) {
        context.addIssue({
          code: 'custom',
          message: 'Morpho testnet feed maximum ages must be positive.',
          path: ['feeds', field],
        });
      }
    }
    const expectedArtifacts = [
      ['morpho', 'Morpho'],
      ['irm', 'AdaptiveCurveIrm'],
      ['oracle', 'DebtShiftChainlinkOracle'],
    ] as const;
    for (const [contract, expectedArtifact] of expectedArtifacts) {
      if (manifest.contracts[contract].artifact !== expectedArtifact) {
        context.addIssue({
          code: 'custom',
          message: `${contract} artifact identity does not match.`,
          path: ['contracts', contract, 'artifact'],
        });
      }
    }
    const deploymentBlocks = Object.values(manifest.contracts).map((contract) =>
      BigInt(contract.deploymentBlockNumber),
    );
    const minimumDeploymentBlock = deploymentBlocks.reduce((minimum, block) =>
      block < minimum ? block : minimum,
    );
    if (BigInt(manifest.deploymentBlockNumber) !== minimumDeploymentBlock) {
      context.addIssue({
        code: 'custom',
        message: 'Morpho testnet deployment block does not match the first contract deployment.',
        path: ['deploymentBlockNumber'],
      });
    }
    for (const [index, transaction] of manifest.configurationTransactions.entries()) {
      if (transaction.sender !== manifest.deployer) {
        context.addIssue({
          code: 'custom',
          message: 'Morpho testnet configuration transaction sender must be the deployer.',
          path: ['configurationTransactions', index, 'sender'],
        });
      }
    }
    const grace = BigInt(manifest.feeds.sequencerGracePeriodSeconds);
    if (
      (manifest.feeds.sequencerUptime === null && grace !== 0n) ||
      (manifest.feeds.sequencerUptime !== null && grace === 0n)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Sequencer feed and positive grace period must be configured together.',
        path: ['feeds', 'sequencerUptime'],
      });
    }
  });

export type TestnetMorphoDeploymentManifest = z.infer<typeof testnetMorphoDeploymentManifestSchema>;

export function parseTestnetMorphoDeploymentManifest(
  input: string,
): Readonly<TestnetMorphoDeploymentManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error('Testnet Morpho deployment manifest must contain valid JSON.');
  }
  return Object.freeze(testnetMorphoDeploymentManifestSchema.parse(parsed));
}
