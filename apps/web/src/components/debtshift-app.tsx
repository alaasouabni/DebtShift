'use client';

import {
  getExecutionPlanTypedData,
  getRefinanceIntentTypedData,
  type ExecutionPlan,
  type PositionSnapshot,
  type ProviderQuote,
  type RefinanceIntent,
} from '@debtshift/domain';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createWalletClient, custom, type Address, type EIP1193Provider, type Hex } from 'viem';

const apiBase = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/v1';
const terminalPhases = new Set(['COMPLETED', 'FAILED_SAFE', 'REQUOTE_REQUIRED', 'EXPIRED']);
const warningPhases = new Set(['RECOVERY', 'FAILED_SAFE', 'REQUOTE_REQUIRED', 'EXPIRED']);

interface PreparedMigration {
  readonly simulation: {
    readonly provider: 'DEBTSHIFT_SIMULATOR';
    readonly mode: 'SIMULATED';
    readonly warning: string;
  };
  readonly verifyingContract: Address;
  readonly intent: RefinanceIntent;
  readonly intentHash: Hex;
  readonly plan: ExecutionPlan;
  readonly planHash: Hex;
  readonly quote: ProviderQuote;
  readonly sourceSnapshot: PositionSnapshot;
  readonly routeAnalysis: RouteAnalysisResponse;
}

type ExplanationMode = 'DETERMINISTIC' | 'LOCAL_AI' | 'USER_API';
type RemoteProvider = 'OPENAI' | 'OPENROUTER' | 'CUSTOM';
type ExplanationRequest =
  | { readonly mode: 'DETERMINISTIC' }
  | { readonly mode: 'LOCAL_AI'; readonly baseUrl: string; readonly model: string }
  | {
      readonly mode: 'USER_API';
      readonly provider: RemoteProvider;
      readonly model: string;
      readonly apiKey: string;
      readonly baseUrl?: string;
    };

interface RouteEvaluation {
  readonly candidateId: string;
  readonly eligible: boolean;
  readonly rank?: number;
  readonly scoreUsdMicro: string;
  readonly economics: {
    readonly sourceAprBps: number;
    readonly targetAprBeforeBps: number;
    readonly targetAprAfterBps: number;
    readonly targetRateImpactBps: number;
    readonly aprReductionBps: number;
    readonly stressTargetAprBps: number;
    readonly allInCostUsdMicro: string;
    readonly grossSavingsUsdMicro: string;
    readonly stressGrossSavingsUsdMicro: string;
    readonly netBenefitUsdMicro: string;
    readonly stressNetBenefitUsdMicro: string;
    readonly breakEvenSeconds?: string;
  };
  readonly safety:
    | {
        readonly kind: 'MAX_LTV_BPS';
        readonly postLtvBps: number;
        readonly stressLtvBps: number;
        readonly maximumLtvBps: number;
        readonly stressMaximumLtvBps: number;
      }
    | {
        readonly kind: 'MIN_HEALTH_FACTOR_WAD';
        readonly postHealthFactorWad: string;
        readonly stressHealthFactorWad: string;
        readonly minimumWad: string;
        readonly stressMinimumWad: string;
      };
  readonly rejections: readonly { readonly code: string; readonly message: string }[];
  readonly provenance: {
    readonly marketBlockNumber: string;
    readonly marketBlockHash: string;
    readonly oracleUpdatedAt: string;
    readonly evaluatedAt: string;
    readonly rateProjection: string;
  };
}

interface RouteExplanation {
  readonly summary: string;
  readonly mainEconomicBenefit: string;
  readonly mainRisks: readonly string[];
  readonly breakEvenExplanation: string;
  readonly safetyExplanation: string;
  readonly dataFreshnessWarning: string;
  readonly reviewAndSignStatement: string;
}

