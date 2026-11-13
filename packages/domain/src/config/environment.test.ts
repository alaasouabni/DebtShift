import { describe, expect, it } from 'vitest';

import { assertFundedExecutionEnabled, parseDebtShiftEnvironment } from './environment.js';

describe('parseDebtShiftEnvironment', () => {
  it('defaults to the deterministic contract-backed sandbox', () => {
    const environment = parseDebtShiftEnvironment({});

    expect(environment.DEBTSHIFT_MODE).toBe('sandbox');
    expect(environment.MARKET_DATA_PROVIDER).toBe('SIMULATOR');
    expect(environment.TRANSPORT_PROVIDER).toBe('DEBTSHIFT_SIMULATOR');
    expect(environment.INTENTS_MODE).toBe('simulated');
    expect(environment.NEAR_NETWORK).toBe('sandbox');
    expect(environment.NEAR_RPC_FALLBACK_URLS_JSON).toEqual([]);
    expect(environment.EVM_DEPLOYMENT_MANIFEST_PATH).toBe('');
    expect(environment.AGENT_MODE).toBe('DETERMINISTIC');
    expect(environment.MAINNET_EXECUTION_ENABLED).toBe(false);
    expect(environment.SOURCE_FINALITY_CONFIRMATIONS).toBe(1);
    expect(environment.SOURCE_DEBT_BUFFER_BPS).toBe(10);
    expect(environment.SOURCE_DEPLOYMENT_BLOCK_NUMBER).toBe(0);
    expect(environment.DESTINATION_DEPLOYMENT_BLOCK_NUMBER).toBe(0);
    expect(environment.DESTINATION_FINALITY_CONFIRMATIONS).toBe(1);
    expect(environment.WORKFLOW_COMMAND_MAX_ATTEMPTS).toBe(25);
    expect(environment.WORKFLOW_COMMAND_RETRY_DELAY_MS).toBe(500);
    expect(environment.WORKFLOW_COMMAND_RETRY_MAX_DELAY_MS).toBe(30_000);
    expect(environment.WORKFLOW_COMMAND_STALE_AFTER_MS).toBe(300_000);
    expect(environment.ALERT_SCAN_INTERVAL_MS).toBe(30_000);
    expect(environment.ALERT_DEADLINE_LEAD_MS).toBe(60_000);
    expect(environment.ALERT_STALE_MIGRATION_MS).toBe(300_000);
    expect(environment.ALERT_STALE_RECOVERY_MS).toBe(900_000);
  });

  it('accepts exactly the four approved runtime modes', () => {
    expect(() => parseDebtShiftEnvironment({ DEBTSHIFT_MODE: 'local' })).toThrow();
    expect(() => parseDebtShiftEnvironment({ DEBTSHIFT_MODE: 'ci' })).toThrow();
    expect(() => parseDebtShiftEnvironment({ DEBTSHIFT_MODE: 'mainnet-canary' })).toThrow();
    expect(() => parseDebtShiftEnvironment({ DEBTSHIFT_MODE: 'mainnet-controlled' })).toThrow();
  });

  it('fails startup when removed canary or legacy environment keys remain configured', () => {
    expect(() => parseDebtShiftEnvironment({ DEBTSHIFT_ENV: 'local' })).toThrow(
      'Removed environment configuration is not accepted: DEBTSHIFT_ENV.',
    );
    expect(() => parseDebtShiftEnvironment({ MAINNET_CANARY_ENABLED: 'false' })).toThrow(
      'Removed environment configuration is not accepted: MAINNET_CANARY_ENABLED.',
    );
  });

  it('requires at least one configured confirmation on each EVM chain', () => {
    expect(() => parseDebtShiftEnvironment({ SOURCE_FINALITY_CONFIRMATIONS: '0' })).toThrow();
    expect(() => parseDebtShiftEnvironment({ DESTINATION_FINALITY_CONFIRMATIONS: '0' })).toThrow();
  });

  it('rejects production transport in sandbox mode', () => {
    expect(() =>
      parseDebtShiftEnvironment({
        DEBTSHIFT_MODE: 'sandbox',
        TRANSPORT_PROVIDER: 'NEAR_INTENTS_1CLICK',
        INTENTS_MODE: 'mainnet',
      }),
    ).toThrow('Sandbox and testnet modes require the explicitly simulated transport adapter.');
  });

  it('requires a real NEAR registry configuration for a hosted production sandbox', () => {
    expect(() => parseDebtShiftEnvironment({ NODE_ENV: 'production' })).toThrow(
      'Hosted sandbox, funded testnet, or mainnet execution requires the expected NEAR registry',
    );
    expect(() =>
      parseDebtShiftEnvironment({
        NODE_ENV: 'production',
        WEB_PUBLIC_URL: 'https://debtshift.example',
        API_PUBLIC_URL: 'https://api.debtshift.example',
        NEAR_NETWORK: 'testnet',
        NEAR_REGISTRY_ACCOUNT: 'registry.testnet',
        NEAR_REGISTRY_OWNER_ACCOUNT: 'owner.testnet',
        NEAR_REGISTRY_WASM_SHA256: `0x${'1'.repeat(64)}`,
        NEAR_SIGNER_ACCOUNT_ID: 'verifier.testnet',
        NEAR_SIGNER_PRIVATE_KEY: 'ed25519:test-private-key',
      }),
    ).not.toThrow();
  });

  it('requires HTTPS public origins in production so wallet cookies are secure', () => {
    expect(() =>
      parseDebtShiftEnvironment({
        NODE_ENV: 'production',
        WEB_PUBLIC_URL: 'https://debtshift.example',
        API_PUBLIC_URL: 'http://api.debtshift.example',
      }),
    ).toThrow('Production public web and API URLs must use HTTPS');
  });

  it('requires public onchain reads and the NEAR testnet registry in testnet mode', () => {
    expect(() =>
      parseDebtShiftEnvironment({
        DEBTSHIFT_MODE: 'testnet',
        NEAR_NETWORK: 'testnet',
      }),
    ).toThrow('Testnet mode requires onchain market reads and the NEAR testnet registry.');
  });

  it('requires an EVM deployment manifest before funded production execution', () => {
    expect(() =>
      parseDebtShiftEnvironment({ NODE_ENV: 'production', DEBTSHIFT_MODE: 'testnet' }),
    ).toThrow('Funded production execution requires EVM_DEPLOYMENT_MANIFEST_PATH');
  });

  it('accepts a bounded, unique list of HTTPS NEAR RPC fallbacks', () => {
    expect(
      parseDebtShiftEnvironment({
        NEAR_NETWORK: 'testnet',
        NEAR_RPC_URL: 'https://test.rpc.fastnear.com',
        NEAR_RPC_FALLBACK_URLS_JSON: JSON.stringify([
          'https://near-testnet.drpc.org',
          'https://testnet-rpc.intea.rs',
        ]),
      }).NEAR_RPC_FALLBACK_URLS_JSON,
    ).toEqual(['https://near-testnet.drpc.org', 'https://testnet-rpc.intea.rs']);
  });

  it('rejects malformed, duplicate, or insecure public NEAR RPC fallbacks', () => {
    expect(() => parseDebtShiftEnvironment({ NEAR_RPC_FALLBACK_URLS_JSON: 'not-json' })).toThrow(
      'RPC fallback URLs must be a JSON array',
    );
    expect(() =>
      parseDebtShiftEnvironment({
        NEAR_RPC_FALLBACK_URLS_JSON: JSON.stringify(['https://test.rpc.fastnear.com']),
      }),
    ).toThrow('NEAR RPC primary and fallback URLs must be unique');
    expect(() =>
      parseDebtShiftEnvironment({
        NEAR_NETWORK: 'testnet',
        NEAR_RPC_FALLBACK_URLS_JSON: JSON.stringify(['http://near-testnet.internal']),
      }),
    ).toThrow('Public NEAR network RPC endpoints must use HTTPS');
  });

  it('prevents sandbox market data from loading in mainnet read-only mode', () => {
    expect(() =>
      parseDebtShiftEnvironment({
        DEBTSHIFT_MODE: 'mainnet-readonly',
        TRANSPORT_PROVIDER: 'NEAR_INTENTS_1CLICK',
        INTENTS_MODE: 'mainnet-readonly',
        NEAR_NETWORK: 'mainnet',
      }),
    ).toThrow('Mainnet read-only mode must use live market data');
  });

  it('requires committed 1Click transport in mainnet mode', () => {
    expect(() =>
      parseDebtShiftEnvironment({
        DEBTSHIFT_MODE: 'mainnet',
        MARKET_DATA_PROVIDER: 'LIVE_READ_ONLY',
        LIVE_MARKET_CONFIG_JSON: validLiveMarketJson(),
        TRANSPORT_PROVIDER: 'NEAR_INTENTS_1CLICK',
        INTENTS_MODE: 'mainnet-readonly',
        INTENTS_AUTH_TOKEN: 'test-token',
        NEAR_NETWORK: 'mainnet',
      }),
    ).toThrow('Mainnet mode requires live market data, committed 1Click transport');
  });

  it('rejects the mainnet write switch in every non-mainnet mode', () => {
    expect(() => parseDebtShiftEnvironment({ MAINNET_EXECUTION_ENABLED: 'true' })).toThrow(
      'MAINNET_EXECUTION_ENABLED may be true only in mainnet mode.',
    );
  });

  it('accepts mainnet with writes disabled or explicitly enabled', () => {
    const base = {
      ...explicitExecutionConfiguration(),
      DEBTSHIFT_MODE: 'mainnet',
      MARKET_DATA_PROVIDER: 'LIVE_READ_ONLY',
      LIVE_MARKET_CONFIG_JSON: validLiveMarketJson(),
      TRANSPORT_PROVIDER: 'NEAR_INTENTS_1CLICK',
      INTENTS_MODE: 'mainnet',
      INTENTS_AUTH_TOKEN: 'test-token',
      NEAR_NETWORK: 'mainnet',
      NEAR_REGISTRY_ACCOUNT: 'registry.near',
      NEAR_REGISTRY_OWNER_ACCOUNT: 'owner.near',
      NEAR_REGISTRY_WASM_SHA256: `0x${'1'.repeat(64)}`,
      NEAR_SIGNER_ACCOUNT_ID: 'verifier.near',
      NEAR_SIGNER_PRIVATE_KEY: 'ed25519:test-private-key',
    } as const;

    expect(parseDebtShiftEnvironment(base).MAINNET_EXECUTION_ENABLED).toBe(false);
    expect(
      parseDebtShiftEnvironment({ ...base, MAINNET_EXECUTION_ENABLED: 'true' })
        .MAINNET_EXECUTION_ENABLED,
    ).toBe(true);
  });

  it('does not inherit sandbox deployment addresses in mainnet mode', () => {
    expect(() =>
      parseDebtShiftEnvironment({
        DEBTSHIFT_MODE: 'mainnet',
        MARKET_DATA_PROVIDER: 'LIVE_READ_ONLY',
        LIVE_MARKET_CONFIG_JSON: validLiveMarketJson(),
        TRANSPORT_PROVIDER: 'NEAR_INTENTS_1CLICK',
        INTENTS_MODE: 'mainnet',
        INTENTS_AUTH_TOKEN: 'test-token',
        NEAR_NETWORK: 'mainnet',
      }),
    ).toThrow('mainnet requires explicit execution deployment configuration');
  });

  it('rejects a retry ceiling below the configured base delay', () => {
    expect(() =>
      parseDebtShiftEnvironment({
        INTENTS_RETRY_BASE_DELAY_MS: '1000',
        INTENTS_RETRY_MAX_DELAY_MS: '999',
      }),
    ).toThrow('maximum retry delay cannot be lower');
  });

  it('bounds durable workflow retry and stale-lease policy', () => {
    expect(() => parseDebtShiftEnvironment({ WORKFLOW_COMMAND_MAX_ATTEMPTS: '0' })).toThrow();
    expect(() => parseDebtShiftEnvironment({ WORKFLOW_COMMAND_RETRY_DELAY_MS: '99' })).toThrow();
    expect(() =>
      parseDebtShiftEnvironment({
        WORKFLOW_COMMAND_RETRY_DELAY_MS: '1000',
        WORKFLOW_COMMAND_RETRY_MAX_DELAY_MS: '999',
      }),
    ).toThrow('Workflow maximum retry delay cannot be lower');
    expect(() => parseDebtShiftEnvironment({ WORKFLOW_COMMAND_STALE_AFTER_MS: '9999' })).toThrow();
    expect(
      parseDebtShiftEnvironment({
        WORKFLOW_COMMAND_MAX_ATTEMPTS: '12',
        WORKFLOW_COMMAND_RETRY_DELAY_MS: '750',
        WORKFLOW_COMMAND_RETRY_MAX_DELAY_MS: '15000',
        WORKFLOW_COMMAND_STALE_AFTER_MS: '120000',
      }),
    ).toMatchObject({
      WORKFLOW_COMMAND_MAX_ATTEMPTS: 12,
      WORKFLOW_COMMAND_RETRY_DELAY_MS: 750,
      WORKFLOW_COMMAND_RETRY_MAX_DELAY_MS: 15_000,
      WORKFLOW_COMMAND_STALE_AFTER_MS: 120_000,
    });
  });

  it('bounds operational alert scan and escalation policy', () => {
    expect(() => parseDebtShiftEnvironment({ ALERT_SCAN_INTERVAL_MS: '999' })).toThrow();
    expect(() => parseDebtShiftEnvironment({ ALERT_DEADLINE_LEAD_MS: '999' })).toThrow();
    expect(() => parseDebtShiftEnvironment({ ALERT_STALE_MIGRATION_MS: '9999' })).toThrow();
    expect(() => parseDebtShiftEnvironment({ ALERT_STALE_RECOVERY_MS: '9999' })).toThrow();
    expect(
      parseDebtShiftEnvironment({
        ALERT_SCAN_INTERVAL_MS: '5000',
        ALERT_DEADLINE_LEAD_MS: '120000',
        ALERT_STALE_MIGRATION_MS: '600000',
        ALERT_STALE_RECOVERY_MS: '1800000',
      }),
    ).toMatchObject({
      ALERT_SCAN_INTERVAL_MS: 5_000,
      ALERT_DEADLINE_LEAD_MS: 120_000,
      ALERT_STALE_MIGRATION_MS: 600_000,
      ALERT_STALE_RECOVERY_MS: 1_800_000,
    });
  });
});

