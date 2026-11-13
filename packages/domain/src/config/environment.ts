import { z } from 'zod';

import { bytes32Schema, evmAddressSchema, nearAccountIdSchema } from '../primitives.js';
import { parseLiveMarketConfiguration } from './live-market.js';

const booleanString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const optionalUrl = z.union([z.url(), z.literal('')]).default('');
const optionalString = z.string().default('');
const optionalNearAccount = z.union([nearAccountIdSchema, z.literal('')]).default('');
const optionalBytes32 = z.union([bytes32Schema, z.literal('')]).default('');
const httpUrl = z.url().refine((value) => ['http:', 'https:'].includes(new URL(value).protocol), {
  message: 'RPC URL must use HTTP or HTTPS.',
});
const urlListJson = z
  .string()
  .default('[]')
  .transform((value, context): readonly string[] => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value) as unknown;
    } catch {
      context.addIssue({ code: 'custom', message: 'RPC fallback URLs must be a JSON array.' });
      return z.NEVER;
    }
    const result = z.array(httpUrl).max(4).safeParse(parsed);
    if (!result.success) {
      context.addIssue({
        code: 'custom',
        message: 'RPC fallback URLs must contain at most four HTTP(S) URLs.',
      });
      return z.NEVER;
    }
    return result.data;
  });
const optionalPrivateKey = z
  .union([z.string().regex(/^0x[0-9a-fA-F]{64}$/), z.literal('')])
  .default('');

