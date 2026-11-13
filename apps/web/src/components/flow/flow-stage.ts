/*
 * Which part of the cross-chain picture is "live" for a migration phase.
 *
 * The flow visual is a drawing of the authoritative phase, nothing more: this
 * maps the backend's phase onto five positions and three special outcomes. It
 * never advances on its own and never shows more progress than the phase the
 * API reported.
 */

import type { MigrationPhase } from '../../lib/api/types';

export type FlowStage =
  /** Authorized and reserved; nothing has left the source market yet. */
  | 'ready'
  /** The source loan is closed and the collateral released. */
  | 'source-closed'
  /** Value is crossing between the chains. */
  | 'in-transit'
  /** Value has arrived and the destination loan is being opened. */
  | 'arriving'
  /** The destination loan is open and the solver is repaid. */
  | 'settled'
  /** Recovery: value is travelling back along the signed refund path. */
  | 'returning'
  /** Ended without moving anything, or after the window closed. */
  | 'stopped';

const STAGE_BY_PHASE: Record<MigrationPhase, FlowStage> = {
  DRAFT: 'ready',
  QUOTED: 'ready',
  AUTHORIZED: 'ready',
  RESERVED: 'ready',
  SOURCE_CLOSED: 'source-closed',
  ROUTING: 'in-transit',
  DEST_FUNDED: 'arriving',
  TARGET_OPEN: 'arriving',
  SETTLED: 'settled',
  COMPLETED: 'settled',
  RECOVERY: 'returning',
  FAILED_SAFE: 'returning',
  REQUOTE_REQUIRED: 'stopped',
  EXPIRED: 'stopped',
  // Cancellation is only possible before the source loan is touched.
  CANCELLED: 'stopped',
};

export function flowStageForPhase(phase: MigrationPhase): FlowStage {
  return STAGE_BY_PHASE[phase];
}

/** The order the landing page cycles through to illustrate a normal run. */
export const ILLUSTRATION_STAGES: readonly FlowStage[] = [
  'ready',
  'source-closed',
  'in-transit',
  'arriving',
  'settled',
];

export interface FlowStageCopy {
  readonly title: string;
  readonly detail: string;
}

export const FLOW_STAGE_COPY: Record<FlowStage, FlowStageCopy> = {
  ready: {
    title: 'Authorized',
    detail: 'Two signatures verified, destination liquidity reserved. Nothing has moved yet.',
  },
  'source-closed': {
    title: 'Old loan closed',
    detail: 'The source debt is repaid and the collateral is released.',
  },
  'in-transit': {
    title: 'In transit',
    detail: 'Collateral is crossing to the destination chain.',
  },
  arriving: {
    title: 'Arrived',
    detail: 'Delivery is verified and the new loan is opening.',
  },
  settled: {
    title: 'Solver repaid',
    detail: 'The new loan is open at the lower rate and the solver is repaid.',
  },
  returning: {
    title: 'Returning',
    detail: 'Value is going back along the refund path you signed.',
  },
  stopped: {
    title: 'Stopped',
    detail: 'Nothing is moving. Your source position is where it was.',
  },
};

/** True when the source side is the one holding the loan at this stage. */
export function sourceIsActive(stage: FlowStage): boolean {
  return stage === 'ready' || stage === 'stopped';
}

/** True when the destination side holds the new loan at this stage. */
export function destinationIsActive(stage: FlowStage): boolean {
  return stage === 'arriving' || stage === 'settled';
}

/** Direction the lane animates in, or `none` when nothing is travelling. */
export function laneDirection(stage: FlowStage): 'forward' | 'backward' | 'none' {
  if (stage === 'source-closed' || stage === 'in-transit') return 'forward';
  if (stage === 'returning') return 'backward';
  return 'none';
}