describe('assertFundedExecutionEnabled', () => {
  it('allows sandbox and testnet workflow scheduling', () => {
    expect(() =>
      assertFundedExecutionEnabled({
        DEBTSHIFT_MODE: 'sandbox',
        MAINNET_EXECUTION_ENABLED: false,
      }),
    ).not.toThrow();
    expect(() =>
      assertFundedExecutionEnabled({
        DEBTSHIFT_MODE: 'testnet',
        MAINNET_EXECUTION_ENABLED: false,
      }),
    ).not.toThrow();
  });

  it('always blocks funded execution in mainnet-readonly mode', () => {
    expect(() =>
      assertFundedExecutionEnabled({
        DEBTSHIFT_MODE: 'mainnet-readonly',
        MAINNET_EXECUTION_ENABLED: false,
      }),
    ).toThrow('Funded execution is unavailable in mainnet-readonly mode.');
  });

  it('blocks mainnet writes by default and permits them only after explicit enablement', () => {
    expect(() =>
      assertFundedExecutionEnabled({
        DEBTSHIFT_MODE: 'mainnet',
        MAINNET_EXECUTION_ENABLED: false,
      }),
    ).toThrow('Mainnet execution is disabled by MAINNET_EXECUTION_ENABLED=false.');
    expect(() =>
      assertFundedExecutionEnabled({
        DEBTSHIFT_MODE: 'mainnet',
        MAINNET_EXECUTION_ENABLED: true,
      }),
    ).not.toThrow();
  });
});

