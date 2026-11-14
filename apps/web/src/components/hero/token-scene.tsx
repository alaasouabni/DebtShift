'use client';

/*
 * The landing page's 3D hero: an Ethereum crystal (the collateral) and a USDC
 * coin (the debt) moving from a dearer market to a cheaper one, drawn with
 * three.js by `token-engine.ts`.
 *
 * To assistive technology it is one image with one description, exactly like
 * the CSS scene it replaces. That CSS scene is still the fallback: where
 * WebGL is not available (an old device, a locked-down browser, a test run)
 * the visitor gets the same picture without the third dimension.
 *
 * three.js is loaded only after the page is interactive, so it never delays
 * the first paint of the headline.
 */

import { useEffect, useRef, useState } from 'react';

import { FLOW_STAGE_COPY, type FlowStage } from '../flow/flow-stage';
import { HeroScene, type HeroSceneSide } from './hero-scene';
import { sceneStateFor } from './scene-state';
import type { SceneTheme, TokenSceneHandle } from './token-engine';

export interface TokenSceneProps {
  readonly stage: FlowStage;
  readonly playing: boolean;
  readonly source: HeroSceneSide;
  readonly destination: HeroSceneSide;
}

function webglAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

function currentTheme(): SceneTheme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

export function describeScene(source: HeroSceneSide, destination: HeroSceneSide): string {
  return `Illustration: a loan at ${source.rateLabel} on ${source.protocol}, ${source.chain}, moves to ${destination.protocol}, ${destination.chain}, and reopens at ${destination.rateLabel}.`;
}

export function TokenScene({ stage, playing, source, destination }: TokenSceneProps) {
  const [support, setSupport] = useState<'unknown' | 'webgl' | 'none'>('unknown');
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sourceLabel = useRef<HTMLDivElement>(null);
  const destinationLabel = useRef<HTMLDivElement>(null);
  const beamLabel = useRef<HTMLDivElement>(null);
  const engine = useRef<TokenSceneHandle | null>(null);
  const stageRef = useRef(stage);
  stageRef.current = stage;
  const playingRef = useRef(playing);
  playingRef.current = playing;

  useEffect(() => {
    setSupport(webglAvailable() ? 'webgl' : 'none');
  }, []);

  // Build the engine once WebGL is known to work.
  useEffect(() => {
    if (support !== 'webgl') return;
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    let cancelled = false;
    let observer: ResizeObserver | undefined;
    let intersection: IntersectionObserver | undefined;
    let themeObserver: MutationObserver | undefined;

    void import('./token-engine')
      .then(({ createTokenScene }) => {
        if (cancelled) return;
        const handle = createTokenScene(canvas, {
          theme: currentTheme(),
          sourceRateBps: source.rateBps,
          destinationRateBps: destination.rateBps,
          labels: {
            source: sourceLabel.current,
            destination: destinationLabel.current,
            beam: beamLabel.current,
          },
        });
        engine.current = handle;
        handle.setPlaying(playingRef.current);
        handle.setStage(stageRef.current, true);

        const fit = () => {
          const box = wrap.getBoundingClientRect();
          handle.resize(box.width, box.height);
        };
        fit();
        observer = new ResizeObserver(fit);
        observer.observe(wrap);
        intersection = new IntersectionObserver(
          ([entry]) => handle.setVisible(Boolean(entry?.isIntersecting)),
          { rootMargin: '80px' },
        );
        intersection.observe(wrap);
        themeObserver = new MutationObserver(() => handle.setTheme(currentTheme()));
        themeObserver.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['data-theme'],
        });
        wrap.dataset.ready = 'true';
      })
      .catch(() => {
        if (!cancelled) setSupport('none');
      });

    return () => {
      cancelled = true;
      observer?.disconnect();
      intersection?.disconnect();
      themeObserver?.disconnect();
      engine.current?.destroy();
      engine.current = null;
    };
    // The rates are read once: they come from the recording and never change.
  }, [support]);

  useEffect(() => {
    engine.current?.setStage(stage);
  }, [stage]);

  useEffect(() => {
    engine.current?.setPlaying(playing);
  }, [playing]);

  if (support === 'none') {
    return <HeroScene stage={stage} source={source} destination={destination} />;
  }

  const state = sceneStateFor(stage);
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch' || !playingRef.current) return;
    const box = event.currentTarget.getBoundingClientRect();
    engine.current?.pointer(
      ((event.clientX - box.left) / box.width - 0.5) * 2,
      ((event.clientY - box.top) / box.height - 0.5) * 2,
    );
  };

  return (
    <div
      ref={wrapRef}
      className="token-scene"
      role="img"
      aria-label={describeScene(source, destination)}
      data-stage={stage}
      onPointerMove={onPointerMove}
      onPointerLeave={() => engine.current?.pointer(0, 0)}
    >
      <canvas ref={canvasRef} className="token-scene__canvas" aria-hidden="true" />
      <div aria-hidden="true">
        <div ref={sourceLabel} className="token-scene__label">
          <span className="token-scene__role">From</span>
          <strong>{source.protocol}</strong>
          <span className="token-scene__chain">{source.chain}</span>
          <span className="token-scene__rate" data-open={state.sourceLoanOpen ? 'true' : 'false'}>
            {source.rateLabel} <span>borrow rate</span>
          </span>
        </div>
        <div ref={destinationLabel} className="token-scene__label">
          <span className="token-scene__role">To</span>
          <strong>{destination.protocol}</strong>
          <span className="token-scene__chain">{destination.chain}</span>
          <span
            className="token-scene__rate token-scene__rate--accent"
            data-open={state.destinationLoanOpen ? 'true' : 'false'}
          >
            {destination.rateLabel} <span>borrow rate</span>
          </span>
        </div>
        <div
          ref={beamLabel}
          className="token-scene__beam"
          data-active={state.token === 'mid-air' ? 'true' : 'false'}
        >
          NEAR Intents
          <span className="token-scene__beam-note">simulated in the sandbox run</span>
        </div>
        <p className="token-scene__caption">
          <span className="token-scene__pulse" />
          {FLOW_STAGE_COPY[stage].title}
        </p>
      </div>
    </div>
  );
}
