import { verifyTypedData } from 'viem';
import type { Address, Hex } from 'viem';

import type {
  ExecutionPlan,
  RefinanceIntent,
  SignedExecutionPlan,
  SignedRefinanceIntent,
} from './authorization.js';
import {
  assertExecutionPlanIntegrity,
  getExecutionPlanTypedData,
  getRefinanceIntentTypedData,
  hashExecutionPlan,
  hashRefinanceIntent,
} from './hashing.js';

export const EIP1271_MAGIC_VALUE = '0x1626ba7e' as const;

export interface Eip1271Reader {
  readIsValidSignature(
    wallet: Address,
    digest: Hex,
    signature: Hex,
    blockNumber?: bigint,
  ): Promise<Hex>;
}

export async function verifyRefinanceIntentEoaSignature(
  intent: RefinanceIntent,
  verifyingContract: Address,
  signature: Hex,
): Promise<boolean> {
  return verifyTypedData({
    address: intent.borrower,
    signature,
    ...getRefinanceIntentTypedData(intent, verifyingContract),
  });
}

export async function verifyExecutionPlanEoaSignature(
  plan: ExecutionPlan,
  verifyingContract: Address,
  signature: Hex,
): Promise<boolean> {
  assertExecutionPlanIntegrity(plan);
  return verifyTypedData({
    address: plan.borrower,
    signature,
    ...getExecutionPlanTypedData(plan, verifyingContract),
  });
}

export async function verifyEip1271Signature(
  reader: Eip1271Reader,
  wallet: Address,
  digest: Hex,
  signature: Hex,
  blockNumber?: bigint,
): Promise<boolean> {
  const result = await reader.readIsValidSignature(wallet, digest, signature, blockNumber);
  return result.slice(0, 10).toLowerCase() === EIP1271_MAGIC_VALUE;
}

export async function verifySignedRefinanceIntent(
  signed: SignedRefinanceIntent,
  verifyingContract: Address,
  eip1271Reader?: Eip1271Reader,
): Promise<boolean> {
  const digest = hashRefinanceIntent(signed.intent, verifyingContract);
  if (digest !== signed.intentHash) return false;

  if (signed.intent.accountType === 'EOA') {
    return verifyRefinanceIntentEoaSignature(signed.intent, verifyingContract, signed.signature);
  }

  if (eip1271Reader === undefined) return false;
  return verifyEip1271Signature(eip1271Reader, signed.intent.borrower, digest, signed.signature);
}

export async function verifySignedExecutionPlan(
  signed: SignedExecutionPlan,
  accountType: 'EOA' | 'EIP1271',
  verifyingContract: Address,
  eip1271Reader?: Eip1271Reader,
): Promise<boolean> {
  assertExecutionPlanIntegrity(signed.plan);
  const digest = hashExecutionPlan(signed.plan, verifyingContract);
  if (digest !== signed.planHash) return false;

  if (accountType === 'EOA') {
    return verifyExecutionPlanEoaSignature(signed.plan, verifyingContract, signed.signature);
  }

  if (eip1271Reader === undefined) return false;
  return verifyEip1271Signature(eip1271Reader, signed.plan.borrower, digest, signed.signature);
}
