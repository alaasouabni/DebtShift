/*
 * What environment is this, according to the backend?
 *
 * The strategy update of 2026-11-12 made DebtShift one provider-neutral
 * workflow composed as `sandbox`, `testnet`, `mainnet-readonly` or `mainnet`,
 * and the frontend contract now says: consume backend capability metadata,
 * never infer the mode from the hostname, never expose a mode switch.
 *
 * Two shapes exist in the wild while the backend catches up with that
 * contract, so both are read here and nowhere else:
 *
 *   - legacy, what the API returns today:
 *       simulation: { provider: 'DEBTSHIFT_SIMULATOR', mode: 'SIMULATED', warning }
 *   - target, what `13-frontend-handoff.md` now specifies:
 *       environment: { mode, transportProvider, executionEnabled, warning? }
 *
 * When neither is present this returns `undefined` and the UI fails closed —
 * it says the environment is unknown and refuses to submit. It does not
 * assume a sandbox.
 */

import type { Tone } from '../labels';

export const ENVIRONMENT_MODES = ['sandbox', 'testnet', 'mainnet-readonly', 'mainnet'] as const;
export type EnvironmentMode = (typeof ENVIRONMENT_MODES)[number];

export type TransportProviderName = 'DEBTSHIFT_SIMULATOR' | 'NEAR_INTENTS_1CLICK';

export interface BackendEnvironment {
  readonly mode: EnvironmentMode;
  readonly transportProvider: TransportProviderName;
  /** The effective execution capability the backend reports. Never set here. */
  readonly executionEnabled: boolean;
  readonly warning?: string | undefined;
  /** Which response shape this was read from. */
  readonly source: 'environment' | 'legacy-simulation';
}

export function isEnvironmentMode(value: unknown): value is EnvironmentMode {
  return ENVIRONMENT_MODES.includes(value as EnvironmentMode);
}

