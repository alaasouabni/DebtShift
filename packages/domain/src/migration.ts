import { z } from 'zod';

import { tokenReferenceSchema, transportProviderSchema } from './assets.js';
import {
  baseUnitAmountSchema,
  bytes32Schema,
  canonicalTextSchema,
  chainIdSchema,
  evmAddressSchema,
  isoTimestampSchema,
  uint64StringSchema,
} from './primitives.js';

export const migrationPhaseSchema = z.enum([
  'DRAFT',
  'QUOTED',
  'AUTHORIZED',
  'RESERVED',
  'SOURCE_CLOSED',
  'ROUTING',
  'DEST_FUNDED',
  'TARGET_OPEN',
  'SETTLED',
  'COMPLETED',
  'RECOVERY',
  'FAILED_SAFE',
  'REQUOTE_REQUIRED',
  'EXPIRED',
]);

export const evidenceTypeSchema = z.enum([
  'SOURCE_POSITION_SNAPSHOT',
  'ROUTE_QUOTE',
  'INTENT_AUTHORIZATION',
  'EXECUTION_PLAN_AUTHORIZATION',
  'FINANCING_FEASIBILITY',
  'FINANCING_REVALIDATION',
  'SUPPLEMENTARY_FUNDING',
  'LIQUIDITY_RESERVATION',
  'SOURCE_CLOSE',
  'TRANSPORT_ORIGIN',
  'TRANSPORT_DESTINATION',
  'TARGET_POSITION',
  'LIQUIDITY_SETTLEMENT',
  'LEDGER_RECONCILIATION',
  'NEAR_RECEIPT',
  'MIGRATION_EXPIRED',
  'REQUOTE_REQUIRED',
  'RECOVERY_OPENED',
  'RECOVERY_COMPLETED',
]);

export const evidenceVerificationStateSchema = z.enum([
  'PROVISIONAL',
  'CONFIRMED',
  'FINALIZED',
  'RETRACTED',
  'REJECTED',
]);

export const evidenceSchema = z
  .object({
    evidenceId: bytes32Schema,
    migrationId: bytes32Schema,
    type: evidenceTypeSchema,
    schemaVersion: z.number().int().positive(),
    provider: canonicalTextSchema,
    network: canonicalTextSchema,
    chainId: chainIdSchema.optional(),
    blockNumber: uint64StringSchema.optional(),
    blockHash: bytes32Schema.optional(),
    transactionHash: bytes32Schema.optional(),
    logIndex: z.number().int().min(0).optional(),
    providerReference: canonicalTextSchema.optional(),
    rawObservationHash: bytes32Schema,
    normalizedPayload: z.record(z.string(), z.unknown()),
    observedAt: isoTimestampSchema,
    verificationState: evidenceVerificationStateSchema,
    verificationMethod: canonicalTextSchema,
    verifierVersion: canonicalTextSchema,
    supersedesEvidenceId: bytes32Schema.optional(),
  })
  .strict()
  .superRefine((evidence, context) => {
    const blockFields = [evidence.blockNumber, evidence.blockHash];
    if (
      blockFields.some((value) => value !== undefined) &&
      blockFields.some((value) => value === undefined)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Block number and block hash must be recorded together.',
      });
    }

    if (evidence.logIndex !== undefined && evidence.transactionHash === undefined) {
      context.addIssue({
        code: 'custom',
        path: ['logIndex'],
        message: 'A log index requires a transaction hash.',
      });
    }
  });

export const commandTypeSchema = z.enum([
  'RESERVE_LIQUIDITY',
  'CLOSE_SOURCE',
  'DISPATCH_TRANSPORT',
  'VERIFY_DESTINATION',
  'OPEN_TARGET',
  'SETTLE_LIQUIDITY',
  'FINALIZE_NEAR_RECEIPT',
  'EXECUTE_RECOVERY',
]);

export const commandStatusSchema = z.enum([
  'PENDING',
  'DISPATCHED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED_RETRYABLE',
  'FAILED_TERMINAL',
  'CANCELLED',
]);

export const migrationSchema = z
  .object({
    migrationId: bytes32Schema,
    intentHash: bytes32Schema,
    executionPlanHash: bytes32Schema,
    quoteHash: bytes32Schema,
    borrower: evmAddressSchema,
    phase: migrationPhaseSchema,
    version: z.number().int().nonnegative(),
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();

export const commandSchema = z
  .object({
    commandId: bytes32Schema,
    migrationId: bytes32Schema,
    type: commandTypeSchema,
    idempotencyKey: canonicalTextSchema,
    status: commandStatusSchema,
    logicalAttempt: z.number().int().nonnegative(),
    payloadHash: bytes32Schema,
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
  })
  .strict();

export const transportLegSchema = z
  .object({
    migrationId: bytes32Schema,
    legIndex: z.number().int().nonnegative(),
    provider: transportProviderSchema,
    quoteHash: bytes32Schema,
    inputAsset: tokenReferenceSchema,
    outputAsset: tokenReferenceSchema,
    inputUnits: baseUnitAmountSchema,
    minimumOutputUnits: baseUnitAmountSchema,
    providerState: canonicalTextSchema,
    depositAddress: canonicalTextSchema.optional(),
    refundTransactionHash: bytes32Schema.optional(),
  })
  .strict();

export const ledgerEntrySchema = z
  .object({
    entryId: bytes32Schema,
    migrationId: bytes32Schema,
    sequence: z.number().int().positive(),
    chainId: chainIdSchema,
    token: evmAddressSchema,
    amountUnits: baseUnitAmountSchema,
    debitParty: canonicalTextSchema,
    creditParty: canonicalTextSchema,
    category: z.enum(['PRINCIPAL', 'FEE', 'COLLATERAL', 'REFUND', 'RESIDUAL', 'SHORTFALL']),
    transactionReference: canonicalTextSchema.optional(),
    createdAt: isoTimestampSchema,
  })
  .strict()
  .refine((entry) => entry.debitParty !== entry.creditParty, {
    message: 'A ledger entry must move value between distinct parties.',
  });

export const auditEventSchema = z
  .object({
    eventId: bytes32Schema,
    migrationId: bytes32Schema,
    sequence: z.number().int().positive(),
    type: canonicalTextSchema,
    phase: migrationPhaseSchema,
    payload: z.record(z.string(), z.unknown()),
    observedAt: isoTimestampSchema,
  })
  .strict();

export type MigrationPhase = z.infer<typeof migrationPhaseSchema>;
export type EvidenceType = z.infer<typeof evidenceTypeSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;
export type Migration = z.infer<typeof migrationSchema>;
export type Command = z.infer<typeof commandSchema>;
export type LedgerEntry = z.infer<typeof ledgerEntrySchema>;
export type AuditEvent = z.infer<typeof auditEventSchema>;
