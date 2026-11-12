/*
 * Turning the recorded demo on and off.
 *
 * The flag lives in sessionStorage: it survives a reload, so a judge who
 * refreshes mid-tour stays in the tour, and it ends with the tab, so nobody
 * comes back days later to a session that silently is not live.
 */

import { resetClock } from '../clock';
import { DemoApi } from './demo-api';

const FLAG = 'debtshift:demo';

let client: DemoApi | undefined;

function storage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
}

/** True when this tab is in the recorded demo. */
export function isDemoActive(): boolean {
  return storage()?.getItem(FLAG) === '1';
}

/**
 * The demo's data source while the demo is active, otherwise `undefined`.
 * The API facade asks this on every call, so a reload inside the demo never
 * falls through to a real backend.
 */
export function demoClient(): DemoApi | undefined {
  if (!isDemoActive()) return undefined;
  client ??= new DemoApi();
  return client;
}

export function startDemo(): void {
  storage()?.setItem(FLAG, '1');
  client = new DemoApi();
}

export function stopDemo(): void {
  storage()?.removeItem(FLAG);
  client = undefined;
  resetClock();
}

export { DEMO_ACCOUNT, DEMO_CHAIN_ID, DEMO_MIGRATION_ID } from './demo-api';
