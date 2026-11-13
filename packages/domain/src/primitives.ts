import { getAddress, isAddress, isHex, size } from 'viem';
import type { Address, Hex } from 'viem';
import { z } from 'zod';

function uintString(bits: number, allowZero: boolean) {
  const maximum = (1n << BigInt(bits)) - 1n;
  const canonicalUnsignedInteger = /^(0|[1-9]\d*)$/;

  return z
    .string()
    .regex(canonicalUnsignedInteger, 'Expected an unsigned base-10 integer without leading zeroes.')
    .refine((value) => allowZero || value !== '0', 'Expected a value greater than zero.')
    .refine(
      (value) => !canonicalUnsignedInteger.test(value) || BigInt(value) <= maximum,
      `Value exceeds uint${bits}.`,
    );
}

export const chainIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const basisPointsSchema = z.number().int().min(0).max(10_000);
export const nonNegativeBasisPointsSchema = z.number().int().min(0).max(1_000_000);
export const tokenDecimalsSchema = z.number().int().min(0).max(36);

export const baseUnitAmountSchema = uintString(256, true).brand<'BaseUnitAmount'>();
export const positiveBaseUnitAmountSchema = uintString(
  256,
  false,
).brand<'PositiveBaseUnitAmount'>();
export const uint64StringSchema = uintString(64, true).brand<'Uint64String'>();
export const positiveUint64StringSchema = uintString(64, false).brand<'PositiveUint64String'>();
export const nonceSchema = uintString(256, true).brand<'Nonce'>();

export const evmAddressSchema = z
  .string()
  .refine((value) => isAddress(value, { strict: false }), 'Expected a valid EVM address.')
  .transform((value) => getAddress(value)) as z.ZodType<Address>;

export const nearAccountIdSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/, 'Expected a canonical lowercase NEAR account ID.');

export const hexSchema = z
  .string()
  .refine(
    (value) => isHex(value, { strict: true }),
    'Expected a 0x-prefixed hex value.',
  ) as z.ZodType<Hex>;

export const bytes32Schema = hexSchema
  .refine((value) => size(value) === 32, 'Expected exactly 32 bytes.')
  .transform((value) => value.toLowerCase() as Hex);

export const signatureSchema = hexSchema.refine(
  (value) => size(value) === 64 || size(value) === 65,
  'Expected a 64-byte compact or 65-byte EVM signature.',
);

export const isoTimestampSchema = z.iso.datetime({ offset: true });
export const canonicalTextSchema = z.string().trim().min(1).max(512);
export const identifierTextSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,254}$/);

export type ChainId = z.infer<typeof chainIdSchema>;
export type BaseUnitAmount = z.infer<typeof baseUnitAmountSchema>;
export type PositiveBaseUnitAmount = z.infer<typeof positiveBaseUnitAmountSchema>;
export type Uint64String = z.infer<typeof uint64StringSchema>;

export function toBaseUnitBigInt(value: BaseUnitAmount | PositiveBaseUnitAmount): bigint {
  return BigInt(value);
}
