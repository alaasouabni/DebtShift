/*
 * Permissions the lending protocols themselves require.
 *
 * The two DebtShift signatures bound what may happen. Some markets need one
 * more thing from the borrower before a module can act for them:
 *
 *   - Morpho Blue has its own authorization, signed as a pair on the
 *     destination chain: one message grants the DebtShift module permission,
 *     the next one removes it;
 *   - a token on the source market may need an ERC-20 approval, which is a
 *     transaction, not a signature.
 *
 * The backend prepares both and says `NONE` when a market needs nothing (the
 * sandbox needs nothing). This module never invents a permission: it only
 * checks, before the wallet is asked, that what the screen describes is
 * exactly what the wallet will be given.
 */

import { encodeFunctionData, erc20Abi } from 'viem';

import type {
  PreparedMigration,
  PreparedSourceLendingAuthorization,
  PreparedTargetLendingAuthorization,
  SignedTargetLendingAuthorization,
  SubmittedSourceLendingAuthorization,
} from '../../lib/api/types';

export type MorphoAuthorization = Extract<
  PreparedTargetLendingAuthorization,
  { kind: 'MORPHO_BLUE' }
>;
export type Erc20Approval = Extract<PreparedSourceLendingAuthorization, { kind: 'ERC20_APPROVAL' }>;

/** What the borrower has provided so far in the lending-permissions step. */
export interface LendingProgress {
  readonly enableSignature?: string | undefined;
  readonly disableSignature?: string | undefined;
  readonly approvalHash?: string | undefined;
  /** Block the approval was mined in. Set only once it is mined and succeeded. */
  readonly approvalBlock?: string | undefined;
}

/**
 * A payload recorded before these fields existed carries neither. That is
 * read as "nothing required", which is what such a payload meant; the backend
 * verifies the submitted value again and rejects it if it disagrees.
 */
export function sourceAuthorizationOf(
  prepared: Pick<PreparedMigration, 'sourceAuthorization'>,
): PreparedSourceLendingAuthorization {
  return prepared.sourceAuthorization ?? { kind: 'NONE' };
}

export function targetAuthorizationOf(
  prepared: Pick<PreparedMigration, 'targetAuthorization'>,
): PreparedTargetLendingAuthorization {
  return prepared.targetAuthorization ?? { kind: 'NONE' };
}

export function needsLendingStep(
  prepared: Pick<PreparedMigration, 'sourceAuthorization' | 'targetAuthorization'>,
): boolean {
  return (
    sourceAuthorizationOf(prepared).kind !== 'NONE' ||
    targetAuthorizationOf(prepared).kind !== 'NONE'
  );
}

/** How many wallet prompts the lending step adds: signatures and transactions. */
export function lendingPromptCount(
  prepared: Pick<PreparedMigration, 'sourceAuthorization' | 'targetAuthorization'>,
): { readonly signatures: number; readonly transactions: number } {
  return {
    signatures: targetAuthorizationOf(prepared).kind === 'MORPHO_BLUE' ? 2 : 0,
    transactions: sourceAuthorizationOf(prepared).kind === 'ERC20_APPROVAL' ? 1 : 0,
  };
}

export function targetIsComplete(
  target: PreparedTargetLendingAuthorization,
  progress: LendingProgress,
): boolean {
  if (target.kind === 'NONE') return true;
  return progress.enableSignature !== undefined && progress.disableSignature !== undefined;
}

/** An approval counts only once it is mined: a pending hash proves nothing. */
export function sourceIsComplete(
  source: PreparedSourceLendingAuthorization,
  progress: LendingProgress,
): boolean {
  if (source.kind === 'NONE') return true;
  return progress.approvalHash !== undefined && progress.approvalBlock !== undefined;
}

export function lendingIsComplete(
  prepared: Pick<PreparedMigration, 'sourceAuthorization' | 'targetAuthorization'>,
  progress: LendingProgress,
): boolean {
  return (
    targetIsComplete(targetAuthorizationOf(prepared), progress) &&
    sourceIsComplete(sourceAuthorizationOf(prepared), progress)
  );
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Why a prepared Morpho pair must not be signed, or `undefined` when it is
 * what the screen says it is: this borrower, one module, permission granted
 * and then removed, back to back, under one deadline.
 */
export function morphoPairProblem(
  authorization: MorphoAuthorization,
  borrower: string,
): string | undefined {
  const { enable, disable, module } = authorization;
  if (!sameAddress(enable.authorizer, borrower) || !sameAddress(disable.authorizer, borrower)) {
    return 'The permission is not issued in the name of the connected account.';
  }
  if (!sameAddress(enable.authorized, module) || !sameAddress(disable.authorized, module)) {
    return 'The permission names a different contract than the module shown.';
  }
  if (enable.isAuthorized !== true || disable.isAuthorized !== false) {
    return 'The pair does not grant the permission and then remove it.';
  }
  if (BigInt(disable.nonce) !== BigInt(enable.nonce) + 1n) {
    return 'The removal does not directly follow the grant.';
  }
  if (enable.deadline !== disable.deadline) {
    return 'The grant and its removal do not share one deadline.';
  }
  return undefined;
}

/**
 * Why a prepared approval must not be sent, or `undefined` when the
 * transaction is exactly `approve(spender, amount)` on the token shown, with
 * no value attached. The calldata is rebuilt here and compared, so the wallet
 * can never be handed something other than what the screen describes.
 */
export function approvalProblem(authorization: Erc20Approval): string | undefined {
  const { transaction, token, spender, amountUnits } = authorization;
  if (!sameAddress(transaction.to, token)) {
    return 'The transaction does not call the token shown.';
  }
  if (transaction.valueUnits !== '0') {
    return 'The transaction attaches value. An approval never does.';
  }
  let expected: string;
  try {
    expected = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [spender as `0x${string}`, BigInt(amountUnits)],
    });
  } catch {
    return 'The approval terms could not be encoded.';
  }
  if (expected.toLowerCase() !== transaction.data.toLowerCase()) {
    return 'The transaction data is not an approval of the amount and spender shown.';
  }
  return undefined;
}

/** The value sent with `execute`. Throws rather than send an incomplete permission. */
export function buildTargetAuthorization(
  target: PreparedTargetLendingAuthorization,
  progress: LendingProgress,
): SignedTargetLendingAuthorization {
  if (target.kind === 'NONE') return { kind: 'NONE' };
  if (progress.enableSignature === undefined || progress.disableSignature === undefined) {
    throw new Error('The Morpho permission pair has not been signed.');
  }
  return {
    ...target,
    enableSignature: progress.enableSignature as `0x${string}`,
    disableSignature: progress.disableSignature as `0x${string}`,
  };
}

export function buildSourceAuthorization(
  source: PreparedSourceLendingAuthorization,
  progress: LendingProgress,
): SubmittedSourceLendingAuthorization {
  if (source.kind === 'NONE') return { kind: 'NONE' };
  if (progress.approvalHash === undefined || progress.approvalBlock === undefined) {
    throw new Error('The token approval has not been mined.');
  }
  return { ...source, transactionHash: progress.approvalHash as `0x${string}` };
}
