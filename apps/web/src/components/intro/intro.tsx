/*
 * The brand intro overlay. Hidden unless the head script decided it plays
 * (see `lib/intro`); decorative, so assistive technology never meets it.
 */

import './intro.css';

const NAME = 'DebtShift';

export function Intro() {
  return (
    <div className="intro" aria-hidden="true">
      <div className="intro__inner">
        <svg className="intro__mark" viewBox="0 0 24 24" fill="none" width="96" height="96">
          <path className="intro__stroke intro__stroke--ink" d="M4 18 11 6" pathLength={1} />
          <path className="intro__stroke intro__stroke--accent" d="M13 18 20 6" pathLength={1} />
        </svg>
        <p className="intro__name">
          {NAME.split('').map((letter, index) => (
            <span
              key={`${letter}-${index}`}
              className="intro__letter"
              style={{ ['--i' as string]: index }}
            >
              {letter}
            </span>
          ))}
        </p>
        <p className="intro__tagline">cross-chain debt refinancing · NEAR Intents</p>
        <span className="intro__bar">
          <span />
        </span>
      </div>
    </div>
  );
}
