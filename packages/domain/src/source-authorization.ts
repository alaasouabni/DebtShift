import { z } from 'zod';

import {
  bytes32Schema,
  chainIdSchema,
  evmAddressSchema,
  positiveBaseUnitAmountSchema,
  uint64StringSchema,
} from './primitives.js';

const transactionDataSchema = z.string().regex(/^0x(?:[0-9a-fA-F]{2})+$/);

const noSourceAuthorizationSchema = z.object({ kind: z.literal('NONE') }).strict();

const erc20ApprovalObjectSchema = z.object({
  kind: z.literal('ERC20_APPROVAL'),
  chainId: chainIdSchema,
  token: evmAddressSchema,
  spender: evmAddressSchema,
  amountUnits: positiveBaseUnitAmountSchema,
  transaction: z
    .object({
      to: evmAddressSchema,
      data: transactionDataSchema,
      valueUnits: z.literal('0'),
    })
    .strict(),
});

const erc20ApprovalSchema = erc20ApprovalObjectSchema
  .strict()
  .refine((authorization) => authorization.token === authorization.transaction.to, {
    path: ['transaction', 'to'],
    message: 'The approval transaction must call the authorized token.',
  });

export const preparedSourceLendingAuthorizationSchema = z.discriminatedUnion('kind', [
  noSourceAuthorizationSchema,
  erc20ApprovalSchema,
]);

export const submittedSourceLendingAuthorizationSchema = z.discriminatedUnion('kind', [
  noSourceAuthorizationSchema,
  erc20ApprovalObjectSchema
    .extend({ transactionHash: bytes32Schema })
    .strict()
    .refine((authorization) => authorization.token === authorization.transaction.to, {
      path: ['transaction', 'to'],
      message: 'The approval transaction must call the authorized token.',
    }),
]);

export const persistedSourceLendingAuthorizationSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('NONE'),
      authorization: noSourceAuthorizationSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('ERC20_APPROVAL'),
      authorization: erc20ApprovalObjectSchema
        .extend({ transactionHash: bytes32Schema })
        .strict()
        .refine((authorization) => authorization.token === authorization.transaction.to, {
          path: ['transaction', 'to'],
          message: 'The approval transaction must call the authorized token.',
        }),
      blockNumber: uint64StringSchema,
      blockHash: bytes32Schema,
    })
    .strict(),
]);

export type PreparedSourceLendingAuthorization = z.infer<
  typeof preparedSourceLendingAuthorizationSchema
>;
export type SubmittedSourceLendingAuthorization = z.infer<
  typeof submittedSourceLendingAuthorizationSchema
>;
export type PersistedSourceLendingAuthorization = z.infer<
  typeof persistedSourceLendingAuthorizationSchema
>;
