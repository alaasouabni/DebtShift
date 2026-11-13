import { z } from 'zod';

import {
  baseUnitAmountSchema,
  bytes32Schema,
  canonicalTextSchema,
  evmAddressSchema,
  isoTimestampSchema,
  nearAccountIdSchema,
  positiveBaseUnitAmountSchema,
  uint64StringSchema,
} from '../primitives.js';

const nearPublicKeySchema = z
  .string()
  .trim()
  .min(20)
  .max(160)
  .regex(/^(ed25519|secp256k1):[1-9A-HJ-NP-Za-km-z]+$/, 'Expected a NEAR public key.');

const finalizedEvmBlockSchema = z
  .object({
    number: uint64StringSchema,
    hash: bytes32Schema,
    observedAt: isoTimestampSchema,
  })
  .strict();

const evmFundingMinimumsSchema = z
  .object({
    borrowerSourceNativeBalanceWei: positiveBaseUnitAmountSchema,
    borrowerCollateralUnits: positiveBaseUnitAmountSchema,
    borrowerDebtUnits: positiveBaseUnitAmountSchema,
    deployerSourceNativeBalanceWei: positiveBaseUnitAmountSchema,
    deployerDestinationNativeBalanceWei: positiveBaseUnitAmountSchema,
    destinationMorphoSeedLiquidityUnits: positiveBaseUnitAmountSchema,
    sourceVaultFundingUnits: positiveBaseUnitAmountSchema,
    executorSourceNativeBalanceWei: positiveBaseUnitAmountSchema,
    executorDestinationNativeBalanceWei: positiveBaseUnitAmountSchema,
    executorSourceCollateralUnits: positiveBaseUnitAmountSchema,
    executorDestinationCollateralUnits: positiveBaseUnitAmountSchema,
  })
  .strict();

export const publicTestnetFundingRequirementsSchema = z
  .object({
    schemaVersion: z.literal(1),
    routeId: canonicalTextSchema,
    routeDependenciesHash: bytes32Schema,
    environment: z.literal('testnet'),
    workflowWriteSwitchEnabled: z.literal(false),
    evm: z
      .object({
        borrower: evmAddressSchema,
        deployer: evmAddressSchema,
        vaultFunder: evmAddressSchema,
        executor: evmAddressSchema,
        minimums: evmFundingMinimumsSchema,
      })
      .strict(),
    near: z
      .object({
        network: z.literal('testnet'),
        registryAccount: nearAccountIdSchema,
        ownerAccount: nearAccountIdSchema,
        verifierAccount: nearAccountIdSchema,
        registryDeploymentPublicKey: nearPublicKeySchema,
        minimumRegistryBalanceYocto: positiveBaseUnitAmountSchema,
        minimumVerifierBalanceYocto: positiveBaseUnitAmountSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((requirements, context) => {
    const evmIdentities = [
      requirements.evm.borrower,
      requirements.evm.deployer,
      requirements.evm.vaultFunder,
      requirements.evm.executor,
    ].map((address) => address.toLowerCase());
    if (new Set(evmIdentities).size !== evmIdentities.length) {
      context.addIssue({
        code: 'custom',
        message: 'Borrower, deployer, vault funder, and executor EVM identities must be distinct.',
        path: ['evm'],
      });
    }

    const nearIdentities = [
      requirements.near.registryAccount,
      requirements.near.ownerAccount,
      requirements.near.verifierAccount,
    ];
    if (new Set(nearIdentities).size !== nearIdentities.length) {
      context.addIssue({
        code: 'custom',
        message: 'NEAR registry, owner, and verifier identities must be distinct.',
        path: ['near'],
      });
    }

    const minimums = requirements.evm.minimums;
    if (
      BigInt(minimums.sourceVaultFundingUnits) < BigInt(minimums.borrowerDebtUnits) ||
      BigInt(minimums.destinationMorphoSeedLiquidityUnits) < BigInt(minimums.borrowerDebtUnits)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Vault funding and Morpho seed liquidity must each cover the borrower debt floor.',
        path: ['evm', 'minimums'],
      });
    }
    if (
      BigInt(minimums.executorSourceCollateralUnits) > BigInt(minimums.borrowerCollateralUnits) ||
      BigInt(minimums.executorDestinationCollateralUnits) > BigInt(minimums.borrowerCollateralUnits)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Transport collateral floors cannot exceed the borrower collateral floor.',
        path: ['evm', 'minimums'],
      });
    }
  });

const observedEvmBalanceSchema = z
  .object({
    nativeWei: baseUnitAmountSchema,
  })
  .strict();

const observedNearAccountSchema = z
  .object({
    exists: z.boolean(),
    balanceYocto: baseUnitAmountSchema,
  })
  .strict();

