'use client';

/*
 * The environment the backend last reported, shared with the shell.
 *
 * The header badge has to stay visible through preparation, signing and
 * monitoring, but the only response that carries environment metadata today is
 * `prepare`. So the authorization flow reports what it received here, and the
 * badge shows it from then on. Until then the badge shows the deployment's
 * configured label, marked as not yet confirmed.
 *
 * Nothing in this module can change what the backend allows.
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

import {
  defaultBadge,
  defaultEnvironmentMode,
  environmentBadge,
  type BackendEnvironment,
  type EnvironmentBadge,
} from '../../lib/environment';

interface EnvironmentState {
  /** What the backend reported, or undefined before any report. */
  readonly reported: BackendEnvironment | undefined;
  /** True once a backend response carried environment metadata. */
  readonly confirmed: boolean;
  readonly badge: EnvironmentBadge;
  report(environment: BackendEnvironment | undefined): void;
}

const EnvironmentContext = createContext<EnvironmentState | undefined>(undefined);

export function EnvironmentProvider({ children }: { readonly children: ReactNode }) {
  const [reported, setReported] = useState<BackendEnvironment | undefined>(undefined);
  const [confirmed, setConfirmed] = useState(false);

  const report = useCallback((environment: BackendEnvironment | undefined) => {
    setReported(environment);
    setConfirmed(true);
  }, []);

  const value = useMemo<EnvironmentState>(
    () => ({
      reported,
      confirmed,
      badge: confirmed ? environmentBadge(reported) : defaultBadge(defaultEnvironmentMode()),
      report,
    }),
    [reported, confirmed, report],
  );

  return <EnvironmentContext.Provider value={value}>{children}</EnvironmentContext.Provider>;
}

/**
 * The environment state.
 *
 * Outside a provider — a component test that mounts one view on its own — it
 * degrades to the unconfirmed default and a no-op `report`, so views do not
 * need a wrapper just to render.
 */
export function useEnvironment(): EnvironmentState {
  const state = useContext(EnvironmentContext);
  return (
    state ?? {
      reported: undefined,
      confirmed: false,
      badge: defaultBadge(defaultEnvironmentMode()),
      report: () => undefined,
    }
  );
}
