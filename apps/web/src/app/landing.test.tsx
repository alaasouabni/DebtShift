// @vitest-environment jsdom

/*
 * The landing page.
 *
 * Two things are checked here. First, that the 3D scene is one image with one
 * description to assistive technology and draws the stage it is given. Second,
 * that the use-case section says what the product is for with figures read
 * from the recording — not numbers typed into the page.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HeroScene } from '../components/hero/hero-scene';
import type { RouteAnalysisResponse } from '../lib/api/types';
import routesRecording from '../lib/demo/recordings/route-analysis.json' with { type: 'json' };
import { formatBps, formatDuration, formatUsdMicro } from '../lib/formatting';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/',
}));

const analysis = (routesRecording as unknown as RouteAnalysisResponse).analysis.analyses[0]!;
const route =
  analysis.comparison.evaluations.find((candidate) => candidate.eligible) ??
  analysis.comparison.evaluations[0]!;
const economics = route.economics;

const SOURCE = { protocol: 'Source Market', chain: 'Chain A', rateBps: 700, rateLabel: '7.00%' };
const DESTINATION = {
  protocol: 'Target Market',
  chain: 'Chain B',
  rateBps: 450,
  rateLabel: '4.50%',
};

async function renderLanding() {
  const { default: LandingPage } = await import('./page');
  const { WalletProvider } = await import('../features/wallet/wallet-context');
  return render(
    <WalletProvider>
      <LandingPage />
    </WalletProvider>,
  );
}

afterEach(() => {
  cleanup();
  window.sessionStorage.clear();
});

describe('the 3D hero scene', () => {
  it('is one image with one description', () => {
    render(<HeroScene stage="ready" source={SOURCE} destination={DESTINATION} />);
    const scene = screen.getByRole('img');
    const label = scene.getAttribute('aria-label') ?? '';
    expect(label).toContain('7.00%');
    expect(label).toContain('4.50%');
    expect(label).toContain('Source Market');
    expect(label).toContain('Target Market');
  });

  it('hides its moving parts from assistive technology', () => {
    const { container } = render(
      <HeroScene stage="ready" source={SOURCE} destination={DESTINATION} />,
    );
    expect(container.querySelector('.scene__stage')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('.scene__caption')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('starts with the loan standing on the source and nothing on the destination', () => {
    const { container } = render(
      <HeroScene stage="ready" source={SOURCE} destination={DESTINATION} />,
    );
    expect(container.querySelector('.scene__token')?.getAttribute('data-token')).toBe('on-source');
    expect(container.querySelector('.scene__loan--source')?.getAttribute('data-open')).toBe('true');
    expect(container.querySelector('.scene__loan--destination')?.getAttribute('data-open')).toBe(
      'false',
    );
    expect(container.querySelector('.scene__slab--destination')?.getAttribute('data-lit')).toBe(
      'false',
    );
  });

  it('does not show the new rate while value is still crossing', () => {
    const { container } = render(
      <HeroScene stage="in-transit" source={SOURCE} destination={DESTINATION} />,
    );
    expect(container.querySelector('.scene__token')?.getAttribute('data-token')).toBe('mid-air');
    expect(container.querySelector('.scene__tag--accent')?.getAttribute('data-open')).toBe('false');
    expect(container.querySelector('.scene__loan--source')?.getAttribute('data-open')).toBe(
      'false',
    );
  });

  it('ends with the loan standing on the destination, shorter than it was', () => {
    const { container } = render(
      <HeroScene stage="settled" source={SOURCE} destination={DESTINATION} />,
    );
    const column = container.querySelector<HTMLElement>('.scene__loan--destination');
    expect(column?.getAttribute('data-open')).toBe('true');
    expect(column?.style.getPropertyValue('--h')).toBe('4.5em');
    expect(container.querySelector('.scene__token')?.getAttribute('data-token')).toBe(
      'on-destination',
    );
  });

  it('names the stage it is drawing', () => {
    render(<HeroScene stage="in-transit" source={SOURCE} destination={DESTINATION} />);
    expect(screen.getByText('In transit')).toBeDefined();
  });
});

describe('the landing page', () => {
  it('leads with the scene and offers the demo without a wallet', async () => {
    await renderLanding();
    expect(screen.getByRole('img', { name: /Illustration: a loan at/i })).toBeDefined();
    expect(screen.getByRole('button', { name: /watch the recorded demo/i })).toBeDefined();
  });

  it('explains the use case in one sentence', async () => {
    await renderLanding();
    expect(
      screen.getByRole('heading', {
        name: /You already have a loan\. A cheaper one exists on another chain\./i,
      }),
    ).toBeDefined();
  });

  it('shows the example with figures read from the recording', async () => {
    await renderLanding();
    const section = screen.getByRole('region', { name: /You already have a loan/i });
    const example = within(section);

    expect(example.getByText('Interest saved per year').nextElementSibling?.textContent).toBe(
      formatUsdMicro(economics.annualGrossSavingsUsdMicro),
    );
    expect(example.getByText('One-off cost of moving').nextElementSibling?.textContent).toBe(
      formatUsdMicro(economics.allInCostUsdMicro),
    );
    expect(example.getByText('Pays for itself after').nextElementSibling?.textContent).toBe(
      formatDuration(Number(economics.breakEvenSeconds)),
    );
    expect(example.getByText(formatBps(economics.sourceAprBps))).toBeDefined();
    expect(example.getByText(formatBps(economics.targetAprAfterBps))).toBeDefined();
  });

  it('says the example is recorded test data, not a quote', async () => {
    await renderLanding();
    const section = within(screen.getByRole('region', { name: /You already have a loan/i }));
    expect(section.getByText(/Recorded example · test assets/i)).toBeDefined();
    expect(section.getByText(/not a quote for your position/i)).toBeDefined();
  });

  it('does not hide that a route was rejected in the same run', async () => {
    await renderLanding();
    const total = analysis.comparison.evaluations.length;
    const rejected = analysis.comparison.evaluations.filter((c) => !c.eligible).length;
    expect(rejected).toBeGreaterThan(0);
    expect(
      screen.getByText(new RegExp(`${rejected} of ${total} candidate routes in this run`)),
    ).toBeDefined();
  });

  it('sets the manual route beside the two-signature one', async () => {
    await renderLanding();
    const byHand = screen.getByRole('heading', { name: /Five steps, two chains/i }).parentElement!;
    const ours = screen.getByRole('heading', {
      name: /Two signatures, then you watch/i,
    }).parentElement!;

    expect(within(byHand).getAllByRole('listitem')).toHaveLength(5);
    expect(within(ours).getAllByRole('listitem')).toHaveLength(3);
    expect(within(ours).getByText(/refund path you signed/i)).toBeDefined();
  });

  it('never promises a completed migration or a guaranteed saving', async () => {
    const { container } = await renderLanding();
    expect(container.textContent).not.toMatch(/guarantee|risk-free|always cheaper/i);
  });
});

describe('stopping the animation', () => {
  function setReducedMotion(reduce: boolean) {
    window.matchMedia = ((query: string): MediaQueryList =>
      ({
        matches: reduce && query.includes('prefers-reduced-motion'),
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      }) as unknown as MediaQueryList) as typeof window.matchMedia;
  }

  afterEach(() => {
    delete (window as { matchMedia?: unknown }).matchMedia;
  });

  it('offers a control to pause the illustration', async () => {
    setReducedMotion(false);
    await renderLanding();
    const toggle = screen.getByRole('button', { name: /pause animation/i });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(toggle);
    const paused = screen.getByRole('button', { name: /play animation/i });
    expect(paused.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('.motion-paused')).not.toBeNull();
  });

  it('starts stopped for a visitor who asked for reduced motion', async () => {
    setReducedMotion(true);
    await renderLanding();
    expect(await screen.findByRole('button', { name: /play animation/i })).toBeDefined();
  });
});