interface RouteAnalysisResponse {
  readonly analysis: {
    readonly agent: 'DEBTSHIFT_ROUTE_RISK_AGENT';
    readonly deterministic: true;
    readonly analyses: readonly {
      readonly sourcePosition: PositionSnapshot;
      readonly comparison: {
        readonly selectedCandidateId?: string;
        readonly evaluations: readonly RouteEvaluation[];
      };
    }[];
  };
  readonly explanations: readonly {
    readonly sourceSnapshotId: string;
    readonly result: {
      readonly decisionHash: string;
      readonly provider: ExplanationMode;
      readonly fallbackUsed: boolean;
      readonly explanation: RouteExplanation;
    };
  }[];
}

interface MigrationEvidence {
  readonly evidenceId: string;
  readonly type: string;
  readonly provider: string;
  readonly network: string;
  readonly transactionHash: string | null;
  readonly observedAt: string;
  readonly verificationState: string;
}

interface MigrationDetails {
  readonly migration: {
    readonly migrationId: string;
    readonly phase: string;
    readonly updatedAt: string;
  };
  readonly evidence: readonly MigrationEvidence[];
  readonly commands: readonly {
    readonly commandId: string;
    readonly type: string;
    readonly status: string;
    readonly lastError: string | null;
  }[];
}

type BusyAction = 'connect' | 'prepare' | 'authorize' | 'explain' | null;