export const debtShiftEnvironmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DEBTSHIFT_MODE: z
      .enum(['sandbox', 'testnet', 'mainnet-readonly', 'mainnet'])
      .default('sandbox'),
    MARKET_DATA_PROVIDER: z.enum(['SIMULATOR', 'LIVE_READ_ONLY', 'DISABLED']).default('SIMULATOR'),
    LIVE_MARKET_CONFIG_JSON: optionalString,
    EVM_DEPLOYMENT_MANIFEST_PATH: optionalString,
    TESTNET_MORPHO_DEPLOYMENT_MANIFEST_PATH: optionalString,
    WEB_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    API_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
    WEB_PUBLIC_URL: z.url().default('http://localhost:3000'),
    API_PUBLIC_URL: z.url().default('http://localhost:3001'),
    DATABASE_URL: z
      .url()
      .default('postgresql://debtshift:debtshift_local@localhost:5432/debtshift'),
    REDIS_URL: z.url().default('redis://localhost:6379'),
    SOURCE_CHAIN_ID: z.coerce.number().int().positive().default(31_337),
    SOURCE_RPC_URL: z.url().default('http://localhost:8545'),
    SOURCE_DEPLOYMENT_BLOCK_NUMBER: z.coerce.number().int().nonnegative().default(0),
    SOURCE_FINALITY_CONFIRMATIONS: z.coerce.number().int().min(1).max(2_048).default(1),
    SOURCE_DEBT_BUFFER_BPS: z.coerce.number().int().min(1).max(500).default(10),
    DESTINATION_CHAIN_ID: z.coerce.number().int().positive().default(31_338),
    DESTINATION_RPC_URL: z.url().default('http://localhost:8546'),
    DESTINATION_DEPLOYMENT_BLOCK_NUMBER: z.coerce.number().int().nonnegative().default(0),
    DESTINATION_FINALITY_CONFIRMATIONS: z.coerce.number().int().min(1).max(2_048).default(1),
    EIP712_VERIFYING_CONTRACT: evmAddressSchema.default(
      '0x5fc8d32690cc91d4c39d9d3abcbd16989f875707',
    ),
    SANDBOX_EXECUTOR_PRIVATE_KEY: optionalPrivateKey,
    EXECUTOR_PRIVATE_KEY: optionalPrivateKey,
    SOURCE_DEBT_TOKEN_ADDRESS: evmAddressSchema.default(
      '0x5fbdb2315678afecb367f032d93f642f64180aa3',
    ),
    SOURCE_COLLATERAL_TOKEN_ADDRESS: evmAddressSchema.default(
      '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512',
    ),
    SOURCE_LENDING_ADDRESS: evmAddressSchema.default('0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0'),
    SOURCE_VAULT_ADDRESS: evmAddressSchema.default('0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9'),
    SOURCE_ESCROW_ADDRESS: evmAddressSchema.default('0xdc64a140aa3e981100a9beca4e685f962f0cf6c9'),
    SOURCE_ADAPTER_ADDRESS: evmAddressSchema.default('0x5fc8d32690cc91d4c39d9d3abcbd16989f875707'),
    DESTINATION_DEBT_TOKEN_ADDRESS: evmAddressSchema.default(
      '0x5fbdb2315678afecb367f032d93f642f64180aa3',
    ),
    DESTINATION_COLLATERAL_TOKEN_ADDRESS: evmAddressSchema.default(
      '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512',
    ),
    DESTINATION_LENDING_ADDRESS: evmAddressSchema.default(
      '0x9fe46736679d2d9a65f0992f2272de9f3c7fa6e0',
    ),
    DESTINATION_ESCROW_ADDRESS: evmAddressSchema.default(
      '0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9',
    ),
    DESTINATION_ADAPTER_ADDRESS: evmAddressSchema.default(
      '0xdc64a140aa3e981100a9beca4e685f962f0cf6c9',
    ),
    EXECUTOR_ADDRESS: evmAddressSchema.default('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'),
    TRANSPORT_PROVIDER: z
      .enum(['DEBTSHIFT_SIMULATOR', 'NEAR_INTENTS_1CLICK'])
      .default('DEBTSHIFT_SIMULATOR'),
    INTENTS_MODE: z.enum(['simulated', 'mainnet-readonly', 'mainnet']).default('simulated'),
    INTENTS_BASE_URL: z.url().default('https://1click.chaindefuser.com'),
    INTENTS_AUTH_TOKEN: optionalString,
    INTENTS_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(100).max(60_000).default(8_000),
    INTENTS_RESPONSE_LIMIT_BYTES: z.coerce
      .number()
      .int()
      .min(1_024)
      .max(10_000_000)
      .default(1_000_000),
    INTENTS_CATALOG_CACHE_TTL_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(86_400_000)
      .default(600_000),
    INTENTS_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
    INTENTS_RETRY_BASE_DELAY_MS: z.coerce.number().int().min(1).max(60_000).default(200),
    INTENTS_RETRY_MAX_DELAY_MS: z.coerce.number().int().min(1).max(120_000).default(2_000),
    INTENTS_CIRCUIT_FAILURE_THRESHOLD: z.coerce.number().int().min(1).max(100).default(5),
    INTENTS_CIRCUIT_RESET_MS: z.coerce.number().int().min(100).max(600_000).default(30_000),
    INTENTS_RATE_LIMIT_CAPACITY: z.coerce.number().int().min(1).max(10_000).default(10),
    INTENTS_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
    INTENTS_CACHE_MAX_ENTRIES: z.coerce.number().int().min(1).max(10_000).default(100),
    WORKFLOW_COMMAND_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(25),
    WORKFLOW_COMMAND_RETRY_DELAY_MS: z.coerce.number().int().min(100).max(60_000).default(500),
    WORKFLOW_COMMAND_RETRY_MAX_DELAY_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(300_000)
      .default(30_000),
    WORKFLOW_COMMAND_STALE_AFTER_MS: z.coerce
      .number()
      .int()
      .min(10_000)
      .max(3_600_000)
      .default(300_000),
    ALERT_SCAN_INTERVAL_MS: z.coerce.number().int().min(1_000).max(300_000).default(30_000),
    ALERT_DEADLINE_LEAD_MS: z.coerce.number().int().min(1_000).max(3_600_000).default(60_000),
    ALERT_STALE_MIGRATION_MS: z.coerce.number().int().min(10_000).max(86_400_000).default(300_000),
    ALERT_STALE_RECOVERY_MS: z.coerce.number().int().min(10_000).max(604_800_000).default(900_000),
    SIMULATOR_TERMINAL_OUTCOME: z
      .enum([
        'SUCCESS',
        'INCOMPLETE_DEPOSIT',
        'REFUNDED',
        'FAILED_KNOWN_CUSTODY',
        'FAILED_AMBIGUOUS_CUSTODY',
        'UNKNOWN',
      ])
      .default('SUCCESS'),
    SIMULATOR_PROCESSING_POLLS: z.coerce.number().int().min(0).max(100).default(1),
    NEAR_NETWORK: z.enum(['sandbox', 'testnet', 'mainnet']).default('sandbox'),
    NEAR_RPC_URL: httpUrl.default('https://test.rpc.fastnear.com'),
    NEAR_RPC_FALLBACK_URLS_JSON: urlListJson,
    NEAR_REGISTRY_ACCOUNT: optionalNearAccount,
    NEAR_REGISTRY_OWNER_ACCOUNT: optionalNearAccount,
    NEAR_REGISTRY_WASM_SHA256: optionalBytes32,
    NEAR_SIGNER_ACCOUNT_ID: optionalNearAccount,
    NEAR_SIGNER_PRIVATE_KEY: optionalString,
    NEAR_STORAGE_DEPOSIT_YOCTO: z
      .string()
      .regex(/^(0|[1-9][0-9]*)$/)
      .default('1000000000000000000000000'),
    NEAR_FUNCTION_CALL_GAS: z
      .string()
      .regex(/^[1-9][0-9]*$/)
      .default('100000000000000'),
    AGENT_MODE: z.enum(['DETERMINISTIC', 'LOCAL_AI', 'USER_API']).default('DETERMINISTIC'),
    OLLAMA_BASE_URL: z.url().default('http://127.0.0.1:11434'),
    OLLAMA_MODEL: z.string().min(1).default('qwen3.5:4b'),
    ALLOW_CUSTOM_AI_ENDPOINTS: booleanString,
    MAINNET_EXECUTION_ENABLED: booleanString,
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    OTEL_EXPORTER_OTLP_ENDPOINT: optionalUrl,
  })
  .superRefine((environment, context) => {
    const nearRpcUrls = [environment.NEAR_RPC_URL, ...environment.NEAR_RPC_FALLBACK_URLS_JSON];
    if (new Set(nearRpcUrls).size !== nearRpcUrls.length) {
      context.addIssue({
        code: 'custom',
        message: 'NEAR RPC primary and fallback URLs must be unique.',
        path: ['NEAR_RPC_FALLBACK_URLS_JSON'],
      });
    }
    if (
      environment.NEAR_NETWORK !== 'sandbox' &&
      nearRpcUrls.some((value) => new URL(value).protocol !== 'https:')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Public NEAR network RPC endpoints must use HTTPS.',
        path: ['NEAR_RPC_FALLBACK_URLS_JSON'],
      });
    }

    if (
      environment.NODE_ENV === 'production' &&
      (new URL(environment.WEB_PUBLIC_URL).protocol !== 'https:' ||
        new URL(environment.API_PUBLIC_URL).protocol !== 'https:')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Production public web and API URLs must use HTTPS for secure wallet sessions.',
        path: ['API_PUBLIC_URL'],
      });
    }
    if (
      environment.DEBTSHIFT_MODE === 'testnet' &&
      environment.TESTNET_MORPHO_DEPLOYMENT_MANIFEST_PATH.length === 0
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Funded testnet execution requires TESTNET_MORPHO_DEPLOYMENT_MANIFEST_PATH.',
        path: ['TESTNET_MORPHO_DEPLOYMENT_MANIFEST_PATH'],
      });
    }

    if (environment.INTENTS_RETRY_MAX_DELAY_MS < environment.INTENTS_RETRY_BASE_DELAY_MS) {
      context.addIssue({
        code: 'custom',
        message: '1Click maximum retry delay cannot be lower than its base retry delay.',
        path: ['INTENTS_RETRY_MAX_DELAY_MS'],
      });
    }

    if (
      environment.WORKFLOW_COMMAND_RETRY_MAX_DELAY_MS < environment.WORKFLOW_COMMAND_RETRY_DELAY_MS
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Workflow maximum retry delay cannot be lower than its base retry delay.',
        path: ['WORKFLOW_COMMAND_RETRY_MAX_DELAY_MS'],
      });
    }

    if (
      environment.DEBTSHIFT_MODE === 'sandbox' &&
      environment.MARKET_DATA_PROVIDER !== 'SIMULATOR'
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Sandbox mode requires the contract-backed sandbox market provider.',
        path: ['MARKET_DATA_PROVIDER'],
      });
    }

    if (environment.MARKET_DATA_PROVIDER === 'LIVE_READ_ONLY') {
      try {
        const liveMarket = parseLiveMarketConfiguration(environment.LIVE_MARKET_CONFIG_JSON);
        if (
          (environment.DEBTSHIFT_MODE === 'mainnet-readonly' ||
            environment.DEBTSHIFT_MODE === 'mainnet') &&
          [
            liveMarket.source.collateralAsset,
            liveMarket.source.debtAsset,
            liveMarket.destination.collateralAsset,
            liveMarket.destination.debtAsset,
          ].some((asset) => asset.providerAssetId === undefined)
        ) {
          context.addIssue({
            code: 'custom',
            message: 'Mainnet live routes require provider asset IDs for every route asset.',
            path: ['LIVE_MARKET_CONFIG_JSON'],
          });
        }
      } catch (error) {
        context.addIssue({
          code: 'custom',
          message: error instanceof Error ? error.message : 'Live market configuration is invalid.',
          path: ['LIVE_MARKET_CONFIG_JSON'],
        });
      }
    }

    if (
      (environment.DEBTSHIFT_MODE === 'sandbox' || environment.DEBTSHIFT_MODE === 'testnet') &&
      (environment.TRANSPORT_PROVIDER !== 'DEBTSHIFT_SIMULATOR' ||
        environment.INTENTS_MODE !== 'simulated')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Sandbox and testnet modes require the explicitly simulated transport adapter.',
        path: ['INTENTS_MODE'],
      });
    }

    if (
      environment.DEBTSHIFT_MODE === 'testnet' &&
      (environment.MARKET_DATA_PROVIDER !== 'LIVE_READ_ONLY' ||
        environment.NEAR_NETWORK !== 'testnet')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Testnet mode requires onchain market reads and the NEAR testnet registry.',
        path: ['DEBTSHIFT_MODE'],
      });
    }

    if (
      environment.DEBTSHIFT_MODE === 'mainnet-readonly' &&
      (environment.TRANSPORT_PROVIDER !== 'NEAR_INTENTS_1CLICK' ||
        environment.INTENTS_MODE !== 'mainnet-readonly' ||
        environment.MARKET_DATA_PROVIDER !== 'LIVE_READ_ONLY' ||
        environment.NEAR_NETWORK !== 'mainnet')
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Mainnet read-only mode must use live market data, 1Click dry quotes, and the mainnet registry.',
        path: ['DEBTSHIFT_MODE'],
      });
    }

    if (
      environment.DEBTSHIFT_MODE === 'mainnet' &&
      (environment.TRANSPORT_PROVIDER !== 'NEAR_INTENTS_1CLICK' ||
        environment.INTENTS_MODE !== 'mainnet' ||
        environment.MARKET_DATA_PROVIDER !== 'LIVE_READ_ONLY' ||
        environment.NEAR_NETWORK !== 'mainnet')
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Mainnet mode requires live market data, committed 1Click transport, and the mainnet registry.',
        path: ['DEBTSHIFT_MODE'],
      });
    }

    if (
      (environment.DEBTSHIFT_MODE === 'mainnet-readonly' ||
        environment.DEBTSHIFT_MODE === 'mainnet') &&
      environment.INTENTS_AUTH_TOKEN.length === 0
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Official 1Click access requires an INTENTS_AUTH_TOKEN.',
        path: ['INTENTS_AUTH_TOKEN'],
      });
    }

    if (environment.MAINNET_EXECUTION_ENABLED && environment.DEBTSHIFT_MODE !== 'mainnet') {
      context.addIssue({
        code: 'custom',
        message: 'MAINNET_EXECUTION_ENABLED may be true only in mainnet mode.',
        path: ['MAINNET_EXECUTION_ENABLED'],
      });
    }
    if (
      (environment.DEBTSHIFT_MODE === 'testnet' ||
        (environment.DEBTSHIFT_MODE === 'mainnet' && environment.MAINNET_EXECUTION_ENABLED)) &&
      environment.EXECUTOR_PRIVATE_KEY.length === 0
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Funded testnet or mainnet execution requires EXECUTOR_PRIVATE_KEY.',
        path: ['EXECUTOR_PRIVATE_KEY'],
      });
    }
    if (
      environment.NODE_ENV === 'production' &&
      (environment.DEBTSHIFT_MODE === 'testnet' ||
        (environment.DEBTSHIFT_MODE === 'mainnet' && environment.MAINNET_EXECUTION_ENABLED)) &&
      environment.EVM_DEPLOYMENT_MANIFEST_PATH.length === 0
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Funded production execution requires EVM_DEPLOYMENT_MANIFEST_PATH.',
        path: ['EVM_DEPLOYMENT_MANIFEST_PATH'],
      });
    }

    const nearWriteConfigurationRequired =
      (environment.DEBTSHIFT_MODE === 'sandbox' && environment.NODE_ENV === 'production') ||
      environment.DEBTSHIFT_MODE === 'testnet' ||
      (environment.DEBTSHIFT_MODE === 'mainnet' && environment.MAINNET_EXECUTION_ENABLED);
    if (
      nearWriteConfigurationRequired &&
      (environment.NEAR_REGISTRY_ACCOUNT.length === 0 ||
        environment.NEAR_REGISTRY_OWNER_ACCOUNT.length === 0 ||
        environment.NEAR_REGISTRY_WASM_SHA256.length === 0 ||
        environment.NEAR_SIGNER_ACCOUNT_ID.length === 0 ||
        environment.NEAR_SIGNER_PRIVATE_KEY.length === 0)
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Hosted sandbox, funded testnet, or mainnet execution requires the expected NEAR registry account, owner, WASM hash, and verifier signer credentials.',
        path: ['NEAR_REGISTRY_ACCOUNT'],
      });
    }

    const nearRegistryConfigurationCount = [
      environment.NEAR_REGISTRY_ACCOUNT,
      environment.NEAR_REGISTRY_OWNER_ACCOUNT,
      environment.NEAR_REGISTRY_WASM_SHA256,
      environment.NEAR_SIGNER_ACCOUNT_ID,
      environment.NEAR_SIGNER_PRIVATE_KEY,
    ].filter((value) => value.length !== 0).length;
    if (nearRegistryConfigurationCount > 0 && nearRegistryConfigurationCount < 5) {
      context.addIssue({
        code: 'custom',
        message:
          'NEAR registry account, owner, WASM hash, signer account, and signer key must be configured together.',
        path: ['NEAR_REGISTRY_ACCOUNT'],
      });
    }
  });

