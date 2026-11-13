'use client';

import {
  getExecutionPlanTypedData,
  getMorphoAuthorizationTypedData,
  getRefinanceIntentTypedData,
  type ExecutionPlan,
  type PositionSnapshot,
  type PreparedSourceLendingAuthorization,
  type PreparedTargetLendingAuthorization,
  type ProviderQuote,
  type RefinanceIntent,
  type SignedTargetLendingAuthorization,
  type SubmittedSourceLendingAuthorization,
} from '@debtshift/domain';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createWalletClient, custom, type Address, type EIP1193Provider, type Hex } from 'viem';

import {
  latestMigrationEventSequence,
  migrationIdFromSearch,
  migrationStreamUrl,
  migrationUrl,
} from './migration-client';

const apiBase = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001/v1';
const terminalPhases = new Set(['COMPLETED', 'FAILED_SAFE', 'REQUOTE_REQUIRED', 'EXPIRED']);
const warningPhases = new Set(['RECOVERY', 'FAILED_SAFE', 'REQUOTE_REQUIRED', 'EXPIRED']);

interface PreparedMigration {
  readonly execution: {
    readonly mode: 'sandbox' | 'testnet' | 'mainnet-readonly' | 'mainnet';
    readonly transportProvider: ProviderQuote['provider'];
    readonly transportMode: ProviderQuote['mode'];
    readonly simulatedTransport: boolean;
    readonly fundedExecutionEnabled: boolean;
    readonly warning: string;
  };
  readonly verifyingContract: Address;
  readonly intent: RefinanceIntent;
  readonly intentHash: Hex;
  readonly plan: ExecutionPlan;
  readonly planHash: Hex;
  readonly sourceAuthorization: PreparedSourceLendingAuthorization;
  readonly targetAuthorization: PreparedTargetLendingAuthorization;
  readonly quote: ProviderQuote;
  readonly sourceSnapshot: PositionSnapshot;
  readonly routeAnalysis: RouteAnalysisResponse;
}