function explicitExecutionConfiguration() {
  const address = (suffix: number) => `0x${suffix.toString(16).padStart(40, '0')}`;
  return {
    SOURCE_DEPLOYMENT_BLOCK_NUMBER: '123456',
    DESTINATION_DEPLOYMENT_BLOCK_NUMBER: '234567',
    EIP712_VERIFYING_CONTRACT: address(101),
    SOURCE_DEBT_TOKEN_ADDRESS: address(102),
    SOURCE_COLLATERAL_TOKEN_ADDRESS: address(103),
    SOURCE_LENDING_ADDRESS: address(104),
    SOURCE_VAULT_ADDRESS: address(105),
    SOURCE_ESCROW_ADDRESS: address(106),
    SOURCE_ADAPTER_ADDRESS: address(107),
    DESTINATION_DEBT_TOKEN_ADDRESS: address(108),
    DESTINATION_COLLATERAL_TOKEN_ADDRESS: address(109),
    DESTINATION_LENDING_ADDRESS: address(110),
    DESTINATION_ESCROW_ADDRESS: address(111),
    DESTINATION_ADAPTER_ADDRESS: address(112),
    EXECUTOR_ADDRESS: address(113),
    EXECUTOR_PRIVATE_KEY: `0x${'44'.repeat(32)}`,
  };
}