export type DebtShiftEnvironment = z.infer<typeof debtShiftEnvironmentSchema>;

const explicitExecutionConfigurationKeys = [
  'SOURCE_DEPLOYMENT_BLOCK_NUMBER',
  'DESTINATION_DEPLOYMENT_BLOCK_NUMBER',
  'EIP712_VERIFYING_CONTRACT',
  'SOURCE_DEBT_TOKEN_ADDRESS',
  'SOURCE_COLLATERAL_TOKEN_ADDRESS',
  'SOURCE_LENDING_ADDRESS',
  'SOURCE_VAULT_ADDRESS',
  'SOURCE_ESCROW_ADDRESS',
  'SOURCE_ADAPTER_ADDRESS',
  'DESTINATION_DEBT_TOKEN_ADDRESS',
  'DESTINATION_COLLATERAL_TOKEN_ADDRESS',
  'DESTINATION_LENDING_ADDRESS',
  'DESTINATION_ESCROW_ADDRESS',
  'DESTINATION_ADAPTER_ADDRESS',
  'EXECUTOR_ADDRESS',
] as const;

const removedEnvironmentKeys = [
  'DEBTSHIFT_ENV',
  'MAINNET_CANARY_ENABLED',
  'MAINNET_CANARY_ORIGIN_ASSET',
  'MAINNET_CANARY_DESTINATION_ASSET',
  'MAINNET_CANARY_MAX_INPUT_UNITS',
  'MAINNET_CANARY_RECIPIENT',
  'MAINNET_CANARY_REFUND_RECEIVER',
  'LOCAL_EXECUTOR_PRIVATE_KEY',
  'LOCAL_EXECUTOR_ADDRESS',
] as const;