interface WalletAuthChallenge {
  readonly challengeId: string;
  readonly wallet: Address;
  readonly chainId: number;
  readonly message: string;
  readonly expiresAt: string;
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

interface MigrationEvent {
  readonly eventId: string;
  readonly sequence: number;
  readonly type: string;
  readonly phase: string;
  readonly actor: string;
  readonly payloadHash: string;
  readonly observedAt: string;
}

interface MigrationLedgerEntry {
  readonly entryId: string;
  readonly sequence: number;
  readonly componentCode: string;
  readonly componentId: string;
  readonly evidenceId: string;
  readonly basis: string;
  readonly chainId: string;
  readonly token: string;
  readonly amountUnits: string;
  readonly debitParty: string;
  readonly creditParty: string;
  readonly category: string;
  readonly transactionReference: string | null;
}

interface MigrationReservation {
  readonly reservationId: string;
  readonly chainId: string;
  readonly asset: string;
  readonly principalUnits: string;
  readonly feeCapUnits: string;
  readonly status: string;
  readonly expiresAt: string;
}

interface MigrationRecoveryCase {
  readonly recoveryId: string;
  readonly policy: string;
  readonly status: string;
  readonly reason: string;
  readonly residualAssets: readonly Record<string, unknown>[];
  readonly openedAt: string;
  readonly resolvedAt: string | null;
}

interface MigrationDetails {
  readonly migration: {
    readonly migrationId: string;
    readonly phase: string;
    readonly updatedAt: string;
  };
  readonly evidence: readonly MigrationEvidence[];
  readonly events: readonly MigrationEvent[];
  readonly commands: readonly {
    readonly commandId: string;
    readonly type: string;
    readonly status: string;
    readonly lastError: string | null;
  }[];
  readonly ledger: readonly MigrationLedgerEntry[];
  readonly reservations: readonly MigrationReservation[];
  readonly recoveryCases: readonly MigrationRecoveryCase[];
}

type BusyAction = 'connect' | 'prepare' | 'authorize' | 'explain' | null;
type StreamStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'complete';

export function DebtShiftApp() {
  const [account, setAccount] = useState<Address>();
  const [provider, setProvider] = useState<EIP1193Provider>();
  const [position, setPosition] = useState<PositionSnapshot>();
  const [routeAnalysis, setRouteAnalysis] = useState<RouteAnalysisResponse>();
  const [prepared, setPrepared] = useState<PreparedMigration>();
  const [migrationId, setMigrationId] = useState<string>();
  const [migration, setMigration] = useState<MigrationDetails>();
  const [streamStatus, setStreamStatus] = useState<StreamStatus>('idle');
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
    const restoredMigrationId = migrationIdFromSearch(window.location.search);
    if (restoredMigrationId !== undefined) setMigrationId(restoredMigrationId);
  }, []);

  useEffect(() => {
    if (migrationId === undefined) {
      setStreamStatus('idle');
      return;
    }
    let disposed = false;
    let eventSource: EventSource | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    const connect = async () => {
      setStreamStatus('connecting');
      try {
        const details = await loadMigration(migrationId);
        if (disposed) return;
        setError(undefined);
        if (terminalPhases.has(details.migration.phase)) {
          setStreamStatus('complete');
          return;
        }
        const cursor = latestMigrationEventSequence(details.events);
        eventSource = new EventSource(migrationStreamUrl(apiBase, migrationId, cursor), {
          withCredentials: true,
        });
        eventSource.onopen = () => {
          if (!disposed) setStreamStatus('live');
        };
        eventSource.addEventListener('migration', (event) => {
          if (disposed) return;
          const update = parseStreamUpdate(event);
          void loadMigration(migrationId).catch((streamError: unknown) => {
            if (!disposed) setError(messageOf(streamError));
          });
          if (update !== undefined && terminalPhases.has(update.phase)) {
            eventSource?.close();
            setStreamStatus('complete');
          }
        });
        eventSource.addEventListener('keepalive', () => {
          if (!disposed) setStreamStatus('live');
        });
        eventSource.onerror = () => {
          if (!disposed) setStreamStatus('reconnecting');
        };
      } catch (streamError) {
        if (!disposed) {
          setStreamStatus('reconnecting');
          setError(messageOf(streamError));
          retryTimer = setTimeout(() => void connect(), 1_500);
        }
      }
    };
    void connect();
    return () => {
      disposed = true;
      eventSource?.close();
      if (retryTimer !== undefined) clearTimeout(retryTimer);
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
      const challenge = await api<WalletAuthChallenge>('/auth/challenge', {
        method: 'POST',
        body: JSON.stringify({ wallet: selected }),
      });
      await wallet.switchChain({ id: challenge.chainId });
      const authenticationSignature = await wallet.signMessage({
        account: selected,
        message: challenge.message,
      });
      await api<{ session: { wallet: Address; chainId: number; expiresAt: string } }>(
        '/auth/verify',
        {
          method: 'POST',
          body: JSON.stringify({
            challengeId: challenge.challengeId,
            signature: authenticationSignature,
          }),
        },
      );
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
      window.history.replaceState({}, '', migrationUrl(window.location.href));
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
      let targetAuthorization: SignedTargetLendingAuthorization = { kind: 'NONE' };
      if (prepared.targetAuthorization.kind === 'MORPHO_BLUE') {
        await wallet.switchChain({ id: prepared.targetAuthorization.chainId });
        const enableSignature = await wallet.signTypedData({
          account,
          ...getMorphoAuthorizationTypedData(prepared.targetAuthorization, 'enable'),
        });
        const disableSignature = await wallet.signTypedData({
          account,
          ...getMorphoAuthorizationTypedData(prepared.targetAuthorization, 'disable'),
        });
        targetAuthorization = {
          ...prepared.targetAuthorization,
          enableSignature,
          disableSignature,
        };
        await wallet.switchChain({ id: prepared.intent.sourcePosition.market.chainId });
      }
      const intentSignature = await wallet.signTypedData({
        account,
        ...getRefinanceIntentTypedData(prepared.intent, prepared.verifyingContract),
      });
      const planSignature = await wallet.signTypedData({
        account,
        ...getExecutionPlanTypedData(prepared.plan, prepared.verifyingContract),
      });
      let sourceAuthorization: SubmittedSourceLendingAuthorization = { kind: 'NONE' };
      if (prepared.sourceAuthorization.kind === 'ERC20_APPROVAL') {
        await wallet.switchChain({ id: prepared.sourceAuthorization.chainId });
        const transactionHash = await wallet.sendTransaction({
          account,
          chain: null,
          to: prepared.sourceAuthorization.transaction.to,
          data: prepared.sourceAuthorization.transaction.data as Hex,
          value: BigInt(prepared.sourceAuthorization.transaction.valueUnits),
        });
        sourceAuthorization = { ...prepared.sourceAuthorization, transactionHash };
      }
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
          sourceAuthorization,
          targetAuthorization,
        }),
      });
      window.history.replaceState({}, '', migrationUrl(window.location.href, result.migrationId));
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
  const displayedMode = prepared?.execution.mode ?? 'sandbox';

  return (
    <main>
      <nav className="nav" aria-label="Primary navigation">
        <a className="brand" href="#top" aria-label="DebtShift home">
          <span className="brandMark">D</span>
          <span>DebtShift</span>
        </a>
        <div className="environment">
          <span className="statusDot" /> {displayedMode.replaceAll('-', ' ')} /{' '}
          {prepared?.execution.fundedExecutionEnabled === false
            ? 'writes disabled'
            : 'bounded writes'}
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
              ? 'Proving wallet control…'
              : account
                ? shortAddress(account)
                : 'Connect test wallet'}
          </button>
          <a href="#workspace">Open workspace</a>
        </div>
        <div className="boundary" role="note">
          <strong>Safe demonstration boundary</strong>
          <span>
            {displayedMode === 'sandbox' ? 'Test assets only' : 'Mode-enforced execution'}
          </span>
          <span>
            {prepared?.execution.simulatedTransport === false
              ? 'Official 1Click transport'
              : 'External transport boundary simulated'}
          </span>
          <span>Session proof + two financial authorizations</span>
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
                    <small>Chain {prepared.plan.sourceMarket.chainId}</small>
                    <strong>{prepared.plan.sourceMarket.protocol}</strong>
                  </div>
                  <span aria-hidden="true">→</span>
                  <div>
                    <small>Chain {prepared.plan.targetMarket.chainId}</small>
                    <strong>{prepared.plan.targetMarket.protocol}</strong>
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
                <details className="authorizationReview">
                  <summary>Review exact signed boundaries</summary>
                  <dl>
                    <HashTerm label="Intent" value={prepared.intentHash} />
                    <HashTerm label="Execution plan" value={prepared.planHash} />
                    <HashTerm label="Transport quote" value={prepared.quote.quoteHash} />
                    <HashTerm
                      label="Destination receiver"
                      value={prepared.plan.destinationReceiver}
                    />
                    <HashTerm
                      label="Refund receiver"
                      value={prepared.plan.transportRefundReceiver}
                    />
                    <HashTerm label="Solver payout" value={prepared.plan.payoutReceiver} />
                    <HashTerm label="Nonce" value={prepared.plan.nonce} />
                  </dl>
                </details>
                <div className="simulationWarning">{prepared.execution.warning}</div>
                {migrationId === undefined && (
                  <button
                    className="primaryAction"
                    type="button"
                    onClick={() => void authorizeAndExecute()}
                    disabled={busy !== null || !prepared.execution.fundedExecutionEnabled}
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
                  <div>
                    <span>{migration.migration.phase.replaceAll('_', ' ')}</span>
                    <small>{streamStatusLabel(streamStatus)}</small>
                  </div>
                  <code title={migration.migration.migrationId}>
                    {shortHash(migration.migration.migrationId)}
                  </code>
                </div>
                <ol className="timeline">
                  {migration.evidence.map((record) => (
                    <li key={record.evidenceId}>
                      <span className="evidenceDot" />
                      <div>
                        <strong>{labelEvidence(record.type)}</strong>
                        <div className="evidenceStates">
                          <span>Provider: {record.provider}</span>
                          <span>Verified: {record.verificationState}</span>
                        </div>
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

        <section className="assurancePanel" aria-labelledby="assurance-title">
          <header className="assuranceHeader">
            <div>
              <p className="sectionLabel">Financing and durable records</p>
              <h3 id="assurance-title">Know what funds the route—and what actually moved.</h3>
            </div>
            <p>
              Provider claims never determine completion. Only verified evidence, balanced ledger
              entries, and the evidence-derived phase do.
            </p>
          </header>
          <div className="assuranceGrid">
            <article className="assuranceCard">
              <div className="recordHeading">
                <span>Funding checkpoint</span>
                <strong>{prepared ? 'Signed and bounded' : 'Awaiting route'}</strong>
              </div>
              {prepared ? (
                <FinancingCheckpoint financing={prepared.plan.financing} />
              ) : (
                <EmptyState>
                  Prepare the exact route to inspect capacity, funding, costs, and provenance.
                </EmptyState>
              )}
            </article>

            <article className="assuranceCard">
              <div className="recordHeading">
                <span>Reservation and ledger</span>
                <strong>{migration ? `${migration.ledger.length} entries` : 'Not started'}</strong>
              </div>
              {migration ? (
                <AccountingRecords migration={migration} financing={prepared?.plan.financing} />
              ) : (
                <EmptyState>
                  Exact principal, fees, custody movements, and residuals appear after execution.
                </EmptyState>
              )}
            </article>

            <article className="assuranceCard">
              <div className="recordHeading">
                <span>Audit and recovery</span>
                <strong>
                  {migration?.recoveryCases.some((recovery) => recovery.status === 'OPEN')
                    ? 'Recovery open'
                    : 'No open recovery'}
                </strong>
              </div>
              {migration ? (
                <AuditAndRecoveryRecords migration={migration} />
              ) : (
                <EmptyState>
                  Durable phase events and any residual custody claim remain available after reload.
                </EmptyState>
              )}
            </article>
          </div>
        </section>
      </section>

      <footer>
        <span>DebtShift / local engineering release</span>
        <span>Deterministic policy · evidence before state</span>
      </footer>
    </main>
  );
}

function FinancingCheckpoint({ financing }: { readonly financing: ExecutionPlan['financing'] }) {
  const decimals = financing.settlementAsset.decimals;
  const symbol = financing.settlementAsset.symbol ?? 'settlement units';
  const resolved = financing.fundingShortfallUnits === '0';
  return (
    <>
      <div className={`resolutionStatus ${resolved ? '' : 'blocked'}`}>
        <span>{resolved ? 'Zero-shortfall proof passed' : 'Execution blocked by shortfall'}</span>
        <strong>
          {formatUnits(financing.fundingShortfallUnits, decimals)} {symbol} shortfall
        </strong>
      </div>
      <dl className="checkpointMetrics">
        <Metric
          label="Solver principal"
          value={`${formatUnits(financing.solverPrincipalUnits, decimals)} ${symbol}`}
        />
        <Metric
          label="Maximum safe capacity"
          value={`${formatUnits(financing.maximumSafeBorrowingCapacityUnits, decimals)} ${symbol}`}
        />
        <Metric
          label="Confirmed external funding"
          value={`${formatUnits(financing.confirmedExternalFundingUnits, decimals)} ${symbol}`}
        />
        <Metric
          label="Required destination borrow"
          value={`${formatUnits(financing.requiredDestinationBorrowUnits, decimals)} ${symbol}`}
        />
      </dl>
      <div className="costSummary">
        <span>
          {financing.costs.length} classified cost{financing.costs.length === 1 ? '' : 's'} ·{' '}
          {financing.externalFunding.length} finalized external funding record
          {financing.externalFunding.length === 1 ? '' : 's'}
        </span>
        <ul>
          {financing.costs.map((cost) => (
            <li key={cost.componentId}>
              <span>{humanize(cost.kind)}</span>
              <strong>{humanize(cost.financingClass)}</strong>
              <code>
                {formatUnits(cost.settlementAmountUnits, decimals)} {symbol}
              </code>
            </li>
          ))}
        </ul>
      </div>
      <div className="checkpointProvenance">
        <span>Evaluated {formatDateTime(financing.evaluatedAt)}</span>
        <span>Valid until {formatTime(financing.validUntil)}</span>
        <code title={financing.capacityEvidenceHash}>
          Capacity {shortHash(financing.capacityEvidenceHash)}
        </code>
      </div>
    </>
  );
}

function AccountingRecords({
  migration,
  financing,
}: {
  readonly migration: MigrationDetails;
  readonly financing: ExecutionPlan['financing'] | undefined;
}) {
  const reservation = migration.reservations.at(-1);
  return (
    <>
      {reservation && (
        <div className="reservationSummary">
          <span>{humanize(reservation.status)} reservation</span>
          <strong>
            {formatRecordAmount(reservation.principalUnits, reservation.asset, financing)} principal
          </strong>
          <small>
            Fee cap {formatRecordAmount(reservation.feeCapUnits, reservation.asset, financing)} ·
            chain {reservation.chainId}
          </small>
        </div>
      )}
      {migration.ledger.length > 0 ? (
        <ol className="recordList ledgerList">
          {migration.ledger.slice(-8).map((entry) => (
            <li key={entry.entryId}>
              <div>
                <strong>{humanize(entry.category)}</strong>
                <span>
                  {humanize(entry.debitParty)} → {humanize(entry.creditParty)}
                </span>
              </div>
              <code title={`${entry.amountUnits} base units`}>
                {formatRecordAmount(entry.amountUnits, entry.token, financing)}
              </code>
            </li>
          ))}
        </ol>
      ) : (
        <p className="recordNotice">
          No asset movement is represented before verified ledger evidence.
        </p>
      )}
      {migration.ledger.length > 8 && (
        <small className="recordFootnote">
          Showing the latest 8 of {migration.ledger.length} immutable entries.
        </small>
      )}
    </>
  );
}

function AuditAndRecoveryRecords({ migration }: { readonly migration: MigrationDetails }) {
  return (
    <>
      {migration.recoveryCases.map((recovery) => (
        <div className="recoverySummary" key={recovery.recoveryId}>
          <span>{humanize(recovery.status)}</span>
          <strong>{humanize(recovery.policy)}</strong>
          <p>{recovery.reason}</p>
          <ul>
            {recovery.residualAssets.map((asset, index) => (
              <li key={`${recovery.recoveryId}-${index}`}>{describeResidualAsset(asset)}</li>
            ))}
          </ul>
        </div>
      ))}
      <ol className="recordList auditList">
        {migration.events.slice(-8).map((event) => (
          <li key={event.eventId}>
            <div>
              <strong>
                #{event.sequence} {humanize(event.type)}
              </strong>
              <span>
                {humanize(event.phase)} · {formatDateTime(event.observedAt)}
              </span>
            </div>
            <code title={event.payloadHash}>{shortHash(event.payloadHash)}</code>
          </li>
        ))}
      </ol>
      {migration.events.length > 8 && (
        <small className="recordFootnote">
          Showing the latest 8 of {migration.events.length} hash-bound audit events.
        </small>
      )}
    </>
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

function HashTerm({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <code title={value}>{value.startsWith('0x') ? shortHash(value) : value}</code>
      </dd>
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
    credentials: 'include',
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

function parseStreamUpdate(event: Event): { readonly phase: string } | undefined {
  try {
    const data = (event as MessageEvent<string>).data;
    if (typeof data !== 'string') return undefined;
    const parsed = JSON.parse(data) as unknown;
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('phase' in parsed) ||
      typeof parsed.phase !== 'string'
    ) {
      return undefined;
    }
    return { phase: parsed.phase };
  } catch {
    return undefined;
  }
}

function streamStatusLabel(status: StreamStatus): string {
  const labels: Record<StreamStatus, string> = {
    idle: 'Live updates idle',
    connecting: 'Connecting to durable event stream',
    live: 'Live · cursor recovery enabled',
    reconnecting: 'Reconnecting from last durable event',
    complete: 'Terminal phase · history preserved',
  };
  return labels[status];
}

function formatRecordAmount(
  amountUnits: string,
  token: string,
  financing?: ExecutionPlan['financing'],
): string {
  if (
    financing !== undefined &&
    token.toLowerCase() === financing.settlementAsset.address.toLowerCase()
  ) {
    return `${formatUnits(amountUnits, financing.settlementAsset.decimals)} ${financing.settlementAsset.symbol ?? 'units'}`;
  }
  return `${BigInt(amountUnits).toLocaleString()} base units · ${shortAddress(token)}`;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'medium',
  }).format(date);
}

function describeResidualAsset(asset: Record<string, unknown>): string {
  const values = Object.entries(asset)
    .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
    .slice(0, 4)
    .map(([key, value]) => `${humanize(key)}: ${String(value)}`);
  return values.length > 0
    ? values.join(' · ')
    : 'Residual asset details are hash-bound in evidence.';
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
