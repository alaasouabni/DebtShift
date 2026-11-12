import { migrationPhaseSchema } from '@debtshift/domain';
import { describe, expect, it } from 'vitest';

import type { MigrationPhase } from '../../lib/api/types';
import {
  destinationIsActive,
  FLOW_STAGE_COPY,
  flowStageForPhase,
  ILLUSTRATION_STAGES,
  laneDirection,
  sourceIsActive,
  type FlowStage,
} from './flow-stage';

const ALL_PHASES = [...migrationPhaseSchema.options] as MigrationPhase[];

describe('flowStageForPhase', () => {
  it('covers every phase the backend defines', () => {
    // Driven by the backend enum: a new phase fails this until the picture
    // knows how to draw it.
    for (const phase of ALL_PHASES) {
      expect(flowStageForPhase(phase), phase).toBeDefined();
    }
  });

  it('shows nothing leaving the source before the source is closed', () => {
    for (const phase of ['DRAFT', 'QUOTED', 'AUTHORIZED', 'RESERVED'] as const) {
      const stage = flowStageForPhase(phase);
      expect(stage, phase).toBe('ready');
      expect(laneDirection(stage)).toBe('none');
      expect(sourceIsActive(stage)).toBe(true);
    }
  });

  it('never runs ahead of the phase', () => {
    // The destination only lights up once delivery is verified.
    expect(destinationIsActive(flowStageForPhase('SOURCE_CLOSED'))).toBe(false);
    expect(destinationIsActive(flowStageForPhase('ROUTING'))).toBe(false);
    expect(destinationIsActive(flowStageForPhase('DEST_FUNDED'))).toBe(true);
  });

  it('moves forward while value is crossing', () => {
    expect(laneDirection(flowStageForPhase('SOURCE_CLOSED'))).toBe('forward');
    expect(laneDirection(flowStageForPhase('ROUTING'))).toBe('forward');
  });

  it('moves backward in recovery and after a safe failure', () => {
    expect(laneDirection(flowStageForPhase('RECOVERY'))).toBe('backward');
    expect(flowStageForPhase('FAILED_SAFE')).toBe('returning');
  });

  it('shows nothing moving when the run ended before moving anything', () => {
    for (const phase of ['REQUOTE_REQUIRED', 'EXPIRED'] as const) {
      const stage = flowStageForPhase(phase);
      expect(stage, phase).toBe('stopped');
      expect(laneDirection(stage)).toBe('none');
      expect(destinationIsActive(stage)).toBe(false);
    }
  });

  it('draws SETTLED and COMPLETED the same, leaving the words to tell them apart', () => {
    // The picture is about where the loan is. Whether reconciliation is done
    // is said in the phase label and caption, never implied by the drawing.
    expect(flowStageForPhase('SETTLED')).toBe('settled');
    expect(flowStageForPhase('COMPLETED')).toBe('settled');
  });
});

describe('stage copy', () => {
  const stages = Object.keys(FLOW_STAGE_COPY) as FlowStage[];

  it('gives every stage a title and a sentence', () => {
    for (const stage of stages) {
      expect(FLOW_STAGE_COPY[stage].title, stage).not.toBe('');
      expect(FLOW_STAGE_COPY[stage].detail, stage).not.toBe('');
    }
  });

  it('does not call the settled stage complete', () => {
    expect(`${FLOW_STAGE_COPY.settled.title} ${FLOW_STAGE_COPY.settled.detail}`).not.toMatch(
      /complete|finished|done/i,
    );
  });
});

describe('the landing illustration', () => {
  it('walks a normal run in order and never shows a failure', () => {
    expect([...ILLUSTRATION_STAGES]).toEqual([
      'ready',
      'source-closed',
      'in-transit',
      'arriving',
      'settled',
    ]);
  });
});