export function parseDebtShiftEnvironment(input: unknown): Readonly<DebtShiftEnvironment> {
  const source = isEnvironmentRecord(input) ? input : {};
  const removed = removedEnvironmentKeys.filter((key) => Object.hasOwn(source, key));
  if (removed.length !== 0) {
    throw new Error(
      `Removed environment configuration is not accepted: ${removed.join(', ')}. Use the four-mode runtime configuration.`,
    );
  }
  const environment = debtShiftEnvironmentSchema.parse(input);
  if (environment.DEBTSHIFT_MODE === 'testnet' || environment.DEBTSHIFT_MODE === 'mainnet') {
    const missing = explicitExecutionConfigurationKeys.filter(
      (key) => typeof source[key] !== 'string' || source[key].trim().length === 0,
    );
    if (missing.length !== 0) {
      throw new Error(
        `${environment.DEBTSHIFT_MODE} requires explicit execution deployment configuration: ${missing.join(', ')}.`,
      );
    }
  }
  return Object.freeze(environment);
}

function isEnvironmentRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export class ExecutionModeDisabledError extends Error {
  override readonly name = 'ExecutionModeDisabledError';
}

/**
 * Guards entry into a workflow that can reserve funds or enqueue chain writes.
 * Contract authorization, policy limits, and pause controls remain independent gates.
 */
export function assertFundedExecutionEnabled(
  environment: Pick<DebtShiftEnvironment, 'DEBTSHIFT_MODE' | 'MAINNET_EXECUTION_ENABLED'>,
): void {
  if (environment.DEBTSHIFT_MODE === 'mainnet-readonly') {
    throw new ExecutionModeDisabledError(
      'Funded execution is unavailable in mainnet-readonly mode.',
    );
  }
  if (environment.DEBTSHIFT_MODE === 'mainnet' && !environment.MAINNET_EXECUTION_ENABLED) {
    throw new ExecutionModeDisabledError(
      'Mainnet execution is disabled by MAINNET_EXECUTION_ENABLED=false.',
    );
  }
}
