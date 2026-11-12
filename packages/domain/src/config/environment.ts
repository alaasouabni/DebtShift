import { z } from 'zod';

import { evmAddressSchema } from '../primitives.js';
import { parseLiveMarketConfiguration } from './live-market.js';

const booleanString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

const optionalUrl = z.union([z.url(), z.literal('')]).default('');
const optionalString = z.string().default('');
const optionalPrivateKey = z
  .union([z.string().regex(/^0x[0-9a-fA-F]{64}$/), z.literal('')])
  .default('');

export const debtShiftEnvironmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DEBTSHIFT_ENV: z
      .enum(['local', 'ci', 'testnet', 'mainnet-readonly', 'mainnet-canary', 'mainnet-controlled'])
      .default('local'),
    MARKET_DATA_PROVIDER: z.enum(['SIMULATOR', 'LIVE_READ_ONLY', 'DISABLED']).default('SIMULATOR'),
    LIVE_MARKET_CONFIG_JSON: optionalString,
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
    SOURCE_FINALITY_CONFIRMATIONS: z.coerce.number().int().min(1).max(2_048).default(1),
    DESTINATION_CHAIN_ID: z.coerce.number().int().positive().default(31_338),
    DESTINATION_RPC_URL: z.url().default('http://localhost:8546'),
    DESTINATION_FINALITY_CONFIRMATIONS: z.coerce.number().int().min(1).max(2_048).default(1),
    EIP712_VERIFYING_CONTRACT: evmAddressSchema.default(
      '0x5fc8d32690cc91d4c39d9d3abcbd16989f875707',
    ),
    LOCAL_EXECUTOR_PRIVATE_KEY: optionalPrivateKey,
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
    LOCAL_EXECUTOR_ADDRESS: evmAddressSchema.default('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'),
    TRANSPORT_PROVIDER: z
      .enum(['DEBTSHIFT_SIMULATOR', 'NEAR_INTENTS_1CLICK'])
      .default('DEBTSHIFT_SIMULATOR'),
    INTENTS_MODE: z
      .enum(['simulated', 'mainnet-readonly', 'mainnet-canary', 'mainnet-controlled'])
      .default('simulated'),
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
    NEAR_NETWORK: z.enum(['sandbox', 'testnet', 'mainnet']).default('testnet'),
    NEAR_RPC_URL: z.url().default('https://test.rpc.fastnear.com'),
    NEAR_REGISTRY_ACCOUNT: optionalString,
    AGENT_MODE: z.enum(['DETERMINISTIC', 'LOCAL_AI', 'USER_API']).default('DETERMINISTIC'),
    OLLAMA_BASE_URL: z.url().default('http://127.0.0.1:11434'),
    OLLAMA_MODEL: z.string().min(1).default('qwen3.5:4b'),
    ALLOW_CUSTOM_AI_ENDPOINTS: booleanString,
    MAINNET_CANARY_ENABLED: booleanString,
    MAINNET_CANARY_ORIGIN_ASSET: optionalString,
    MAINNET_CANARY_DESTINATION_ASSET: optionalString,
    MAINNET_CANARY_MAX_INPUT_UNITS: z.string().regex(/^\d+$/).default('0'),
    MAINNET_CANARY_RECIPIENT: optionalString,
    MAINNET_CANARY_REFUND_RECEIVER: optionalString,
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    OTEL_EXPORTER_OTLP_ENDPOINT: optionalUrl,
  })
  .superRefine((environment, context) => {
    const simulatedEnvironment = ['local', 'ci', 'testnet'].includes(environment.DEBTSHIFT_ENV);

    if (environment.INTENTS_RETRY_MAX_DELAY_MS < environment.INTENTS_RETRY_BASE_DELAY_MS) {
      context.addIssue({
        code: 'custom',
        message: '1Click maximum retry delay cannot be lower than its base retry delay.',
        path: ['INTENTS_RETRY_MAX_DELAY_MS'],
      });
    }

    if (simulatedEnvironment && environment.MARKET_DATA_PROVIDER !== 'SIMULATOR') {
      context.addIssue({
        code: 'custom',
        message: 'Local, CI, and testnet environments require simulator market data.',
        path: ['MARKET_DATA_PROVIDER'],
      });
    }

    if (environment.MARKET_DATA_PROVIDER === 'LIVE_READ_ONLY') {
      try {
        parseLiveMarketConfiguration(environment.LIVE_MARKET_CONFIG_JSON);
      } catch (error) {
        context.addIssue({
          code: 'custom',
          message: error instanceof Error ? error.message : 'Live market configuration is invalid.',
          path: ['LIVE_MARKET_CONFIG_JSON'],
        });
      }
      if (environment.INTENTS_AUTH_TOKEN.length === 0) {
        context.addIssue({
          code: 'custom',
          message: 'Live read-only quotes require an INTENTS_AUTH_TOKEN.',
          path: ['INTENTS_AUTH_TOKEN'],
        });
      }
    }

    if (
      simulatedEnvironment &&
      (environment.TRANSPORT_PROVIDER !== 'DEBTSHIFT_SIMULATOR' ||
        environment.INTENTS_MODE !== 'simulated')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Local, CI, and testnet environments require the DebtShift simulator.',
        path: ['INTENTS_MODE'],
      });
    }

    if (
      environment.DEBTSHIFT_ENV === 'mainnet-readonly' &&
      (environment.TRANSPORT_PROVIDER !== 'NEAR_INTENTS_1CLICK' ||
        environment.INTENTS_MODE !== 'mainnet-readonly' ||
        environment.MARKET_DATA_PROVIDER !== 'LIVE_READ_ONLY')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Mainnet read-only mode must use live market data and 1Click dry quotes only.',
        path: ['INTENTS_MODE'],
      });
    }

    if (environment.MAINNET_CANARY_ENABLED && environment.DEBTSHIFT_ENV !== 'mainnet-canary') {
      context.addIssue({
        code: 'custom',
        message: 'The mainnet canary capability is only valid in the mainnet-canary environment.',
        path: ['MAINNET_CANARY_ENABLED'],
      });
    }

    if (environment.DEBTSHIFT_ENV === 'mainnet-canary') {
      const configured =
        environment.MAINNET_CANARY_ENABLED &&
        environment.MARKET_DATA_PROVIDER === 'DISABLED' &&
        environment.TRANSPORT_PROVIDER === 'NEAR_INTENTS_1CLICK' &&
        environment.INTENTS_MODE === 'mainnet-canary' &&
        BigInt(environment.MAINNET_CANARY_MAX_INPUT_UNITS) > 0n &&
        environment.MAINNET_CANARY_ORIGIN_ASSET.length > 0 &&
        environment.MAINNET_CANARY_DESTINATION_ASSET.length > 0 &&
        environment.MAINNET_CANARY_RECIPIENT.length > 0 &&
        environment.MAINNET_CANARY_REFUND_RECEIVER.length > 0;

      if (!configured) {
        context.addIssue({
          code: 'custom',
          message:
            'Mainnet canary mode requires disabled lending data and an enabled, capped, fully allowlisted route.',
          path: ['MAINNET_CANARY_ENABLED'],
        });
      }
    }

    if (environment.DEBTSHIFT_ENV === 'mainnet-controlled') {
      context.addIssue({
        code: 'custom',
        message: 'General funded mainnet refinancing is disabled in this release.',
        path: ['DEBTSHIFT_ENV'],
      });
    }
  });

export type DebtShiftEnvironment = z.infer<typeof debtShiftEnvironmentSchema>;

export function parseDebtShiftEnvironment(input: unknown): Readonly<DebtShiftEnvironment> {
  return Object.freeze(debtShiftEnvironmentSchema.parse(input));
}