export function DebtShiftApp() {
  const [account, setAccount] = useState<Address>();
  const [provider, setProvider] = useState<EIP1193Provider>();
  const [position, setPosition] = useState<PositionSnapshot>();
  const [routeAnalysis, setRouteAnalysis] = useState<RouteAnalysisResponse>();
  const [prepared, setPrepared] = useState<PreparedMigration>();
  const [migrationId, setMigrationId] = useState<string>();
  const [migration, setMigration] = useState<MigrationDetails>();
  const [busy, setBusy] = useState<BusyAction>(null);
  const [error, setError] = useState<string>();
  const [explanationMode, setExplanationMode] = useState<ExplanationMode>('DETERMINISTIC');
  const [remoteProvider, setRemoteProvider] = useState<RemoteProvider>('OPENAI');
  const [aiModel, setAiModel] = useState('qwen3.5:4b');
  const [ollamaBaseUrl, setOllamaBaseUrl] = useState('http://127.0.0.1:11434');
  const [customBaseUrl, setCustomBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');

  const loadMigration = useCallback(async (id: string) => {
    const details = await api<MigrationDetails>(`/migrations/${id}`);
    setMigration(details);
    return details;
  }, []);

  useEffect(() => {
    if (migrationId === undefined) return;
    let mounted = true;
    const poll = async () => {
      try {
        const details = await loadMigration(migrationId);
        if (!mounted || terminalPhases.has(details.migration.phase)) return;
      } catch (pollError) {
        if (mounted) setError(messageOf(pollError));
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1_500);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [loadMigration, migrationId]);

  const connect = async () => {
    setBusy('connect');
    setError(undefined);
    try {
      const injected = getInjectedProvider();
      const wallet = createWalletClient({ transport: custom(injected) });
      const [selected] = await wallet.requestAddresses();
      if (selected === undefined) throw new Error('The wallet returned no account.');
      const [positions, analysis] = await Promise.all([
        api<PositionSnapshot[]>(`/positions/${selected}`),
        api<RouteAnalysisResponse>('/analysis/routes', {
          method: 'POST',
          body: JSON.stringify({ wallet: selected, explanation: { mode: 'DETERMINISTIC' } }),
        }),
      ]);
      if (positions[0] === undefined) throw new Error('No supported source position was found.');
      setProvider(injected);
      setAccount(selected);
      setPosition(positions[0]);
      setRouteAnalysis(analysis);
      setPrepared(undefined);
      setMigration(undefined);
      setMigrationId(undefined);
    } catch (connectError) {
      setError(messageOf(connectError));
    } finally {
      setBusy(null);
    }
  };

  const prepare = async () => {
    if (account === undefined) return;
    setBusy('prepare');
    setError(undefined);
    try {
      const result = await api<PreparedMigration>('/migrations/prepare', {
        method: 'POST',
        body: JSON.stringify({ borrower: account }),
      });
      setPrepared(result);
      setPosition(result.sourceSnapshot);
      setRouteAnalysis(result.routeAnalysis);
    } catch (prepareError) {
      setError(messageOf(prepareError));
    } finally {
      setBusy(null);
    }
  };

  const refreshExplanation = async () => {
    if (account === undefined) return;
    setBusy('explain');
    setError(undefined);
    try {
      const explanation = explanationRequest({
        mode: explanationMode,
        remoteProvider,
        aiModel,
        ollamaBaseUrl,
        customBaseUrl,
        apiKey,
      });
      const result = await api<RouteAnalysisResponse>('/analysis/routes', {
        method: 'POST',
        body: JSON.stringify({ wallet: account, explanation }),
      });
      setRouteAnalysis(result);
      setPosition(result.analysis.analyses[0]?.sourcePosition);
    } catch (explanationError) {
      setError(messageOf(explanationError));
    } finally {
      setBusy(null);
    }
  };

  const authorizeAndExecute = async () => {
    if (account === undefined || provider === undefined || prepared === undefined) return;
    setBusy('authorize');
    setError(undefined);
    try {
      const wallet = createWalletClient({ transport: custom(provider) });
      const intentSignature = await wallet.signTypedData({
        account,
        ...getRefinanceIntentTypedData(prepared.intent, prepared.verifyingContract),
      });
      const planSignature = await wallet.signTypedData({
        account,
        ...getExecutionPlanTypedData(prepared.plan, prepared.verifyingContract),
      });
      const result = await api<{ migrationId: string }>('/migrations/execute', {
        method: 'POST',
        body: JSON.stringify({
          signedIntent: {
            intent: prepared.intent,
            intentHash: prepared.intentHash,
            signature: intentSignature,
          },
          signedPlan: {
            plan: prepared.plan,
            planHash: prepared.planHash,
            signature: planSignature,
          },
          quote: prepared.quote,
          sourceSnapshot: prepared.sourceSnapshot,
        }),
      });
      setMigrationId(result.migrationId);
      await loadMigration(result.migrationId);
    } catch (authorizationError) {
      setError(messageOf(authorizationError));
    } finally {
      setBusy(null);
    }
  };

  const economics = useMemo(() => {
    if (prepared === undefined) return undefined;
    return {
      debt: formatUnits(prepared.sourceSnapshot.debtUnits, 6),
      collateral: formatUnits(prepared.sourceSnapshot.collateralUnits, 18),
      destinationMinimum: formatUnits(prepared.plan.minDestinationCollateralUnits, 18),
      maximumFee: formatUnits(prepared.plan.feeMaxUnits, 6),
    };
  }, [prepared]);
  const comparison = routeAnalysis?.analysis.analyses[0]?.comparison;
  const explained = routeAnalysis?.explanations[0]?.result;

  return (
    <main>
      <nav className="nav" aria-label="Primary navigation">
        <a className="brand" href="#top" aria-label="DebtShift home">
          <span className="brandMark">D</span>
          <span>DebtShift</span>
        </a>
        <div className="environment">
          <span className="statusDot" /> Simulator / test funds
        </div>
      </nav>

      <section className="hero" id="top">
        <div className="eyebrow">Evidence-driven cross-chain refinancing</div>
        <h1>
          Move debt with <span>proof,</span>
          <br /> not promises.
        </h1>
        <p className="lede">
          Review the exact route, sign bounded terms, and follow every finalized source, transport,
          destination, and settlement observation.
        </p>
        <div className="actions">
          <button type="button" onClick={() => void connect()} disabled={busy !== null}>
            {busy === 'connect'
              ? 'Reading position…'
              : account
                ? shortAddress(account)
                : 'Connect test wallet'}
          </button>
          <a href="#workspace">Open workspace</a>
        </div>
        <div className="boundary" role="note">
          <strong>Safe demonstration boundary</strong>
          <span>Test assets only</span>
          <span>DebtShift simulator—not 1Click testnet</span>
          <span>Two explicit wallet signatures</span>
        </div>
      </section>

      <section className="workspace" id="workspace" aria-labelledby="workspace-title">
        <header className="workspaceHeader">
          <div>
            <p className="sectionLabel">Borrower workspace</p>
            <h2 id="workspace-title">One position. Exact limits. Verifiable progress.</h2>
          </div>
          <PhaseBadge phase={migration?.migration.phase ?? (prepared ? 'REVIEW' : 'DISCOVERY')} />
        </header>

        {error && (
          <div className="error" role="alert">
            <strong>Action stopped</strong>
            <span>{error}</span>
          </div>
        )}

        <section className="analysisPanel" aria-labelledby="analysis-title">
          <header className="analysisHeader">
            <div>
              <p className="sectionLabel">Deterministic Route / Risk Agent</p>
              <h3 id="analysis-title">Compare the economics before authorizing anything.</h3>
            </div>
            <div className="agentBoundary">
              <strong>Read-only agent</strong>
              <span>No signing, broadcasting, reservations, or transfers</span>
            </div>
          </header>

          {comparison ? (
            <div className="routeCards">
              {comparison.evaluations.map((route) => (
                <RouteCard
                  key={route.candidateId}
                  route={route}
                  selected={route.candidateId === comparison.selectedCandidateId}
                />
              ))}
            </div>
          ) : (
            <EmptyState>Connect the funded test wallet to compare route outcomes.</EmptyState>
          )}

          <div className="explanationWorkspace">
            <form
              className="providerSettings"
              onSubmit={(event) => {
                event.preventDefault();
                void refreshExplanation();
              }}
            >
              <div className="providerHeading">
                <div>
                  <span>Explanation provider</span>
                  <strong>Financial decisions stay deterministic</strong>
                </div>
                <span className="modePill">{explanationMode.replace('_', ' ')}</span>
              </div>
              <label>
                Mode
                <select
                  value={explanationMode}
                  onChange={(event) => setExplanationMode(event.target.value as ExplanationMode)}
                >
                  <option value="DETERMINISTIC">DebtShift financial agent (default)</option>
                  <option value="LOCAL_AI">Local Ollama</option>
                  <option value="USER_API">My AI API</option>
                </select>
              </label>

              {explanationMode === 'LOCAL_AI' && (
                <div className="fieldGrid">
                  <label>
                    Ollama URL
                    <input
                      type="url"
                      value={ollamaBaseUrl}
                      onChange={(event) => setOllamaBaseUrl(event.target.value)}
                      autoComplete="off"
                    />
                  </label>
                  <label>
                    Model
                    <input
                      value={aiModel}
                      onChange={(event) => setAiModel(event.target.value)}
                      autoComplete="off"
                    />
                  </label>
                </div>
              )}

              {explanationMode === 'USER_API' && (
                <>
                  <div className="fieldGrid">
                    <label>
                      Provider
                      <select
                        value={remoteProvider}
                        onChange={(event) =>
                          setRemoteProvider(event.target.value as RemoteProvider)
                        }
                      >
                        <option value="OPENAI">OpenAI-compatible preset</option>
                        <option value="OPENROUTER">OpenRouter preset</option>
                        <option value="CUSTOM">Custom compatible endpoint</option>
                      </select>
                    </label>
                    <label>
                      Model identifier
                      <input
                        value={aiModel}
                        onChange={(event) => setAiModel(event.target.value)}
                        autoComplete="off"
                      />
                    </label>
                  </div>
                  {remoteProvider === 'CUSTOM' && (
                    <label>
                      HTTPS API base URL
                      <input
                        type="url"
                        value={customBaseUrl}
                        onChange={(event) => setCustomBaseUrl(event.target.value)}
                        placeholder="https://provider.example/v1/"
                        autoComplete="off"
                      />
                    </label>
                  )}
                  <label>
                    Request-only API key
                    <input
                      type="password"
                      value={apiKey}
                      onChange={(event) => setApiKey(event.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </label>
                  <p className="credentialNotice">
                    Held only in this page&apos;s memory and sent through the DebtShift backend for
                    this explanation request. It is never written to browser storage or the
                    database.
                  </p>
                </>
              )}

              <button
                type="submit"
                className="secondaryAction"
                disabled={!account || busy !== null}
              >
                {busy === 'explain' ? 'Validating explanation…' : 'Explain the fixed decision'}
              </button>
            </form>

            <div className="explanationResult" aria-live="polite">
              {explained ? (
                <>
                  <div className="explanationMeta">
                    <span>{explained.provider.replace('_', ' ')}</span>
                    <code>{shortHash(explained.decisionHash)}</code>
                  </div>
                  {explained.fallbackUsed && (
                    <div className="fallbackNotice">
                      The selected provider failed validation; DebtShift used its deterministic
                      template.
                    </div>
                  )}
                  <h4>{explained.explanation.summary}</h4>
                  <p>{explained.explanation.mainEconomicBenefit}</p>
                  <ul>
                    {explained.explanation.mainRisks.map((risk) => (
                      <li key={risk}>{risk}</li>
                    ))}
                  </ul>
                  <p>{explained.explanation.breakEvenExplanation}</p>
                  <p>{explained.explanation.safetyExplanation}</p>
                  <small>{explained.explanation.dataFreshnessWarning}</small>
                  <strong className="reviewStatement">
                    {explained.explanation.reviewAndSignStatement}
                  </strong>
                </>
              ) : (
                <EmptyState>
                  The default financial agent explains the selected outcome without an API key or
                  local model.
                </EmptyState>
              )}
            </div>
          </div>
        </section>

        <div className="workspaceGrid">
          <section className="panel sourcePanel" aria-labelledby="source-title">
            <div className="panelHeading">
              <span>01 / Source</span>
              <h3 id="source-title">Current loan</h3>
            </div>
            {position ? (
              <dl className="metrics">
                <Metric
                  label="Collateral"
                  value={`${formatUnits(position.collateralUnits, 18)} sWETH`}
                />
                <Metric label="Debt" value={`${formatUnits(position.debtUnits, 6)} sUSDC`} />
                <Metric label="Borrow APR" value={`${(position.borrowAprBps / 100).toFixed(2)}%`} />
                <Metric label="Snapshot block" value={`#${position.block.number}`} compact />
              </dl>
            ) : (
              <EmptyState>
                Connect the funded Anvil borrower account to read its source position.
              </EmptyState>
            )}
            {position && prepared === undefined && (
              <button
                className="primaryAction"
                type="button"
                onClick={() => void prepare()}
                disabled={busy !== null}
              >
                {busy === 'prepare' ? 'Preparing exact route…' : 'Prepare refinance route'}
              </button>
            )}
          </section>

          <section className="panel routePanel" aria-labelledby="route-title">
            <div className="panelHeading">
              <span>02 / Route</span>
              <h3 id="route-title">Bounded execution</h3>
            </div>
            {prepared && economics ? (
              <>
                <div className="routeLine">
                  <div>
                    <small>Local Base-like</small>
                    <strong>Aave-compatible</strong>
                  </div>
                  <span aria-hidden="true">→</span>
                  <div>
                    <small>Local Arbitrum-like</small>
                    <strong>Morpho-compatible</strong>
                  </div>
                </div>
                <dl className="routeTerms">
                  <Metric label="Repay up to" value={`${economics.debt} sUSDC`} />
                  <Metric
                    label="Receive at least"
                    value={`${economics.destinationMinimum} dWETH`}
                  />
                  <Metric label="Maximum fee" value={`${economics.maximumFee} sUSDC`} />
                  <Metric label="Deadline" value={formatTime(prepared.plan.deadline)} compact />
                </dl>
                <div className="simulationWarning">{prepared.simulation.warning}</div>
                {migrationId === undefined && (
                  <button
                    className="primaryAction"
                    type="button"
                    onClick={() => void authorizeAndExecute()}
                    disabled={busy !== null}
                  >
                    {busy === 'authorize'
                      ? 'Check your wallet twice…'
                      : 'Sign intent + execution plan'}
                  </button>
                )}
              </>
            ) : (
              <EmptyState>
                The server will bind token addresses, receivers, caps, quote hash, nonce, and
                deadline before signing.
              </EmptyState>
            )}
          </section>

          <section className="panel evidencePanel" aria-labelledby="evidence-title">
            <div className="panelHeading">
              <span>03 / Evidence</span>
              <h3 id="evidence-title">Migration timeline</h3>
            </div>
            {migration ? (
              <>
                <div className="migrationIdentity">
                  <span>{migration.migration.phase.replaceAll('_', ' ')}</span>
                  <code>{shortHash(migration.migration.migrationId)}</code>
                </div>
                <ol className="timeline">
                  {migration.evidence.map((record) => (
                    <li key={record.evidenceId}>
                      <span className="evidenceDot" />
                      <div>
                        <strong>{labelEvidence(record.type)}</strong>
                        <small>
                          {record.provider} · {record.verificationState}
                        </small>
                        {record.transactionHash && <code>{shortHash(record.transactionHash)}</code>}
                      </div>
                    </li>
                  ))}
                </ol>
                {migration.commands.some((command) => command.lastError) && (
                  <div className="commandNote">
                    A retry is waiting on verified state; no duplicate transfer will be created.
                  </div>
                )}
              </>
            ) : (
              <EmptyState>
                Finalized observations appear here after the signed migration enters the durable
                outbox.
              </EmptyState>
            )}
          </section>
        </div>
      </section>

      <footer>
        <span>DebtShift / local engineering release</span>
        <span>Deterministic policy · evidence before state</span>
      </footer>
    </main>
  );
}

function RouteCard({
  route,
  selected,
}: {
  readonly route: RouteEvaluation;
  readonly selected: boolean;
}) {
  const safety =
    route.safety.kind === 'MAX_LTV_BPS'
      ? `${formatBps(route.safety.postLtvBps)} / ${formatBps(route.safety.stressLtvBps)} stressed`
      : `${formatWad(route.safety.postHealthFactorWad)} / ${formatWad(route.safety.stressHealthFactorWad)} stressed`;
  return (
    <article
      className={`routeCard ${selected ? 'selected' : ''} ${route.eligible ? '' : 'rejected'}`}
    >
      <header>
        <div>
          <span>
            {selected ? 'Selected by policy' : route.eligible ? `Rank ${route.rank}` : 'Rejected'}
          </span>
          <h4>{humanize(route.candidateId)}</h4>
        </div>
        <span className="routeStatus">{route.eligible ? 'Eligible' : 'Ineligible'}</span>
      </header>
      <dl className="routeEconomics">
        <Metric label="Projected APR" value={formatBps(route.economics.targetAprAfterBps)} />
        <Metric label="APR reduction" value={formatBps(route.economics.aprReductionBps)} />
        <Metric label="All-in cost" value={formatUsdMicro(route.economics.allInCostUsdMicro)} />
        <Metric
          label="180-day savings"
          value={formatUsdMicro(route.economics.grossSavingsUsdMicro)}
        />
        <Metric label="180-day net" value={formatUsdMicro(route.economics.netBenefitUsdMicro)} />
        <Metric label="Post / stress safety" value={safety} compact />
      </dl>
      <div className="scenarioRow">
        <span>
          Stress net <strong>{formatUsdMicro(route.economics.stressNetBenefitUsdMicro)}</strong>
        </span>
        <span>
          Break-even{' '}
          <strong>
            {route.economics.breakEvenSeconds
              ? `${formatDays(route.economics.breakEvenSeconds)} days`
              : 'none'}
          </strong>
        </span>
      </div>
      {route.rejections.length > 0 && (
        <ul className="rejectionList">
          {route.rejections.map((rejection) => (
            <li key={rejection.code}>
              <strong>{humanize(rejection.code)}</strong>
              <span>{rejection.message}</span>
            </li>
          ))}
        </ul>
      )}
      <footer className="routeProvenance">
        <span>Market block #{route.provenance.marketBlockNumber}</span>
        <code>{shortHash(route.provenance.marketBlockHash)}</code>
      </footer>
    </article>
  );
}

function Metric({
  label,
  value,
  compact = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly compact?: boolean;
}) {
  return (
    <div className={compact ? 'metric compact' : 'metric'}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function explanationRequest(input: {
  readonly mode: ExplanationMode;
  readonly remoteProvider: RemoteProvider;
  readonly aiModel: string;
  readonly ollamaBaseUrl: string;
  readonly customBaseUrl: string;
  readonly apiKey: string;
}): ExplanationRequest {
  if (input.mode === 'DETERMINISTIC') return { mode: 'DETERMINISTIC' };
  const model = input.aiModel.trim();
  if (model.length === 0) throw new Error('Enter the model identifier to continue.');
  if (input.mode === 'LOCAL_AI') {
    const baseUrl = input.ollamaBaseUrl.trim();
    if (baseUrl.length === 0) throw new Error('Enter the local Ollama URL to continue.');
    return { mode: 'LOCAL_AI', baseUrl, model };
  }
  const apiKey = input.apiKey.trim();
  if (apiKey.length === 0) throw new Error('Enter your request-only AI API key to continue.');
  if (input.remoteProvider === 'CUSTOM') {
    const baseUrl = input.customBaseUrl.trim();
    if (baseUrl.length === 0) throw new Error('Enter the custom HTTPS API base URL.');
    return { mode: 'USER_API', provider: 'CUSTOM', model, apiKey, baseUrl };
  }
  return { mode: 'USER_API', provider: input.remoteProvider, model, apiKey };
}

function EmptyState({ children }: { readonly children: string }) {
  return <p className="emptyState">{children}</p>;
}

function PhaseBadge({ phase }: { readonly phase: string }) {
  return (
    <div className={`phaseBadge ${warningPhases.has(phase) ? 'warning' : ''}`}>
      <span /> {phase.replaceAll('_', ' ')}
    </div>
  );
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  });
  const payload = (await response.json()) as unknown;
  if (!response.ok) {
    const errorPayload = payload as { message?: string | string[] };
    const message = Array.isArray(errorPayload.message)
      ? errorPayload.message.join(', ')
      : errorPayload.message;
    throw new Error(message ?? `DebtShift API returned ${response.status}.`);
  }
  return payload as T;
}

function getInjectedProvider(): EIP1193Provider {
  const ethereum = (window as Window & { ethereum?: EIP1193Provider }).ethereum;
  if (ethereum === undefined) throw new Error('Install an EIP-1193 wallet to continue.');
  return ethereum;
}

function formatUnits(value: string, decimals: number): string {
  const units = BigInt(value);
  const divisor = 10n ** BigInt(decimals);
  const whole = units / divisor;
  const fraction = (units % divisor).toString().padStart(decimals, '0').slice(0, 4);
  return fraction.replace(/0+$/, '').length === 0
    ? whole.toLocaleString()
    : `${whole.toLocaleString()}.${fraction.replace(/0+$/, '')}`;
}

function formatUsdMicro(value: string): string {
  const amount = BigInt(value);
  const sign = amount < 0n ? '-' : '';
  const absolute = amount < 0n ? -amount : amount;
  const whole = absolute / 1_000_000n;
  const cents = ((absolute % 1_000_000n) / 10_000n).toString().padStart(2, '0');
  return `${sign}$${whole.toLocaleString()}.${cents}`;
}

function formatBps(value: number): string {
  return `${(value / 100).toFixed(2)}%`;
}

function formatDays(seconds: string): string {
  return (Number(BigInt(seconds)) / 86_400).toFixed(1);
}

function formatWad(value: string): string {
  const wad = BigInt(value);
  return `${wad / 10n ** 18n}.${((wad % 10n ** 18n) / 10n ** 16n).toString().padStart(2, '0')}`;
}

function formatTime(seconds: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(Number(BigInt(seconds) * 1000n)));
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-8)}`;
}

function labelEvidence(type: string): string {
  return type
    .split('_')
    .map((word) => word[0] + word.slice(1).toLowerCase())
    .join(' ');
}

function humanize(value: string): string {
  return value
    .replaceAll('-', ' ')
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'An unexpected operation failed.';
}
