/*
 * The localStorage keys this app writes.
 *
 * Kept in one dependency-free module on purpose. The migration key used to be
 * exported from the authorization flow, so the diagnostics page pulled in the
 * whole signing stack (and viem with it) to read one string — slow enough on a
 * cold start to time a test out.
 *
 * What may be stored is short and fixed: a migration id so a refresh can
 * resume monitoring, the explanation preferences, and the theme choice.
 * Signatures, prepared payloads and API keys are never stored.
 */

/** The last migration started from this browser. */
export const MIGRATION_STORAGE_KEY = 'debtshift:last-migration-id';

/** Set once the brand intro has played in this browser session (sessionStorage). */
export const INTRO_SEEN_KEY = 'debtshift:intro-seen';
