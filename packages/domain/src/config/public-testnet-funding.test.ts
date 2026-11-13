import { describe, expect, it } from 'vitest';

import {
  assessPublicTestnetFundingReadiness,
  publicTestnetFundingObservationSchema,
  publicTestnetFundingRequirementsSchema,
} from './public-testnet-funding.js';

describe('public testnet funding readiness', () => {
  it('accepts only a fully funded, separated, write-disabled public-testnet inventory', () => {
    const assessment = assessPublicTestnetFundingReadiness(requirements(), observation());

    expect(assessment.ready).toBe(true);
    expect(assessment.checks).toHaveLength(20);
    expect(assessment.deficiencies).toEqual([]);
  });

  it('reports every deficient funding or account prerequisite without short-circuiting', () => {
    const input = observation();
    input.source.borrower.positionExists = false;
    input.source.borrower.collateralUnits = '0';
    input.destination.deployer.loanUnits = '999';
    input.source.executor.collateralUnits = '0';
    input.near.registry.codeHash = 'deployed-code';
    input.near.registry.deploymentKeyPermission = 'FUNCTION_CALL';
    input.near.verifier.balanceYocto = '0';

    const assessment = assessPublicTestnetFundingReadiness(requirements(), input);

    expect(assessment.ready).toBe(false);
    expect(assessment.deficiencies.map(({ code }) => code)).toEqual([
      'source.borrower.position_exists',
      'source.borrower.collateral_units',
      'destination.deployer.morpho_seed_loan_units',
      'source.executor.collateral_units',
      'near.registry.code_hash',
      'near.registry.deployment_key_permission',
      'near.verifier.balance_yocto',
    ]);
  });

  it('rejects reused operational identities and non-positive release floors', () => {
    const reused = requirements();
    reused.evm.executor = reused.evm.deployer;
    expect(() => publicTestnetFundingRequirementsSchema.parse(reused)).toThrow(
      'EVM identities must be distinct',
    );

    const reusedNear = requirements();
    reusedNear.near.verifierAccount = reusedNear.near.ownerAccount;
    expect(() => publicTestnetFundingRequirementsSchema.parse(reusedNear)).toThrow(
      'NEAR registry, owner, and verifier identities must be distinct',
    );

    const zeroFloor = requirements();
    zeroFloor.evm.minimums.sourceVaultFundingUnits = '0';
    expect(() => publicTestnetFundingRequirementsSchema.parse(zeroFloor)).toThrow(
      'greater than zero',
    );

    const underfunded = requirements();
    underfunded.evm.minimums.sourceVaultFundingUnits = '499';
    expect(() => publicTestnetFundingRequirementsSchema.parse(underfunded)).toThrow(
      'must each cover the borrower debt floor',
    );
  });

  it('rejects non-finalized-shaped chain observations and malformed NEAR keys', () => {
    const malformedObservation = observation();
    malformedObservation.source.chainId = 1 as 11_155_111;
    expect(() => publicTestnetFundingObservationSchema.parse(malformedObservation)).toThrow();

    const malformedRequirements = requirements();
    malformedRequirements.near.registryDeploymentPublicKey = 'not-a-key';
    expect(() => publicTestnetFundingRequirementsSchema.parse(malformedRequirements)).toThrow(
      'NEAR public key',
    );
  });
});

function requirements() {
  return {
    schemaVersion: 1 as const,
    routeId: 'ethereum-sepolia-aave-v3-to-base-sepolia-morpho-blue-weth-usdc-v1',
    routeDependenciesHash: `0x${'1'.repeat(64)}` as `0x${string}`,
    environment: 'testnet' as const,
    workflowWriteSwitchEnabled: false as const,
    evm: {
      borrower: '0x1000000000000000000000000000000000000001' as `0x${string}`,
      deployer: '0x1000000000000000000000000000000000000002' as `0x${string}`,
      vaultFunder: '0x1000000000000000000000000000000000000003' as `0x${string}`,
      executor: '0x1000000000000000000000000000000000000004' as `0x${string}`,
      minimums: {
        borrowerSourceNativeBalanceWei: '100',
        borrowerCollateralUnits: '1000',
        borrowerDebtUnits: '500',
        deployerSourceNativeBalanceWei: '100',
        deployerDestinationNativeBalanceWei: '100',
        destinationMorphoSeedLiquidityUnits: '1000',
        vaultFunderSourceNativeBalanceWei: '100',
        sourceVaultFundingUnits: '1000',
        executorSourceNativeBalanceWei: '100',
        executorDestinationNativeBalanceWei: '100',
        executorSourceCollateralUnits: '1000',
        executorDestinationCollateralUnits: '1000',
      },
    },
    near: {
      network: 'testnet' as const,
      registryAccount: 'registry.testnet',
      ownerAccount: 'owner.testnet',
      verifierAccount: 'verifier.testnet',
      registryDeploymentPublicKey: `ed25519:${'1'.repeat(44)}`,
      minimumRegistryBalanceYocto: '5000',
      minimumVerifierBalanceYocto: '1000',
    },
  };
}

function observation() {
  return {
    checkedAt: '2026-11-13T16:00:00.000Z',
    source: {
      chainId: 11_155_111 as const,
      block: {
        number: '100',
        hash: `0x${'2'.repeat(64)}` as `0x${string}`,
        observedAt: '2026-11-13T15:59:00.000Z',
      },
      borrower: {
        nativeWei: '100',
        positionExists: true,
        collateralUnits: '1000',
        debtUnits: '500',
        healthFactorWad: '1500000000000000000',
      },
      deployer: { nativeWei: '100' },
      vaultFunder: { nativeWei: '100', debtUnits: '1000' },
      executor: { nativeWei: '100', collateralUnits: '1000' },
    },
    destination: {
      chainId: 84_532 as const,
      block: {
        number: '200',
        hash: `0x${'3'.repeat(64)}` as `0x${string}`,
        observedAt: '2026-11-13T15:59:30.000Z',
      },
      deployer: { nativeWei: '100', loanUnits: '1000' },
      executor: { nativeWei: '100', collateralUnits: '1000' },
    },
    near: {
      network: 'testnet' as const,
      registry: {
        exists: true,
        balanceYocto: '5000',
        codeHash: '11111111111111111111111111111111',
        deploymentKeyPermission: 'FULL_ACCESS' as 'FULL_ACCESS' | 'FUNCTION_CALL' | 'MISSING',
      },
      owner: { exists: true, balanceYocto: '0' },
      verifier: { exists: true, balanceYocto: '1000' },
    },
  };
}
