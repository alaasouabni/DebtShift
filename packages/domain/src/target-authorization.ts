import { size } from 'viem';
import { z } from 'zod';

import {
  chainIdSchema,
  evmAddressSchema,
  hexSchema,
  nonceSchema,
  positiveUint64StringSchema,
} from './primitives.js';

export const morphoAuthorizationSchema = z
  .object({
    authorizer: evmAddressSchema,
    authorized: evmAddressSchema,
    isAuthorized: z.boolean(),
    nonce: nonceSchema,
    deadline: positiveUint64StringSchema,
  })
  .strict();

const morphoAuthorizationPairFields = {
  chainId: chainIdSchema,
  morpho: evmAddressSchema,
  module: evmAddressSchema,
  enable: morphoAuthorizationSchema,
  disable: morphoAuthorizationSchema,
} as const;

export const preparedTargetLendingAuthorizationSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('NONE') }).strict(),
    z
      .object({
        kind: z.literal('MORPHO_BLUE'),
        ...morphoAuthorizationPairFields,
      })
      .strict(),
  ])
  .superRefine(assertMorphoPair);

const morphoSignatureSchema = hexSchema.refine(
  (value) => size(value) === 65,
  'Morpho authorization requires a 65-byte EVM signature.',
);

export const signedTargetLendingAuthorizationSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('NONE') }).strict(),
    z
      .object({
        kind: z.literal('MORPHO_BLUE'),
        ...morphoAuthorizationPairFields,
        enableSignature: morphoSignatureSchema,
        disableSignature: morphoSignatureSchema,
      })
      .strict(),
  ])
  .superRefine(assertMorphoPair);

export const persistedTargetLendingAuthorizationSchema = z
  .object({
    authorization: signedTargetLendingAuthorizationSchema,
    encodedAuthorization: hexSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const encodedSize = size(value.encodedAuthorization);
    if (
      (value.authorization.kind === 'NONE' && encodedSize !== 0) ||
      (value.authorization.kind === 'MORPHO_BLUE' && encodedSize === 0)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Encoded target authorization does not match its authorization kind.',
      });
    }
  });

export const morphoAuthorizationTypes = {
  Authorization: [
    { name: 'authorizer', type: 'address' },
    { name: 'authorized', type: 'address' },
    { name: 'isAuthorized', type: 'bool' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

export type PreparedTargetLendingAuthorization = z.infer<
  typeof preparedTargetLendingAuthorizationSchema
>;
export type SignedTargetLendingAuthorization = z.infer<
  typeof signedTargetLendingAuthorizationSchema
>;
export type PersistedTargetLendingAuthorization = z.infer<
  typeof persistedTargetLendingAuthorizationSchema
>;

export function getMorphoAuthorizationTypedData(
  authorization: Extract<PreparedTargetLendingAuthorization, { kind: 'MORPHO_BLUE' }>,
  side: 'enable' | 'disable',
) {
  const message = authorization[side];
  return {
    domain: {
      chainId: authorization.chainId,
      verifyingContract: authorization.morpho,
    },
    types: morphoAuthorizationTypes,
    primaryType: 'Authorization',
    message: {
      ...message,
      nonce: BigInt(message.nonce),
      deadline: BigInt(message.deadline),
    },
  } as const;
}

function assertMorphoPair(
  value: PreparedTargetLendingAuthorization | SignedTargetLendingAuthorization,
  context: z.RefinementCtx,
): void {
  if (value.kind !== 'MORPHO_BLUE') return;
  const matches =
    value.enable.authorizer === value.disable.authorizer &&
    value.enable.authorized === value.module &&
    value.disable.authorized === value.module &&
    value.enable.isAuthorized &&
    !value.disable.isAuthorized &&
    BigInt(value.disable.nonce) === BigInt(value.enable.nonce) + 1n &&
    value.enable.deadline === value.disable.deadline;
  if (!matches) {
    context.addIssue({
      code: 'custom',
      message: 'Morpho authorization must be a consecutive enable/disable pair for one module.',
    });
  }
}
