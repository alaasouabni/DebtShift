import { encodeFunctionData, erc20Abi } from 'viem';
import { describe, expect, it } from 'vitest';

import type { PreparedMigration } from '../../lib/api/types';
import fixture from '../../lib/demo/recordings/prepare.json' with { type: 'json' };
import {
  approvalProblem,
  buildSourceAuthorization,
  buildTargetAuthorization,
  lendingIsComplete,
  lendingPromptCount,
  morphoPairProblem,
  needsLendingStep,
  sourceAuthorizationOf,
  sourceIsComplete,
  targetAuthorizationOf,
  targetIsComplete,
  type Erc20Approval,
  type MorphoAuthorization,
} from './lending-authorization';

const prepared = fixture as unknown as PreparedMigration;
const BORROWER = prepared.plan.borrower;
const MODULE = '0x00000000000000000000000000000000000000aa';
const SPENDER = '0x00000000000000000000000000000000000000bb';
const TOKEN = prepared.plan.sourceCollateralAsset.address;
const SIGNATURE = `0x${'11'.repeat(65)}`;
const HASH = `0x${'22'.repeat(32)}`;

function morpho(overrides: Partial<MorphoAuthorization> = {}): MorphoAuthorization {
  return {
    kind: 'MORPHO_BLUE',
    chainId: 31338,
    morpho: '0x00000000000000000000000000000000000000cc',
    module: MODULE,
    enable: {
      authorizer: BORROWER,
      authorized: MODULE,
      isAuthorized: true,
      nonce: '4',
      deadline: prepared.plan.deadline,
    },
    disable: {
      authorizer: BORROWER,
      authorized: MODULE,
      isAuthorized: false,
      nonce: '5',
      deadline: prepared.plan.deadline,
    },
    ...overrides,
  } as MorphoAuthorization;
}

function approval(overrides: Partial<Erc20Approval> = {}): Erc20Approval {
  const amountUnits = '10000000000000000000';
  return {
    kind: 'ERC20_APPROVAL',
    chainId: 31337,
    token: TOKEN,
    spender: SPENDER,
    amountUnits,
    transaction: {
      to: TOKEN,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [SPENDER, BigInt(amountUnits)],
      }),
      valueUnits: '0',
    },
    ...overrides,
  } as Erc20Approval;
}

describe('what the recorded sandbox route needs', () => {
  it('needs no lending permission and adds no step', () => {
    expect(sourceAuthorizationOf(prepared).kind).toBe('NONE');
    expect(targetAuthorizationOf(prepared).kind).toBe('NONE');
    expect(needsLendingStep(prepared)).toBe(false);
    expect(lendingIsComplete(prepared, {})).toBe(true);
  });

  it('sends NONE for both, which the backend requires to be present', () => {
    expect(buildSourceAuthorization(sourceAuthorizationOf(prepared), {})).toEqual({ kind: 'NONE' });
    expect(buildTargetAuthorization(targetAuthorizationOf(prepared), {})).toEqual({ kind: 'NONE' });
  });

  it('reads a payload recorded before these fields existed as needing nothing', () => {
    expect(needsLendingStep({})).toBe(false);
    expect(sourceAuthorizationOf({})).toEqual({ kind: 'NONE' });
    expect(targetAuthorizationOf({})).toEqual({ kind: 'NONE' });
  });
});

describe('a route that needs permissions', () => {
  const route = { sourceAuthorization: approval(), targetAuthorization: morpho() };

  it('adds the step and counts its wallet prompts', () => {
    expect(needsLendingStep(route)).toBe(true);
    expect(lendingPromptCount(route)).toEqual({ signatures: 2, transactions: 1 });
  });

  it('is complete only with both Morpho signatures and a mined approval', () => {
    expect(lendingIsComplete(route, {})).toBe(false);
    expect(lendingIsComplete(route, { enableSignature: SIGNATURE })).toBe(false);
    expect(
      lendingIsComplete(route, { enableSignature: SIGNATURE, disableSignature: SIGNATURE }),
    ).toBe(false);
    expect(
      lendingIsComplete(route, {
        enableSignature: SIGNATURE,
        disableSignature: SIGNATURE,
        approvalHash: HASH,
        approvalBlock: '12',
      }),
    ).toBe(true);
  });

  it('does not count an approval that was sent but not mined', () => {
    expect(sourceIsComplete(approval(), { approvalHash: HASH })).toBe(false);
    expect(sourceIsComplete(approval(), { approvalHash: HASH, approvalBlock: '12' })).toBe(true);
  });

  it('does not count half a Morpho pair', () => {
    expect(targetIsComplete(morpho(), { enableSignature: SIGNATURE })).toBe(false);
    expect(targetIsComplete(morpho(), { disableSignature: SIGNATURE })).toBe(false);
  });

  it('refuses to build an incomplete permission instead of sending one', () => {
    expect(() => buildTargetAuthorization(morpho(), { enableSignature: SIGNATURE })).toThrow();
    expect(() => buildSourceAuthorization(approval(), { approvalHash: HASH })).toThrow();
  });

  it('sends the prepared permission unchanged, plus what the borrower provided', () => {
    const target = morpho();
    const builtTarget = buildTargetAuthorization(target, {
      enableSignature: SIGNATURE,
      disableSignature: SIGNATURE,
    });
    expect(builtTarget).toEqual({
      ...target,
      enableSignature: SIGNATURE,
      disableSignature: SIGNATURE,
    });

    const source = approval();
    const builtSource = buildSourceAuthorization(source, {
      approvalHash: HASH,
      approvalBlock: '12',
    });
    expect(builtSource).toEqual({ ...source, transactionHash: HASH });
  });
});

