import { describe, expect, it } from 'vitest';

import {
  destinationIsActive,
  FLOW_STAGE_COPY,
  ILLUSTRATION_STAGES,
  sourceIsActive,
  type FlowStage,
} from '../flow/flow-stage';
import { columnHeightEm, sceneStateFor } from './scene-state';

const ALL_STAGES = Object.keys(FLOW_STAGE_COPY) as FlowStage[];

describe('sceneStateFor', () => {
  it('draws every stage the flow knows', () => {
    for (const stage of ALL_STAGES) {
      expect(sceneStateFor(stage).token, stage).toBeDefined();
    }
  });

  it('agrees with the flow diagram about which side holds the loan', () => {
    // Two pictures of one run must never disagree.
    for (const stage of ALL_STAGES) {
      const state = sceneStateFor(stage);
      expect(state.sourceLoanOpen, stage).toBe(sourceIsActive(stage));
      expect(state.destinationLit, stage).toBe(destinationIsActive(stage));
    }
  });

  it('never stands the destination loan up before it is open', () => {
    for (const stage of ALL_STAGES) {
      expect(sceneStateFor(stage).destinationLoanOpen, stage).toBe(stage === 'settled');
    }
  });

  it('only rests the collateral on the destination once settled', () => {
    for (const stage of ALL_STAGES) {
      const onDestination = sceneStateFor(stage).token === 'on-destination';
      expect(onDestination, stage).toBe(stage === 'settled');
    }
  });

  it('never shows both loans open at once', () => {
    for (const stage of ALL_STAGES) {
      const state = sceneStateFor(stage);
      expect(state.sourceLoanOpen && state.destinationLoanOpen, stage).toBe(false);
    }
  });

  it('leaves the source untouched when nothing moved', () => {
    expect(sceneStateFor('stopped')).toEqual({
      token: 'on-source',
      sourceLoanOpen: true,
      destinationLit: false,
      destinationLoanOpen: false,
    });
  });

  it('shows returning value in the air, on neither side', () => {
    const state = sceneStateFor('returning');
    expect(state.token).toBe('mid-air');
    expect(state.destinationLit).toBe(false);
    expect(state.destinationLoanOpen).toBe(false);
  });

  it('moves the collateral one step at a time through a normal run', () => {
    expect(ILLUSTRATION_STAGES.map((stage) => sceneStateFor(stage).token)).toEqual([
      'on-source',
      'lifted',
      'mid-air',
      'above-destination',
      'on-destination',
    ]);
  });
});

describe('columnHeightEm', () => {
  it('stands a dearer loan taller than a cheaper one', () => {
    expect(columnHeightEm(700)).toBeGreaterThan(columnHeightEm(450));
  });

  it('uses one unit per percentage point', () => {
    expect(columnHeightEm(700)).toBe(7);
    expect(columnHeightEm(450)).toBe(4.5);
  });

  it('keeps an extreme rate inside the scene', () => {
    expect(columnHeightEm(50_000)).toBe(12);
  });

  it('keeps a tiny or broken rate visible', () => {
    expect(columnHeightEm(10)).toBe(1.5);
    expect(columnHeightEm(0)).toBe(1.5);
    expect(columnHeightEm(-300)).toBe(1.5);
    expect(columnHeightEm(Number.NaN)).toBe(1.5);
  });
});
