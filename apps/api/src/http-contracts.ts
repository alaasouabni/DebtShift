import {
  explainedRouteSchema,
  explanationConfigurationSchema,
  walletRouteAnalysisSchema,
} from '@debtshift/agent';
import {
  commandStatusSchema,
  commandTypeSchema,
  evidenceVerificationStateSchema,
  executionPlanSchema,
  migrationPhaseSchema,
  positionSnapshotSchema,
  preparedSourceLendingAuthorizationSchema,
  preparedTargetLendingAuthorizationSchema,
  providerQuoteSchema,
  signedExecutionPlanSchema,
  signedRefinanceIntentSchema,
  signedTargetLendingAuthorizationSchema,
  submittedSourceLendingAuthorizationSchema,
  evmAddressSchema,
} from '@debtshift/domain';
import { transportQuoteRequestSchema } from '@debtshift/intents';
import type { SchemaObject } from '@nestjs/swagger';
import { z } from 'zod';

export const evmAddressContractSchema = evmAddressSchema.describe(
  'EVM account address. Mixed-case values must have a valid EIP-55 checksum.',
);
export const bytes32ContractSchema = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const bytes32 = bytes32ContractSchema;
const uintString = z.string().regex(/^(0|[1-9][0-9]*)$/);
const dateTime = z.iso.datetime({ offset: true });
const jsonRecord = z.record(z.string(), z.unknown());

export const healthResponseSchema = z
  .object({
    service: z.literal('debtshift-api'),
    status: z.literal('ok'),
    timestamp: dateTime,
  })
  .strict();

export const walletChallengeRequestSchema = z.object({ wallet: evmAddressContractSchema }).strict();

export const walletChallengeResponseSchema = z
  .object({
    challengeId: z.uuid(),
    wallet: evmAddressContractSchema,
    chainId: z.number().int().positive(),
    message: z.string().min(1),
    expiresAt: dateTime,
  })
  .strict();

export const walletChallengeVerificationRequestSchema = z
  .object({
    challengeId: z.uuid(),
    signature: z
      .string()
      .regex(/^0x(?:[0-9a-fA-F]{2})+$/)
      .max(8_194),
  })
  .strict();

export const publicWalletSessionSchema = z
  .object({
    wallet: evmAddressContractSchema,
    chainId: z.number().int().positive(),
    expiresAt: dateTime,
  })
  .strict();

export const walletSessionResponseSchema = z
  .object({ session: publicWalletSessionSchema })
  .strict();

export const walletLogoutResponseSchema = z.object({ revoked: z.literal(true) }).strict();

export const errorResponseSchema = z
  .object({
    statusCode: z.number().int().min(400).max(599),
    message: z.union([z.string(), z.array(z.string())]),
    error: z.string().optional(),
  })
  .passthrough();

export const positionSnapshotListResponseSchema = z.array(positionSnapshotSchema);

const persistedPositionSchema = z
  .object({
    positionId: bytes32,
    walletId: z.uuid(),
    marketPk: z.uuid(),
    protocolPositionId: z.string(),
    latestSnapshotId: bytes32.nullable(),
    active: z.boolean(),
    discoveredAt: dateTime,
    createdAt: dateTime,
    updatedAt: dateTime,
  })
  .strict();

const persistedMarketSchema = z
  .object({
    marketPk: z.uuid(),
    chainId: uintString,
    protocol: z.string(),
    deployment: evmAddressContractSchema,
    marketId: z.string(),
    debtAsset: jsonRecord,
    collateralAsset: jsonRecord,
    enabled: z.boolean(),
    metadata: jsonRecord,
    createdAt: dateTime,
    updatedAt: dateTime,
  })
  .strict();

const persistedPositionSnapshotSchema = z
  .object({
    snapshotId: bytes32,
    positionId: bytes32,
    chainId: uintString,
    blockNumber: uintString,
    blockHash: bytes32,
    debtUnits: uintString,
    collateralUnits: uintString,
    healthFactorWad: uintString.nullable(),
    ltvBps: z.number().int().nullable(),
    payload: jsonRecord,
    rawResponseHash: bytes32,
    observedAt: dateTime,
    createdAt: dateTime,
  })
  .strict();

export const persistedPositionListResponseSchema = z.array(
  z
    .object({
      position: persistedPositionSchema,
      market: persistedMarketSchema,
      snapshot: persistedPositionSnapshotSchema.nullable(),
    })
    .strict(),
);

export const marketListResponseSchema = z.array(persistedMarketSchema);

export const routeAnalysisRequestSchema = z
  .object({
    wallet: evmAddressContractSchema,
    explanation: explanationConfigurationSchema.optional(),
  })
  .strict();

export const routeAnalysisResponseSchema = z
  .object({
    analysis: walletRouteAnalysisSchema,
    explanations: z.array(
      z
        .object({
          sourceSnapshotId: bytes32,
          result: explainedRouteSchema,
        })
        .strict(),
    ),
  })
  .strict();

export const quoteRequestSchema = transportQuoteRequestSchema;
export const quoteResponseSchema = providerQuoteSchema;

export const preparationRequestSchema = z.object({ borrower: evmAddressContractSchema }).strict();

