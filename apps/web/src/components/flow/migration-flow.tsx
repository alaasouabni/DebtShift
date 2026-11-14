/*
 * The cross-chain picture: source market → transport lane → destination market.
 *
 * It is the one image of what DebtShift does, so it appears on the landing
 * page (cycling through a normal run) and on the live monitor (driven by the
 * phase the API reports). Every label it shows is passed in; it holds no
 * numbers of its own.
 *
 * Motion is decoration on top of text: the stage title and detail are always
 * rendered as words, and the global reduced-motion rule stills the lane.
 */

import {
  destinationIsActive,
  FLOW_STAGE_COPY,
  laneDirection,
  sourceIsActive,
  type FlowStage,
} from './flow-stage';

export interface FlowSide {
  /** e.g. "Aave V3" */
  readonly protocol: string;
  /** e.g. "Sandbox source chain · 31337" */
  readonly chain: string;
  /** Optional headline figure, e.g. "7.00%" */
  readonly figure?: string | undefined;
  /** What the figure is, e.g. "borrow rate" */
  readonly figureLabel?: string | undefined;
  /** Optional second line, e.g. "10,000.00 sUSDC debt" */
  readonly detail?: string | undefined;
}

export function MigrationFlow({
  source,
  destination,
  transportLabel,
  stage,
  compact = false,
}: {
  readonly source: FlowSide;
  readonly destination: FlowSide;
  /** e.g. "NEAR Intents · 1Click" or "Simulated transport" */
  readonly transportLabel: string;
  readonly stage: FlowStage;
  readonly compact?: boolean;
}) {
  const copy = FLOW_STAGE_COPY[stage];
  const direction = laneDirection(stage);
  const sourceOn = sourceIsActive(stage);
  const destinationOn = destinationIsActive(stage);

  return (
    <figure className={`flow${compact ? ' flow--compact' : ''}`} data-stage={stage}>
      <div className="flow__row">
        <FlowNode side={source} role="From" active={sourceOn} dimmed={destinationOn} />

        <div className="flow__lane" data-direction={direction} aria-hidden="true">
          <span className="flow__track" />
          <span className="flow__pulse flow__pulse--1" />
          <span className="flow__pulse flow__pulse--2" />
          <span className="flow__pulse flow__pulse--3" />
          <span className="flow__lane-label">{transportLabel}</span>
        </div>

        <FlowNode side={destination} role="To" active={destinationOn} dimmed={false} />
      </div>

      {/* The state in words. The animation above is never the only signal. */}
      <figcaption className="flow__caption" aria-live="polite">
        <span className="flow__stage">{copy.title}</span>
        <span className="flow__detail">{copy.detail}</span>
      </figcaption>
    </figure>
  );
}

function FlowNode({
  side,
  role,
  active,
  dimmed,
}: {
  readonly side: FlowSide;
  readonly role: 'From' | 'To';
  readonly active: boolean;
  readonly dimmed: boolean;
}) {
  return (
    <div
      className={`flow__node${active ? ' is-active' : ''}${dimmed ? ' is-dimmed' : ''}`}
      data-role={role.toLowerCase()}
    >
      <span className="flow__role">{role}</span>
      <span className="flow__protocol">{side.protocol}</span>
      <span className="flow__chain">{side.chain}</span>
      {side.figure ? (
        <span className="flow__figure num">
          {side.figure}
          {side.figureLabel ? <span className="flow__figure-label">{side.figureLabel}</span> : null}
        </span>
      ) : null}
      {side.detail ? <span className="flow__side-detail num">{side.detail}</span> : null}
    </div>
  );
}
