'use client';

/*
 * The landing page's motion layer: smooth scrolling (Lenis) and scroll-driven
 * animation (GSAP with ScrollTrigger).
 *
 * Rules it keeps:
 *   - the page is complete without it. Every animated element is visible in
 *     the markup; this layer hides things only at the moment it is about to
 *     animate them in;
 *   - a visitor who asked for reduced motion gets none of it, and neither
 *     does a test environment;
 *   - nothing here changes what a figure says. A counter starts from zero and
 *     always ends on the exact text the page rendered.
 *
 * The libraries load after the page is interactive, and everything is undone
 * when the visitor leaves the landing page.
 */

import { useEffect, type RefObject } from 'react';

import { introDelayMs } from '../../lib/intro';

const NUMBER = /-?\d[\d,]*(?:\.\d+)?/;

function motionAllowed(): boolean {
  if (typeof window === 'undefined') return false;
  if (navigator.userAgent.includes('jsdom')) return false;
  return !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

export function useLandingMotion(rootRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = rootRef.current;
    if (!root || !motionAllowed()) return;
    let cancelled = false;
    let undo: (() => void) | undefined;

    void Promise.all([import('gsap'), import('gsap/ScrollTrigger'), import('lenis')]).then(
      ([{ gsap }, { ScrollTrigger }, { default: Lenis }]) => {
        if (cancelled) return;
        gsap.registerPlugin(ScrollTrigger);

        const lenis = new Lenis({ lerp: 0.085, smoothWheel: true, wheelMultiplier: 0.95 });
        lenis.on('scroll', ScrollTrigger.update);
        const tick = (time: number) => lenis.raf(time * 1000);
        gsap.ticker.add(tick);
        gsap.ticker.lagSmoothing(0);

        const ctx = gsap.context(() => {
          /* Hero: the headline rises word by word, then everything else. */
          // On a first visit the brand intro is still on screen: start as its curtain lifts.
          const intro = gsap.timeline({
            defaults: { ease: 'expo.out' },
            delay: introDelayMs() / 1000,
          });
          intro
            .from('.hero-title .word__inner', { yPercent: 118, duration: 1.15, stagger: 0.05 })
            .from('[data-hero-fade]', { y: 26, autoAlpha: 0, duration: 1, stagger: 0.08 }, '-=0.85')
            .from('[data-hero-scene]', { autoAlpha: 0, scale: 0.92, y: 30, duration: 1.6 }, 0.1);

          /* The scene drifts up a little slower than the page. */
          gsap.to('[data-hero-scene]', {
            yPercent: -8,
            ease: 'none',
            scrollTrigger: {
              trigger: '.hero-section',
              start: 'top top',
              end: 'bottom top',
              scrub: 0.6,
            },
          });

          /* Section headings. */
          for (const heading of gsap.utils.toArray<HTMLElement>('[data-reveal-heading]')) {
            gsap.from(heading, {
              y: 56,
              autoAlpha: 0,
              duration: 1.2,
              ease: 'expo.out',
              scrollTrigger: { trigger: heading, start: 'top 88%', once: true },
            });
          }

          /* Cards and tiles arrive in small groups as they scroll in. */
          const tiles = gsap.utils.toArray<HTMLElement>('[data-reveal]');
          gsap.set(tiles, { autoAlpha: 0, y: 44 });
          ScrollTrigger.batch(tiles, {
            start: 'top 90%',
            once: true,
            onEnter: (batch) =>
              gsap.to(batch, {
                autoAlpha: 1,
                y: 0,
                duration: 1,
                ease: 'expo.out',
                stagger: 0.09,
                overwrite: true,
              }),
          });

          /* Figures count up to exactly what the page rendered. */
          for (const element of gsap.utils.toArray<HTMLElement>('[data-count]')) {
            const final = element.textContent ?? '';
            const match = NUMBER.exec(final);
            if (!match) continue;
            const raw = match[0];
            const decimals = raw.includes('.') ? raw.split('.')[1]!.length : 0;
            const target = Number(raw.replace(/,/g, ''));
            if (!Number.isFinite(target)) continue;
            const grouped = raw.includes(',');
            const format = (value: number) => {
              const fixed = value.toFixed(decimals);
              if (!grouped) return fixed;
              const [whole, fraction] = fixed.split('.');
              const withCommas = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
              return fraction === undefined ? withCommas : `${withCommas}.${fraction}`;
            };
            const counter = { value: 0 };
            element.textContent = final.replace(raw, format(0));
            gsap.to(counter, {
              value: target,
              duration: 1.8,
              ease: 'power3.out',
              scrollTrigger: { trigger: element, start: 'top 92%', once: true },
              onUpdate: () => {
                element.textContent = final.replace(raw, format(counter.value));
              },
              onComplete: () => {
                element.textContent = final;
              },
            });
          }

          /* Bands: slanted edges level out as each band arrives. */
          for (const band of gsap.utils.toArray<HTMLElement>('[data-band-slant]')) {
            gsap.fromTo(
              band,
              { '--slant': '150px' },
              {
                '--slant': '36px',
                ease: 'none',
                scrollTrigger: { trigger: band, start: 'top bottom', end: 'top 35%', scrub: 0.4 },
              },
            );
          }

          /* The deep bands open from a rounded card to the full width. */
          for (const band of gsap.utils.toArray<HTMLElement>('[data-band-expand]')) {
            gsap.fromTo(
              band,
              { clipPath: 'inset(0% 5% 0% 5% round 56px)' },
              {
                clipPath: 'inset(0% 0% 0% 0% round 0px)',
                ease: 'none',
                scrollTrigger: { trigger: band, start: 'top bottom', end: 'top 20%', scrub: 0.4 },
              },
            );
          }

          /* The large faint words slide across as their band scrolls by. */
          for (const word of gsap.utils.toArray<HTMLElement>('[data-band-word]')) {
            gsap.fromTo(
              word,
              { xPercent: 12 },
              {
                xPercent: -28,
                ease: 'none',
                scrollTrigger: {
                  trigger: word.parentElement ?? word,
                  start: 'top bottom',
                  end: 'bottom top',
                  scrub: 0.6,
                },
              },
            );
          }

          /* Each band's light drifts against the scroll. */
          for (const glow of gsap.utils.toArray<HTMLElement>('[data-band-glow]')) {
            gsap.fromTo(
              glow,
              { yPercent: -25 },
              {
                yPercent: 25,
                ease: 'none',
                scrollTrigger: {
                  trigger: glow.parentElement ?? glow,
                  start: 'top bottom',
                  end: 'bottom top',
                  scrub: 1,
                },
              },
            );
          }

          /* Chapter rules draw in; the number and label slide after them. */
          for (const chapter of gsap.utils.toArray<HTMLElement>('.chapter')) {
            const rule = chapter.querySelector('.chapter__rule');
            const parts = chapter.querySelectorAll('.chapter__index, .chapter__label');
            const timeline = gsap.timeline({
              scrollTrigger: { trigger: chapter, start: 'top 88%', once: true },
            });
            if (rule) timeline.from(rule, { scaleX: 0, duration: 1.2, ease: 'expo.out' }, 0);
            timeline.from(
              parts,
              { x: -18, autoAlpha: 0, duration: 0.8, ease: 'expo.out', stagger: 0.08 },
              0.1,
            );
          }

          /* The line through the four steps fills as the section scrolls. */
          const stepsLine = root.querySelector<HTMLElement>('.steps-line span');
          if (stepsLine) {
            gsap.fromTo(
              stepsLine,
              { scaleX: 0 },
              {
                scaleX: 1,
                ease: 'none',
                scrollTrigger: {
                  trigger: stepsLine.closest('section') ?? stepsLine,
                  start: 'top 70%',
                  end: 'bottom 70%',
                  scrub: 0.5,
                },
              },
            );
          }

          /* The story: pinned, one phase per stretch of scroll. */
          const story = root.querySelector<HTMLElement>('.story');
          const pin = story?.querySelector<HTMLElement>('.story__pin');
          const cards = story
            ? gsap.utils.toArray<HTMLElement>(story.querySelectorAll('.story__card'))
            : [];
          const phases = story
            ? gsap.utils.toArray<HTMLElement>(story.querySelectorAll('.story__phase'))
            : [];
          const bar = story?.querySelector<HTMLElement>('.story__progress span');
          if (story && pin && cards.length > 1 && window.innerWidth > 900) {
            story.dataset.pinned = 'true';
            let current = -1;
            const show = (index: number) => {
              if (index === current) return;
              current = index;
              cards.forEach((card, i) => {
                gsap.to(card, {
                  autoAlpha: i === index ? 1 : 0,
                  yPercent: i < index ? -6 : i > index ? 8 : 0,
                  scale: i === index ? 1 : 0.96,
                  rotateX: i === index ? 0 : i < index ? 6 : -6,
                  duration: 0.7,
                  ease: 'expo.out',
                  overwrite: true,
                });
              });
              phases.forEach((item, i) => {
                item.dataset.state = i < index ? 'done' : i === index ? 'current' : 'pending';
              });
            };
            gsap.set(cards, { autoAlpha: 0, transformPerspective: 1200 });
            show(0);
            ScrollTrigger.create({
              trigger: story,
              start: 'top top',
              end: () => `+=${Math.round(window.innerHeight * 0.6 * cards.length)}`,
              pin,
              scrub: true,
              onUpdate: (self) => {
                const index = Math.min(cards.length - 1, Math.floor(self.progress * cards.length));
                show(index);
                bar?.style.setProperty('--progress', self.progress.toFixed(4));
              },
            });
          }

          /* The closing card rises and its glow follows the pointer. */
          const cta = root.querySelector<HTMLElement>('.cta');
          if (cta) {
            gsap.from(cta, {
              y: 80,
              autoAlpha: 0,
              scale: 0.97,
              duration: 1.3,
              ease: 'expo.out',
              scrollTrigger: { trigger: cta, start: 'top 90%', once: true },
            });
          }
        }, root);

        ScrollTrigger.refresh();

        undo = () => {
          ctx.revert();
          gsap.ticker.remove(tick);
          lenis.destroy();
          delete root.querySelector<HTMLElement>('.story')?.dataset.pinned;
        };
      },
    );

    return () => {
      cancelled = true;
      undo?.();
    };
  }, [rootRef]);
}