export const publicTestnetFundingObservationSchema = z
  .object({
    checkedAt: isoTimestampSchema,
    source: z
      .object({
        chainId: z.literal(11_155_111),
        block: finalizedEvmBlockSchema,
        borrower: observedEvmBalanceSchema.extend({
          positionExists: z.boolean(),
          collateralUnits: baseUnitAmountSchema,
          debtUnits: baseUnitAmountSchema,
          healthFactorWad: baseUnitAmountSchema.nullable(),
        }),
        deployer: observedEvmBalanceSchema,
        vaultFunderDebtUnits: baseUnitAmountSchema,
        executor: observedEvmBalanceSchema.extend({
          collateralUnits: baseUnitAmountSchema,
        }),
      })
      .strict(),
    destination: z
      .object({
        chainId: z.literal(84_532),
        block: finalizedEvmBlockSchema,
        deployer: observedEvmBalanceSchema.extend({
          loanUnits: baseUnitAmountSchema,
        }),
        executor: observedEvmBalanceSchema.extend({
          collateralUnits: baseUnitAmountSchema,
        }),
      })
      .strict(),
    near: z
      .object({
        network: z.literal('testnet'),
        registry: observedNearAccountSchema.extend({
          codeHash: z.string().trim().min(1).max(128).nullable(),
          deploymentKeyPermission: z.enum(['FULL_ACCESS', 'FUNCTION_CALL', 'MISSING']),
        }),
        owner: observedNearAccountSchema,
        verifier: observedNearAccountSchema,
      })
      .strict(),
  })
  .strict();

export type PublicTestnetFundingRequirements = z.infer<
  typeof publicTestnetFundingRequirementsSchema
>;
export type PublicTestnetFundingObservation = z.infer<typeof publicTestnetFundingObservationSchema>;

export interface PublicTestnetFundingCheck {
  readonly code: string;
  readonly actual: string;
  readonly required: string;
  readonly ready: boolean;
}

export interface PublicTestnetFundingAssessment {
  readonly ready: boolean;
  readonly checks: readonly PublicTestnetFundingCheck[];
  readonly deficiencies: readonly PublicTestnetFundingCheck[];
}

const EMPTY_NEAR_CODE_HASH = '11111111111111111111111111111111';

export function assessPublicTestnetFundingReadiness(
  requirementsInput: unknown,
  observationInput: unknown,
): Readonly<PublicTestnetFundingAssessment> {
  const requirements = publicTestnetFundingRequirementsSchema.parse(requirementsInput);
  const observation = publicTestnetFundingObservationSchema.parse(observationInput);
  const minimums = requirements.evm.minimums;
  const checks: PublicTestnetFundingCheck[] = [];
  const amount = (code: string, actual: string, required: string) => {
    checks.push({ code, actual, required, ready: BigInt(actual) >= BigInt(required) });
  };
  const exact = (code: string, actual: string, required: string) => {
    checks.push({ code, actual, required, ready: actual === required });
  };

  exact(
    'source.borrower.position_exists',
    observation.source.borrower.positionExists.toString(),
    'true',
  );
  amount(
    'source.borrower.collateral_units',
    observation.source.borrower.collateralUnits,
    minimums.borrowerCollateralUnits,
  );
  amount(
    'source.borrower.debt_units',
    observation.source.borrower.debtUnits,
    minimums.borrowerDebtUnits,
  );
  amount(
    'source.borrower.native_balance_wei',
    observation.source.borrower.nativeWei,
    minimums.borrowerSourceNativeBalanceWei,
  );
  amount(
    'source.deployer.native_balance_wei',
    observation.source.deployer.nativeWei,
    minimums.deployerSourceNativeBalanceWei,
  );
  amount(
    'destination.deployer.native_balance_wei',
    observation.destination.deployer.nativeWei,
    minimums.deployerDestinationNativeBalanceWei,
  );
  amount(
    'destination.deployer.morpho_seed_loan_units',
    observation.destination.deployer.loanUnits,
    minimums.destinationMorphoSeedLiquidityUnits,
  );
  amount(
    'source.vault_funder.debt_units',
    observation.source.vaultFunderDebtUnits,
    minimums.sourceVaultFundingUnits,
  );
  amount(
    'source.executor.native_balance_wei',
    observation.source.executor.nativeWei,
    minimums.executorSourceNativeBalanceWei,
  );
  amount(
    'destination.executor.native_balance_wei',
    observation.destination.executor.nativeWei,
    minimums.executorDestinationNativeBalanceWei,
  );
  amount(
    'source.executor.collateral_units',
    observation.source.executor.collateralUnits,
    minimums.executorSourceCollateralUnits,
  );
  amount(
    'destination.executor.collateral_units',
    observation.destination.executor.collateralUnits,
    minimums.executorDestinationCollateralUnits,
  );
  exact('near.registry.exists', observation.near.registry.exists.toString(), 'true');
  amount(
    'near.registry.balance_yocto',
    observation.near.registry.balanceYocto,
    requirements.near.minimumRegistryBalanceYocto,
  );
  exact(
    'near.registry.code_hash',
    observation.near.registry.codeHash ?? 'MISSING',
    EMPTY_NEAR_CODE_HASH,
  );
  exact(
    'near.registry.deployment_key_permission',
    observation.near.registry.deploymentKeyPermission,
    'FULL_ACCESS',
  );
  exact('near.owner.exists', observation.near.owner.exists.toString(), 'true');
  exact('near.verifier.exists', observation.near.verifier.exists.toString(), 'true');
  amount(
    'near.verifier.balance_yocto',
    observation.near.verifier.balanceYocto,
    requirements.near.minimumVerifierBalanceYocto,
  );

  const frozenChecks = checks.map((check) => Object.freeze(check));
  const deficiencies = frozenChecks.filter((check) => !check.ready);
  return Object.freeze({
    ready: deficiencies.length === 0,
    checks: Object.freeze(frozenChecks),
    deficiencies: Object.freeze(deficiencies),
  });
}
