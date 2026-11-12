/*
 * The guided tour bar, shown inside the recorded-demo banner.
 *
 * It tells a first-time visitor where they are in the five screens, what to
 * look at on this one, and gives one button to the next. Every step is also a
 * link, so the tour can be walked in any order.
 */

import Link from 'next/link';

import { tourPosition, TOUR_STEPS } from '../../lib/demo/tour';

function Arrow() {
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 12h16m-6-6 6 6-6 6" />
    </svg>
  );
}

export function DemoTour({ pathname }: { readonly pathname: string }) {
  const { index, step, next, isLast, nextIsShortcut } = tourPosition(pathname);
  const onTour = step !== undefined;
  const nextLabel = onTour ? (nextIsShortcut ? 'Skip' : 'Next') : 'Start';

  return (
    <nav className="tour" aria-label="Guided tour">
      <ol className="tour__steps">
        {TOUR_STEPS.map((item, itemIndex) => {
          const status =
            !onTour || itemIndex > index ? 'upcoming' : itemIndex === index ? 'current' : 'done';
          return (
            <li key={item.id}>
              <Link
                href={item.href}
                className="tour__dot"
                data-status={status}
                aria-current={status === 'current' ? 'step' : undefined}
                aria-label={`Step ${itemIndex + 1} of ${TOUR_STEPS.length}: ${item.title}`}
                title={item.title}
              >
                {itemIndex + 1}
              </Link>
            </li>
          );
        })}
      </ol>

      <p className="tour__text">
        {onTour ? (
          <>
            <strong>
              Step {index + 1} of {TOUR_STEPS.length} · {step.title}
            </strong>
            <span className="tour__hint"> {step.hint}</span>
          </>
        ) : (
          <>
            <strong>Guided tour</strong>
            <span className="tour__hint">
              {' '}
              {TOUR_STEPS.length} screens, in the order a refinance goes through them.
            </span>
          </>
        )}
      </p>

      {next ? (
        <Link
          href={next.href}
          className={`tour__next${nextIsShortcut ? ' tour__next--quiet' : ''}`}
          aria-label={`${nextLabel}: ${next.title}`}
        >
          {/* One item, so the colon sits against the word before it. */}
          <span>
            {nextLabel}
            <span className="tour__next-title">: {next.title}</span>
          </span>
          <Arrow />
        </Link>
      ) : isLast ? (
        <Link
          href={TOUR_STEPS[0]!.href}
          className="tour__next tour__next--quiet"
          aria-label="End of the tour. Start again"
        >
          <span>
            <span className="tour__next-title">End of the tour · </span>
            Start again
          </span>
        </Link>
      ) : null}
    </nav>
  );
}