export const preparationResponseSchema = z
  .object({
    execution: z
      .object({
        mode: z.enum(['sandbox', 'testnet', 'mainnet-readonly', 'mainnet']),
        transportProvider: z.enum(['DEBTSHIFT_SIMULATOR', 'NEAR_INTENTS_1CLICK']),
        transportMode: z.enum(['SIMULATED', 'DRY', 'COMMITTED']),
        simulatedTransport: z.boolean(),
        fundedExecutionEnabled: z.boolean(),
        warning: z.string(),
      })
      .strict(),
    verifyingContract: evmAddressContractSchema,
    intent: signedRefinanceIntentSchema.shape.intent,
    intentHash: bytes32,
    plan: executionPlanSchema,
    planHash: bytes32,
    sourceAuthorization: preparedSourceLendingAuthorizationSchema,
    targetAuthorization: preparedTargetLendingAuthorizationSchema,
    quote: providerQuoteSchema,
    sourceSnapshot: positionSnapshotSchema,
    routeAnalysis: routeAnalysisResponseSchema,
  })
  .strict();

export const executeMigrationRequestSchema = z
  .object({
    signedIntent: signedRefinanceIntentSchema,
    signedPlan: signedExecutionPlanSchema,
    quote: providerQuoteSchema,
    sourceSnapshot: positionSnapshotSchema,
    sourceAuthorization: submittedSourceLendingAuthorizationSchema,
    targetAuthorization: signedTargetLendingAuthorizationSchema,
  })
  .strict();

export const executeMigrationResponseSchema = z
  .object({
    created: z.boolean(),
    migrationId: bytes32,
    initialCommandId: bytes32.optional(),
  })
  .strict();

const migrationRowSchema = z
  .object({
    migrationId: bytes32,
    intentHash: bytes32,
    planHash: bytes32,
    quoteHash: bytes32,
    phase: migrationPhaseSchema,
    version: z.number().int().nonnegative(),
    expiresAt: dateTime,
    completedAt: dateTime.nullable(),
    createdAt: dateTime,
    updatedAt: dateTime,
  })
  .strict();

export const migrationEventSchema = z
  .object({
    eventId: bytes32,
    migrationId: bytes32,
    sequence: z.number().int().positive(),
    type: z.string(),
    phase: migrationPhaseSchema,
    actor: z.string(),
    payload: jsonRecord,
    payloadHash: bytes32,
    observedAt: dateTime,
    createdAt: dateTime,
  })
  .strict();

const commandRowSchema = z
  .object({
    commandId: bytes32,
    migrationId: bytes32,
    type: commandTypeSchema,
    idempotencyKey: z.string(),
    status: commandStatusSchema,
    logicalAttempt: z.number().int().nonnegative(),
    payload: jsonRecord,
    payloadHash: bytes32,
    lastError: z.string().nullable(),
    availableAt: dateTime,
    createdAt: dateTime,
    updatedAt: dateTime,
  })
  .strict();

export const evidenceRowSchema = z
  .object({
    evidenceId: bytes32,
    migrationId: bytes32,
    type: z.string(),
    schemaVersion: z.number().int().positive(),
    provider: z.string(),
    network: z.string(),
    chainId: uintString.nullable(),
    blockNumber: uintString.nullable(),
    blockHash: bytes32.nullable(),
    transactionHash: bytes32.nullable(),
    logIndex: z.number().int().nonnegative().nullable(),
    providerReference: z.string().nullable(),
    rawObservationHash: bytes32,
    normalizedPayload: jsonRecord,
    observedAt: dateTime,
    verificationState: evidenceVerificationStateSchema,
    verificationMethod: z.string(),
    verifierVersion: z.string(),
    supersedesEvidenceId: bytes32.nullable(),
    createdAt: dateTime,
  })
  .strict();

const ledgerEntryRowSchema = z
  .object({
    entryId: bytes32,
    migrationId: bytes32,
    sequence: z.number().int().positive(),
    componentCode: z.string(),
    componentId: z.string(),
    evidenceId: bytes32,
    basis: z.string(),
    chainId: uintString,
    token: evmAddressContractSchema,
    amountUnits: uintString,
    debitParty: z.string(),
    creditParty: z.string(),
    category: z.string(),
    transactionReference: z.string().nullable(),
    createdAt: dateTime,
  })
  .strict();

const reservationRowSchema = z
  .object({
    reservationId: bytes32,
    migrationId: bytes32,
    reservationHash: bytes32,
    provider: evmAddressContractSchema,
    chainId: uintString,
    asset: evmAddressContractSchema,
    principalUnits: uintString,
    feeCapUnits: uintString,
    status: z.enum(['PENDING', 'ACTIVE', 'CONSUMED', 'DRAWN', 'SETTLED', 'RELEASED', 'EXPIRED']),
    expiresAt: dateTime,
    createdAt: dateTime,
    updatedAt: dateTime,
  })
  .strict();

const recoveryCaseRowSchema = z
  .object({
    recoveryId: bytes32,
    migrationId: bytes32,
    policy: z.string(),
    status: z.string(),
    reason: z.string(),
    residualAssets: z.array(jsonRecord),
    openedAt: dateTime,
    resolvedAt: dateTime.nullable(),
    createdAt: dateTime,
    updatedAt: dateTime,
  })
  .strict();

export const migrationDetailsResponseSchema = z
  .object({
    migration: migrationRowSchema,
    evidence: z.array(evidenceRowSchema),
    events: z.array(migrationEventSchema),
    commands: z.array(commandRowSchema),
    ledger: z.array(ledgerEntryRowSchema),
    reservations: z.array(reservationRowSchema),
    recoveryCases: z.array(recoveryCaseRowSchema),
  })
  .strict();

export const migrationEventsResponseSchema = z.array(migrationEventSchema);
export const migrationEvidenceResponseSchema = z.array(evidenceRowSchema);

/** Convert a runtime Zod contract into the JSON Schema subset accepted by OpenAPI. */
export function toOpenApiSchema(schema: z.ZodType): SchemaObject {
  const generated = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io: 'input',
    unrepresentable: 'any',
  });
  const { $schema: _dialect, ...openApiSchema } = generated;
  return openApiSchema as SchemaObject;
}
