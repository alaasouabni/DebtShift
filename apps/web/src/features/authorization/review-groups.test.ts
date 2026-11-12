import { describe, expect, it } from 'vitest';

import type { PreparedMigration } from '../../lib/api/types';
import fixture from '../../lib/demo/recordings/prepare.json' with { type: 'json' };
import { glanceRows, groupReviewRows, UNGROUPED_TITLE } from './review-groups';
import { intentRows, planRows, type ReviewRow } from './review-rows';
import { stepNote, stepStatus, type StepId, type StepStatus } from './step-notes';

const prepared = fixture as unknown as PreparedMigration;
const policy = intentRows(prepared.intent, prepared.verifyingContract, prepared.intentHash);
const plan = planRows(prepared.plan, prepared.quote, prepared.planHash);

function keys(rows: readonly ReviewRow[]): string[] {
  return rows.map((row) => row.key);
}

describe('groupReviewRows', () => {
  it('returns every policy row exactly once, in the order it was given', () => {
    const grouped = groupReviewRows('policy', policy).flatMap((group) => group.rows);
    expect(keys(grouped)).toEqual(keys(policy));
  });

  it('returns every plan row exactly once, in the order it was given', () => {
    const grouped = groupReviewRows('plan', plan).flatMap((group) => group.rows);
    expect(keys(grouped)).toEqual(keys(plan));
  });

  it('has a named group for every field the real response carries', () => {
    // A field with no group still shows, but it means this file fell behind
    // the contract — which this test exists to notice.
    for (const group of [...groupReviewRows('policy', policy), ...groupReviewRows('plan', plan)]) {
      expect(group.title).not.toBe(UNGROUPED_TITLE);
    }
  });

  it('never drops a field it does not know', () => {
    const unknown: ReviewRow = { key: 'plan.somethingNew', label: 'Something new', value: '1' };
    const groups = groupReviewRows('plan', [...plan, unknown]);
    const last = groups.at(-1)!;
    expect(last.title).toBe(UNGROUPED_TITLE);
    expect(last.rows).toEqual([unknown]);
    expect(groups.flatMap((group) => group.rows)).toHaveLength(plan.length + 1);
  });

  it('leaves out empty groups rather than showing an empty heading', () => {
    const groups = groupReviewRows('plan', plan.slice(0, 2));
    expect(groups).toHaveLength(1);
    expect(groups[0]!.rows).toHaveLength(2);
  });

  it('keeps the hash the wallet signs in a group of its own, last', () => {
    expect(groupReviewRows('policy', policy).at(-1)!.title).toBe('What your wallet signs');
    expect(groupReviewRows('plan', plan).at(-1)!.title).toBe('What your wallet signs');
  });
});

describe('glanceRows', () => {
  it('reuses the row objects of the full list, so the two cannot disagree', () => {
    for (const row of glanceRows('policy', policy)) expect(policy).toContain(row);
    for (const row of glanceRows('plan', plan)) expect(plan).toContain(row);
  });

  it('puts the funding shortfall in front of the reader before signature 2', () => {
    expect(keys(glanceRows('plan', plan))).toContain('plan.financing.fundingShortfallUnits');
  });

  it('skips a field that is missing instead of inventing it', () => {
    const without = policy.filter((row) => row.key !== 'intent.safetyPolicy');
    expect(keys(glanceRows('policy', without))).not.toContain('intent.safetyPolicy');
    expect(glanceRows('policy', without)).toHaveLength(glanceRows('policy', policy).length - 1);
  });
});

describe('stepNote', () => {
  const STEPS: StepId[] = ['prepare', 'policy', 'execution', 'submit'];
  const STATUSES: StepStatus[] = ['done', 'current', 'upcoming'];

  it('has something to say for every step in every state', () => {
    for (const step of STEPS) {
      for (const status of STATUSES) {
        for (const isDemo of [true, false]) {
          expect(stepNote(step, status, isDemo), `${step}/${status}`).not.toBe('');
        }
      }
    }
  });

  it('never calls a demo placeholder signed or submitted', () => {
    for (const step of STEPS) {
      for (const status of STATUSES) {
        const note = stepNote(step, status, true);
        expect(note, `${step}/${status}`).not.toMatch(/^Signed$|^Submitted$/);
      }
    }
    expect(stepNote('policy', 'done', true)).toMatch(/not signed/i);
    expect(stepNote('execution', 'done', true)).toMatch(/not signed/i);
  });

  it('numbers the two signatures', () => {
    expect(stepNote('policy', 'upcoming', false)).toBe('Signature 1 of 2');
    expect(stepNote('execution', 'upcoming', false)).toBe('Signature 2 of 2');
  });

  it('says nothing moves before submitting', () => {
    expect(stepNote('submit', 'upcoming', false)).toMatch(/Nothing moves before this/);
  });
});

describe('stepStatus', () => {
  it('splits the steps around the current one', () => {
    expect([0, 1, 2, 3].map((index) => stepStatus(index, 2))).toEqual([
      'done',
      'done',
      'current',
      'upcoming',
    ]);
  });
});
