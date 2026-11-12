// @vitest-environment jsdom

/*
 * The guided tour of the recorded demo.
 *
 * The tour is navigation only. These tests pin the two things that could make
 * it mislead: pointing at a screen that does not exist, and saying anything
 * the screens themselves do not show.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { DemoTour } from '../../components/shell/demo-tour';
import { DEMO_MIGRATION_ID } from './demo-api';
import { TOUR_STEPS, tourPosition, tourStepIndex } from './tour';

afterEach(cleanup);

describe('the tour steps', () => {
  it('follows the order of a real refinance', () => {
    expect(TOUR_STEPS.map((step) => step.id)).toEqual([
      'position',
      'routes',
      'authorize',
      'monitor',
      'history',
    ]);
  });

  it('opens the recorded migration, not an invented one', () => {
    const monitor = TOUR_STEPS.find((step) => step.id === 'monitor')!;
    expect(monitor.href).toBe(`/migrations/${DEMO_MIGRATION_ID}`);
  });

  it('carries no figures of its own', () => {
    // Amounts, rates and dates belong to the screens, which read them from
    // the recording. A number typed into a hint could drift from them.
    for (const step of TOUR_STEPS) {
      expect(`${step.title} ${step.hint}`, step.id).not.toMatch(/\d/);
    }
  });

  it('says in the signing step that nothing is signed', () => {
    const authorize = TOUR_STEPS.find((step) => step.id === 'authorize')!;
    expect(authorize.hint).toMatch(/placeholders/i);
    expect(authorize.hint).toMatch(/nothing is signed/i);
  });
});

describe('tourStepIndex', () => {
  it('finds each step from its own address', () => {
    TOUR_STEPS.forEach((step, index) => {
      expect(tourStepIndex(step.href), step.id).toBe(index);
    });
  });

  it('treats any migration address as the monitor step', () => {
    expect(tourStepIndex('/migrations/0xabc')).toBe(3);
  });

  it('ignores a trailing slash, a query and a fragment', () => {
    expect(tourStepIndex('/routes/')).toBe(1);
    expect(tourStepIndex('/routes?x=1')).toBe(1);
    expect(tourStepIndex('/routes#rejected-a')).toBe(1);
  });

  it('reports screens that are not on the tour', () => {
    expect(tourStepIndex('/settings')).toBe(-1);
    expect(tourStepIndex('/')).toBe(-1);
    expect(tourStepIndex('/routesx')).toBe(-1);
  });
});

describe('tourPosition', () => {
  it('points each step at the one after it', () => {
    expect(tourPosition('/position').next?.id).toBe('routes');
    expect(tourPosition('/routes').next?.id).toBe('authorize');
    expect(tourPosition('/authorize').next?.id).toBe('monitor');
    expect(tourPosition(`/migrations/${DEMO_MIGRATION_ID}`).next?.id).toBe('history');
  });

  it('has nowhere further to go on the last step', () => {
    const last = tourPosition('/history');
    expect(last.isLast).toBe(true);
    expect(last.next).toBeUndefined();
  });

  it('offers the first step from a screen outside the tour', () => {
    const off = tourPosition('/settings');
    expect(off.step).toBeUndefined();
    expect(off.next?.id).toBe('position');
  });

  it('marks the way past the signing step as a shortcut, not the main action', () => {
    expect(tourPosition('/authorize').nextIsShortcut).toBe(true);
    expect(tourPosition('/routes').nextIsShortcut).toBe(false);
  });
});

describe('the tour bar', () => {
  function dots() {
    return screen
      .getAllByRole('link', { name: /^Step \d of 5:/ })
      .map((link) => link.getAttribute('data-status'));
  }

  it('is a navigation landmark with every step as a link', () => {
    render(<DemoTour pathname="/routes" />);
    const nav = screen.getByRole('navigation', { name: /guided tour/i });
    expect(nav).toBeDefined();
    const links = screen.getAllByRole('link', { name: /^Step \d of 5:/ });
    expect(links.map((link) => link.getAttribute('href'))).toEqual(
      TOUR_STEPS.map((step) => step.href),
    );
  });

  it('shows where the visitor is', () => {
    render(<DemoTour pathname="/routes" />);
    expect(screen.getByText(/Step 2 of 5 · Compare routes/)).toBeDefined();
    expect(dots()).toEqual(['done', 'current', 'upcoming', 'upcoming', 'upcoming']);
    expect(screen.getByRole('link', { name: /Step 2 of 5/ }).getAttribute('aria-current')).toBe(
      'step',
    );
  });

  it('gives one button to the next screen', () => {
    render(<DemoTour pathname="/routes" />);
    const next = screen.getByRole('link', { name: /Next: Two signatures/ });
    expect(next.getAttribute('href')).toBe('/authorize');
  });

  it('calls the way past signing a skip', () => {
    render(<DemoTour pathname="/authorize" />);
    const skip = screen.getByRole('link', { name: /Skip: Watch it run/ });
    expect(skip.getAttribute('href')).toBe(`/migrations/${DEMO_MIGRATION_ID}`);
    expect(screen.queryByRole('link', { name: /^Next:/ })).toBeNull();
  });

  it('ends on the last screen and offers to start again', () => {
    render(<DemoTour pathname="/history" />);
    expect(dots()).toEqual(['done', 'done', 'done', 'done', 'current']);
    const again = screen.getByRole('link', { name: /End of the tour\. Start again/ });
    expect(again.getAttribute('href')).toBe('/position');
  });

  it('marks no step as reached on a screen outside the tour', () => {
    render(<DemoTour pathname="/settings" />);
    expect(dots()).toEqual(['upcoming', 'upcoming', 'upcoming', 'upcoming', 'upcoming']);
    expect(screen.getByRole('link', { name: /Start: Your position/ })).toBeDefined();
  });
});