function validLiveMarketJson(): string {
  const feed = (suffix: number) => ({
    address: `0x${suffix.toString(16).padStart(40, '0')}`,
    maximumAgeSeconds: 3600,
  });
  const token = (suffix: number, symbol: string, decimals: number) => ({
    address: `0x${suffix.toString(16).padStart(40, '0')}`,
    decimals,
    symbol,
    providerAssetId: `nep141:${symbol.toLowerCase()}-${suffix.toString()}`,
  });
  return JSON.stringify({
    version: 1,
    source: {
      pool: feed(1).address,
      dataProvider: feed(2).address,
      collateralAsset: token(3, 'WETH', 18),
      debtAsset: token(4, 'USDC', 6),
    },
    destination: {
      morpho: feed(5).address,
      marketId: `0x${'11'.repeat(32)}`,
      morphoOracle: feed(6).address,
      collateralAsset: token(7, 'WETH', 18),
      debtAsset: token(8, 'USDC', 6),
      morphoOracleFeeds: [feed(9)],
    },
    prices: {
      sourceCollateralUsd: feed(10),
      sourceDebtUsd: feed(11),
      sourceNativeUsd: feed(12),
      destinationCollateralUsd: feed(13),
      destinationDebtUsd: feed(14),
      destinationNativeUsd: feed(15),
    },
    policy: {
      horizonDays: 30,
      maxAllInCostUsdMicro: '100000000',
      minAprReductionBps: 1,
      maxPositionSnapshotAgeSeconds: 300,
      maxMarketSnapshotAgeSeconds: 300,
      maxOracleAgeSeconds: 300,
      minimumLiquidityBufferBps: 100,
      stressCollateralDropBps: 1000,
      stressTargetAprIncreaseBps: 100,
      maximumLtvBps: 8000,
      stressMaximumLtvBps: 7000,
    },
    analyticsCosts: {
      sourceGasUnitsUpperBound: 500000,
      destinationGasUnitsUpperBound: 500000,
      estimatedSettlementSeconds: 60,
      settlementTimeP95Seconds: 300,
      tailLossEstimateUsdMicro: '0',
      settlementRiskCostUsdMicro: '0',
      dependencyRiskCostUsdMicro: '0',
    },
  });
}