describe('morphoPairProblem', () => {
  it('accepts a pair that grants and then removes, for this borrower and one module', () => {
    expect(morphoPairProblem(morpho(), BORROWER)).toBeUndefined();
    // Address case is not a difference.
    expect(morphoPairProblem(morpho(), BORROWER.toLowerCase())).toBeUndefined();
  });

  it('refuses a pair issued for another account', () => {
    expect(morphoPairProblem(morpho(), '0x0000000000000000000000000000000000000001')).toMatch(
      /connected account/,
    );
  });

  it('refuses a pair that authorizes a different contract than the one shown', () => {
    const other = morpho();
    const tampered = {
      ...other,
      enable: { ...other.enable, authorized: '0x00000000000000000000000000000000000000ee' },
    } as MorphoAuthorization;
    expect(morphoPairProblem(tampered, BORROWER)).toMatch(/different contract/);
  });

  it('refuses a grant with no removal', () => {
    const other = morpho();
    const tampered = {
      ...other,
      disable: { ...other.disable, isAuthorized: true },
    } as MorphoAuthorization;
    expect(morphoPairProblem(tampered, BORROWER)).toMatch(/grant the permission and then remove/);
  });

  it('refuses a removal that does not directly follow the grant', () => {
    const other = morpho();
    const tampered = { ...other, disable: { ...other.disable, nonce: '9' } } as MorphoAuthorization;
    expect(morphoPairProblem(tampered, BORROWER)).toMatch(/directly follow/);
  });

  it('refuses a removal that outlives or predates the grant', () => {
    const other = morpho();
    const tampered = {
      ...other,
      disable: { ...other.disable, deadline: '1' },
    } as MorphoAuthorization;
    expect(morphoPairProblem(tampered, BORROWER)).toMatch(/one deadline/);
  });
});

describe('approvalProblem', () => {
  it('accepts exactly approve(spender, amount) on the token shown', () => {
    expect(approvalProblem(approval())).toBeUndefined();
  });

  it('refuses a transaction to another contract', () => {
    const base = approval();
    expect(
      approvalProblem({
        ...base,
        transaction: { ...base.transaction, to: '0x00000000000000000000000000000000000000dd' },
      } as Erc20Approval),
    ).toMatch(/does not call the token/);
  });

  it('refuses calldata that approves a different amount than the one shown', () => {
    const base = approval();
    const bigger = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: [SPENDER, 2n ** 256n - 1n],
    });
    expect(
      approvalProblem({
        ...base,
        transaction: { ...base.transaction, data: bigger },
      } as Erc20Approval),
    ).toMatch(/not an approval of the amount and spender shown/);
  });

  it('refuses calldata that approves a different spender than the one shown', () => {
    const base = approval();
    const other = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'approve',
      args: ['0x00000000000000000000000000000000000000ff', BigInt(base.amountUnits)],
    });
    expect(
      approvalProblem({
        ...base,
        transaction: { ...base.transaction, data: other },
      } as Erc20Approval),
    ).toMatch(/not an approval/);
  });

  it('refuses calldata that is not an approval at all', () => {
    const base = approval();
    const transfer = encodeFunctionData({
      abi: erc20Abi,
      functionName: 'transfer',
      args: [SPENDER, BigInt(base.amountUnits)],
    });
    expect(
      approvalProblem({
        ...base,
        transaction: { ...base.transaction, data: transfer },
      } as Erc20Approval),
    ).toMatch(/not an approval/);
  });

  it('refuses a transaction that attaches value', () => {
    const base = approval();
    expect(
      approvalProblem({
        ...base,
        transaction: { ...base.transaction, valueUnits: '1' },
      } as unknown as Erc20Approval),
    ).toMatch(/attaches value/);
  });
});
