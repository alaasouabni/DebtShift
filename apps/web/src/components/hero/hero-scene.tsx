'use client';

/*
 * The 3D hero scene.
 *
 * Built from plain elements and CSS 3D transforms — no canvas, no 3D library —
 * so it costs nothing to load, follows the theme tokens and stays sharp at any
 * size. Every length is in `em`, and one `em` is a fixed fraction of the
 * scene's width, so the whole scene scales as one piece.
 *
 * It is decoration over the flow diagram, which carries the same information
 * as text. To assistive technology it is one image with one description.
 */

import { useCallback, useRef, type CSSProperties, type PointerEvent } from 'react';

import { FLOW_STAGE_COPY, laneDirection, type FlowStage } from '../flow/flow-stage';
import { columnHeightEm, sceneStateFor } from './scene-state';

export interface HeroSceneSide {
  readonly protocol: string;
  readonly chain: string;
  /** The borrow rate in basis points; sets the height of the loan column. */
  readonly rateBps: number;
  /** The same rate, formatted for display. */
  readonly rateLabel: string;
}

export interface HeroSceneProps {
  readonly stage: FlowStage;
  readonly source: HeroSceneSide;
  readonly destination: HeroSceneSide;
}

/** Height of a platform, in scene units. Must match `--slab` in the CSS. */
const SLAB_EM = 2.2;

function vars(values: Record<string, string>): CSSProperties {
  return values as CSSProperties;
}

/** A box drawn from the three faces the camera can see. */
function Cuboid({
  className,
  style,
  ...data
}: {
  readonly className: string;
  readonly style?: CSSProperties | undefined;
  readonly [key: `data-${string}`]: string | undefined;
}) {
  return (
    <div className={`cuboid ${className}`} style={style} {...data}>
      <span className="cuboid__top" />
      <span className="cuboid__south" />
      <span className="cuboid__east" />
    </div>
  );
}

export function HeroScene({ stage, source, destination }: HeroSceneProps) {
  const sceneRef = useRef<HTMLDivElement>(null);
  const state = sceneStateFor(stage);

  const sourceHeight = state.sourceLoanOpen ? columnHeightEm(source.rateBps) : 0;
  const destinationHeight = state.destinationLoanOpen ? columnHeightEm(destination.rateBps) : 0;

  // A few degrees of tilt under the pointer. Skipped for reduced motion.
  const onPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const scene = sceneRef.current;
    if (!scene || event.pointerType === 'touch') return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const box = scene.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return;
    const x = (event.clientX - box.left) / box.width - 0.5;
    const y = (event.clientY - box.top) / box.height - 0.5;
    scene.style.setProperty('--rz', `${(45 + x * 8).toFixed(2)}deg`);
    scene.style.setProperty('--rx', `${(58 - y * 6).toFixed(2)}deg`);
  }, []);

  const onPointerLeave = useCallback(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    scene.style.removeProperty('--rz');
    scene.style.removeProperty('--rx');
  }, []);

  return (
    <div className="scene-wrap">
      <div
        ref={sceneRef}
        className="scene"
        role="img"
        aria-label={`Illustration: a loan at ${source.rateLabel} on ${source.protocol}, ${source.chain}, moves to ${destination.protocol}, ${destination.chain}, and reopens at ${destination.rateLabel}.`}
        data-stage={stage}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
      >
        <div className="scene__stage" aria-hidden="true">
          <div className="scene__plane">
            <span className="scene__grid" />
            <span className="scene__path" data-direction={laneDirection(stage)} />
            <span
              className="scene__glow scene__glow--destination"
              data-on={state.destinationLit ? 'true' : 'false'}
            />

            <Cuboid
              className="scene__slab scene__slab--source"
              data-lit={state.sourceLoanOpen ? 'true' : 'false'}
            />
            <Cuboid
              className="scene__slab scene__slab--destination"
              data-lit={state.destinationLit ? 'true' : 'false'}
            />

            <Cuboid
              className="scene__loan scene__loan--source"
              data-open={state.sourceLoanOpen ? 'true' : 'false'}
              style={vars({ '--h': `${sourceHeight}em` })}
            />
            <Cuboid
              className="scene__loan scene__loan--destination"
              data-open={state.destinationLoanOpen ? 'true' : 'false'}
              style={vars({ '--h': `${destinationHeight}em` })}
            />

            <span className="scene__shadow" data-token={state.token} />
            <Cuboid className="scene__token" data-token={state.token} />

            {/* Labels face the camera whatever the tilt. */}
            <div
              className="scene__anchor scene__anchor--source-rate"
              style={vars({ '--z': `${SLAB_EM + sourceHeight + 1.2}em` })}
            >
              <span className="scene__tag" data-open={state.sourceLoanOpen ? 'true' : 'false'}>
                <strong>{source.rateLabel}</strong> borrow rate
              </span>
            </div>
            <div
              className="scene__anchor scene__anchor--destination-rate"
              style={vars({ '--z': `${SLAB_EM + destinationHeight + 1.2}em` })}
            >
              <span
                className="scene__tag scene__tag--accent"
                data-open={state.destinationLoanOpen ? 'true' : 'false'}
              >
                <strong>{destination.rateLabel}</strong> borrow rate
              </span>
            </div>

            <div className="scene__anchor scene__anchor--source-name">
              <span className="scene__name">
                <span className="scene__role">From</span>
                <strong>{source.protocol}</strong>
                <span>{source.chain}</span>
              </span>
            </div>
            <div className="scene__anchor scene__anchor--destination-name">
              <span className="scene__name">
                <span className="scene__role">To</span>
                <strong>{destination.protocol}</strong>
                <span>{destination.chain}</span>
              </span>
            </div>
          </div>
        </div>

        <p className="scene__caption" aria-hidden="true">
          <span className="chip__dot" />
          {FLOW_STAGE_COPY[stage].title}
        </p>
      </div>
    </div>
  );
}
