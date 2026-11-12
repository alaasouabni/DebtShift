/*
 * The guided tour of the recorded demo.
 *
 * Five screens, in the order a real refinance goes through them. The tour is
 * navigation and nothing else: it holds no figures and no data of its own, so
 * it cannot say anything the screens themselves do not show. Where it is in
 * the tour is read from the address, not stored — a reload, the back button
 * or a pasted link all land on the right step.
 */

import { DEMO_MIGRATION_ID } from './demo-api';

export type TourStepId = 'position' | 'routes' | 'authorize' | 'monitor' | 'history';

export interface TourStep {
  readonly id: TourStepId;
  readonly href: string;
  readonly title: string;
  /** What to look at on this screen. Never a figure. */
  readonly hint: string;
}

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: 'position',
    href: '/position',
    title: 'Your position',
    hint: 'The loan as it stands: collateral, debt, rate and health, with the block it was read at.',
  },
  {
    id: 'routes',
    href: '/routes',
    title: 'Compare routes',
    hint: 'Every candidate route: the one selected, and any that were rejected with the reason.',
  },
  {
    id: 'authorize',
    href: '/authorize',
    title: 'Two signatures',
    hint: 'Press Prepare, then each signature button. In the demo they are placeholders: nothing is signed.',
  },
  {
    id: 'monitor',
    href: `/migrations/${DEMO_MIGRATION_ID}`,
    title: 'Watch it run',
    hint: 'The recorded migration replays phase by phase, with its commands and evidence.',
  },
  {
    id: 'history',
    href: '/history',
    title: 'History',
    hint: 'The stored position, the last migration from this browser and the enabled markets.',
  },
];

function pathOf(pathname: string): string {
  const path = pathname.split(/[?#]/)[0] ?? '';
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

/** Index of the tour step this address belongs to, or -1 when it is not on the tour. */
export function tourStepIndex(pathname: string): number {
  const path = pathOf(pathname);
  // Any migration is the monitor step: the demo only ever opens the recorded one.
  if (path.startsWith('/migrations/')) return TOUR_STEPS.findIndex((step) => step.id === 'monitor');
  return TOUR_STEPS.findIndex((step) => step.href === path);
}

export interface TourPosition {
  /** -1 when the current screen is not part of the tour. */
  readonly index: number;
  readonly step: TourStep | undefined;
  readonly next: TourStep | undefined;
  readonly isLast: boolean;
  /**
   * The step is finished on the page itself, so the tour's own way forward is
   * a shortcut past it rather than the main action.
   */
  readonly nextIsShortcut: boolean;
}

export function tourPosition(pathname: string): TourPosition {
  const index = tourStepIndex(pathname);
  const step = index >= 0 ? TOUR_STEPS[index] : undefined;
  const isLast = index === TOUR_STEPS.length - 1;
  // Off the tour, the way forward is its first step.
  const next = index < 0 ? TOUR_STEPS[0] : isLast ? undefined : TOUR_STEPS[index + 1];
  return { index, step, next, isLast, nextIsShortcut: step?.id === 'authorize' };
}