function isTransportProvider(value: unknown): value is TransportProviderName {
  return value === 'DEBTSHIFT_SIMULATOR' || value === 'NEAR_INTENTS_1CLICK';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Read the environment out of a `prepare` response, whichever shape it has.
 *
 * The target shape wins when both are present. A malformed `environment`
 * object is NOT patched up with defaults: an unknown mode or a non-boolean
 * `executionEnabled` yields `undefined`, because guessing either one is the
 * exact inference the contract forbids.
 */
export function readEnvironment(prepared: unknown): BackendEnvironment | undefined {
  const root = asRecord(prepared);
  if (root === undefined) return undefined;

  const environment = asRecord(root.environment);
  if (environment !== undefined) {
    if (
      !isEnvironmentMode(environment.mode) ||
      !isTransportProvider(environment.transportProvider) ||
      typeof environment.executionEnabled !== 'boolean'
    ) {
      return undefined;
    }
    return {
      mode: environment.mode,
      transportProvider: environment.transportProvider,
      executionEnabled: environment.executionEnabled,
      warning: typeof environment.warning === 'string' ? environment.warning : undefined,
      source: 'environment',
    };
  }

  const simulation = asRecord(root.simulation);
  if (simulation !== undefined && simulation.provider === 'DEBTSHIFT_SIMULATOR') {
    /*
     * The legacy shape is only ever produced by the contract-backed dual-Anvil
     * workflow, which the strategy now calls `sandbox`, and that workflow does
     * execute — with test assets.
     */
    return {
      mode: 'sandbox',
      transportProvider: 'DEBTSHIFT_SIMULATOR',
      executionEnabled: true,
      warning: typeof simulation.warning === 'string' ? simulation.warning : undefined,
      source: 'legacy-simulation',
    };
  }

  return undefined;
}

export interface EnvironmentBadge {
  readonly label: string;
  readonly tone: Tone;
  readonly title: string;
}

/**
 * The badge wording, from the frontend contract's "Environment and safety
 * labels" section. `undefined` — the backend reported nothing readable — gets
 * its own wording rather than a comfortable default.
 */
export function environmentBadge(environment: BackendEnvironment | undefined): EnvironmentBadge {
  if (environment === undefined) {
    return {
      label: 'Environment not reported',
      tone: 'warning',
      title:
        'The backend did not report an environment this app can read. Nothing can be submitted.',
    };
  }

  switch (environment.mode) {
    case 'sandbox':
      return {
        label: 'Contract-backed sandbox · test funds',
        tone: 'accent',
        title:
          'Real contract transactions on private chains with test assets. Only the cross-chain transport provider is simulated.',
      };
    case 'testnet':
      return {
        label: 'Public testnet · simulated transport',
        tone: 'accent',
        title:
          'Real public testnet transactions. The transport is simulated because 1Click has no public testnet.',
      };
    case 'mainnet-readonly':
      return {
        label: 'Live market data · execution disabled',
        tone: 'neutral',
        title: 'Live reads and dry quotes only. Nothing can be executed in this mode.',
      };
    case 'mainnet':
      return environment.executionEnabled
        ? {
            label: 'Mainnet · real funds',
            tone: 'danger',
            title: 'The backend reports mainnet execution as enabled. Real funds will move.',
          }
        : {
            label: 'Mainnet execution disabled',
            tone: 'neutral',
            title:
              'The backend reports mainnet execution as disabled. Only the server can change that.',
          };
  }
}

/**
 * Whether the UI may offer to submit.
 *
 * `MAINNET_EXECUTION_ENABLED` is defined by the strategy as a MAINNET switch
 * that must be false in sandbox and testnet — where the workflow still has to
 * execute. So `executionEnabled` gates the two mainnet modes, read-only is
 * never submittable, and an unreported environment is never submittable.
 *
 * This is a UI courtesy. The backend rejects a disallowed command itself; a
 * browser control can never enable execution.
 */
export function canSubmit(environment: BackendEnvironment | undefined): boolean {
  if (environment === undefined) return false;
  if (environment.mode === 'mainnet-readonly') return false;
  if (environment.mode === 'mainnet') return environment.executionEnabled;
  return true;
}

/** Why submission is unavailable, in words, or `undefined` when it is available. */
export function submitBlockedReason(
  environment: BackendEnvironment | undefined,
): string | undefined {
  if (environment === undefined) {
    return 'The backend did not report an environment this app can read, so nothing can be submitted.';
  }
  if (environment.mode === 'mainnet-readonly') {
    return 'This is a read-only environment. Live data and dry quotes do not authorize execution.';
  }
  if (environment.mode === 'mainnet' && !environment.executionEnabled) {
    return 'Mainnet execution is disabled on the server. Nothing in this browser can enable it.';
  }
  return undefined;
}

/** True when the transport-provider observations in this environment are simulated. */
export function transportIsSimulated(environment: BackendEnvironment | undefined): boolean {
  return environment?.transportProvider === 'DEBTSHIFT_SIMULATOR';
}

/**
 * The label shown before the backend has reported anything — on the landing
 * page, or on a monitor opened after a reload.
 *
 * `NEXT_PUBLIC_DEBTSHIFT_MODE` is deployment configuration that mirrors the
 * server's `DEBTSHIFT_MODE`. It only chooses a LABEL until real metadata
 * arrives; it never gates or enables anything, and backend metadata replaces
 * it the moment a response carries some. A capability endpoint on the API
 * would make this unnecessary.
 */
export function defaultEnvironmentMode(): EnvironmentMode | undefined {
  const configured = process.env.NEXT_PUBLIC_DEBTSHIFT_MODE;
  return isEnvironmentMode(configured) ? configured : undefined;
}

/** The badge for a configured default mode, clearly not a backend report. */
export function defaultBadge(mode: EnvironmentMode | undefined): EnvironmentBadge {
  if (mode === undefined) {
    return {
      label: 'Environment not reported yet',
      tone: 'neutral',
      title: 'The backend reports the environment when you prepare an authorization.',
    };
  }
  const badge = environmentBadge({
    mode,
    transportProvider:
      mode === 'mainnet' || mode === 'mainnet-readonly'
        ? 'NEAR_INTENTS_1CLICK'
        : 'DEBTSHIFT_SIMULATOR',
    // A configured label never claims execution is enabled.
    executionEnabled: false,
    source: 'environment',
  });
  return {
    ...badge,
    title: `${badge.title} (Configured for this deployment; the backend confirms it on prepare.)`,
  };
}
