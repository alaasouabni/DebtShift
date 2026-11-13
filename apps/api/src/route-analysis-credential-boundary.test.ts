import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('route explanation credential boundary', () => {
  it('passes the request-only configuration solely to the sink-free explanation service', () => {
    const service = readFileSync(new URL('./route-analysis.service.ts', import.meta.url), 'utf8');
    const controller = readFileSync(
      new URL('./route-analysis.controller.ts', import.meta.url),
      'utf8',
    );
    const implementation = `${service}\n${controller}`;

    expect(service.match(/request\.explanation/g)).toHaveLength(1);
    expect(implementation).not.toMatch(
      /(?:DatabaseService|@debtshift\/database|postgres|redis|\bLogger\b|console\.|captureException|sendBeacon|Sentry|posthog|mixpanel)/,
    );
  });
});
