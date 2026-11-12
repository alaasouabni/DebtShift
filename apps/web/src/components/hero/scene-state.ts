/*
 * What the 3D hero scene draws for a stage of a migration.
 *
 * The scene is the same picture as the flow diagram, in three dimensions: two
 * platforms (the source and destination markets), a column on each for the
 * loan, and a small block for the collateral that travels between them. Like
 * the diagram it is a drawing of a stage and nothing more — it never shows the
 * destination loan before the stage says it is open.
 */

import { destinationIsActive, sourceIsActive, type FlowStage } from '../flow/flow-stage';

/** Where the collateral block sits. */
export type TokenSpot = 'on-source' | 'lifted' | 'mid-air' | 'above-destination' | 'on-destination';

export interface SceneState {
  readonly token: TokenSpot;
  /** The source loan column is standing. */
  readonly sourceLoanOpen: boolean;
  /** The destination platform is highlighted: value has arrived there. */
  readonly destinationLit: boolean;
  /** The destination loan column is standing. */
  readonly destinationLoanOpen: boolean;
}

const TOKEN_BY_STAGE: Record<FlowStage, TokenSpot> = {
  ready: 'on-source',
  'source-closed': 'lifted',
  'in-transit': 'mid-air',
  arriving: 'above-destination',
  settled: 'on-destination',
  // Value on its way back is in the air, not resting on either side.
  returning: 'mid-air',
  stopped: 'on-source',
};

export function sceneStateFor(stage: FlowStage): SceneState {
  return {
    token: TOKEN_BY_STAGE[stage],
    sourceLoanOpen: sourceIsActive(stage),
    destinationLit: destinationIsActive(stage),
    // "Arriving" means delivery is verified and the loan is opening. The
    // column only stands once it is open.
    destinationLoanOpen: stage === 'settled',
  };
}

const MIN_COLUMN_EM = 1.5;
const MAX_COLUMN_EM = 12;

/**
 * Height of a loan column: one unit per percentage point of borrow rate, so a
 * 7.00% loan stands visibly taller than a 4.50% one. Clamped so an extreme
 * rate cannot leave the scene or vanish.
 *
 * Basis points are a small integer rate, not a token amount, so plain number
 * arithmetic is fine here.
 */
export function columnHeightEm(rateBps: number): number {
  if (!Number.isFinite(rateBps) || rateBps <= 0) return MIN_COLUMN_EM;
  return Math.min(MAX_COLUMN_EM, Math.max(MIN_COLUMN_EM, rateBps / 100));
}
