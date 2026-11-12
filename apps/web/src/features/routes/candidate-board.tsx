/*
 * The candidate board: every route that was evaluated, as one card each.
 *
 * It answers "which one, and what happened to the others" at a glance, before
 * the detail sections. It adds no judgement of its own — the order, the
 * eligibility and the figures are the backend's. A rejected route is never
 * left out, and its card links to the section that gives every reason.
 */

import type { RouteEvaluation } from '../../lib/api/types';
import { formatBps, formatUsdMicro, humanizeIdentifier } from '../../lib/formatting';

export type CandidateStatus = 'selected' | 'passes' | 'rejected';

/**
 * The first eligible route is the one the page carries forward, matching the
 * rest of the screen. Any other eligible route passes but is not selected.
 */
export function candidateStatus(
  route: RouteEvaluation,
  evaluations: readonly RouteEvaluation[],
): CandidateStatus {
  if (!route.eligible) return 'rejected';
  const firstEligible = evaluations.find((candidate) => candidate.eligible);
  return firstEligible?.candidateId === route.candidateId ? 'selected' : 'passes';
}

/** Selected first, then other passing routes, then rejected ones. */
export function orderCandidates(evaluations: readonly RouteEvaluation[]): RouteEvaluation[] {
  const weight: Record<CandidateStatus, number> = { selected: 0, passes: 1, rejected: 2 };
  return evaluations
    .map((route, index) => ({ route, index }))
    .sort(
      (a, b) =>
        weight[candidateStatus(a.route, evaluations)] -
          weight[candidateStatus(b.route, evaluations)] || a.index - b.index,
    )
    .map((entry) => entry.route);
}

const STATUS_LABEL: Record<CandidateStatus, string> = {
  selected: 'Selected route',
  passes: 'Passes the policy',
  rejected: 'Rejected',
};

function CheckIcon() {
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </svg>
  );
}

function CrossIcon() {
  return (
    <svg
      aria-hidden="true"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

function CandidateCard({
  route,
  status,
}: {
  readonly route: RouteEvaluation;
  readonly status: CandidateStatus;
}) {
  const economics = route.economics;
  const rejected = status === 'rejected';
  const failed = route.rejections.length;

  return (
    <li className={`cand cand--${status}`}>
      <span className="cand__status">
        {rejected ? <CrossIcon /> : <CheckIcon />}
        {STATUS_LABEL[status]}
        {!rejected && route.rank !== undefined ? ` · rank ${route.rank}` : ''}
      </span>

      <h2 className="cand__name">{humanizeIdentifier(route.candidateId)}</h2>

      <p className="cand__rate num">
        <span className="cand__rate-old">{formatBps(economics.sourceAprBps)}</span>
        <svg
          aria-hidden="true"
          width="20"
          height="20"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M4 12h16m-6-6 6 6-6 6" />
        </svg>
        <span className="cand__rate-new">{formatBps(economics.targetAprAfterBps)}</span>
        <span className="cand__rate-note">
          {rejected ? 'rate it would offer' : 'borrow rate after moving'}
        </span>
      </p>

      {rejected ? (
        <p className="cand__verdict">
          {failed === 1 ? '1 check failed' : `${failed} checks failed`}, so this route cannot be
          prepared.{' '}
          <a href={`#rejected-${route.candidateId}`}>
            See {failed === 1 ? 'the reason' : 'every reason'}
          </a>
        </p>
      ) : (
        <p className="cand__verdict">
          Net benefit{' '}
          <strong className="num">{formatUsdMicro(economics.netBenefitUsdMicro)}</strong> after
          costs. No check failed.
        </p>
      )}
    </li>
  );
}

export function CandidateBoard({
  evaluations,
}: {
  readonly evaluations: readonly RouteEvaluation[];
}) {
  if (evaluations.length === 0) return null;
  return (
    <ul className="cand-grid" aria-label="Routes evaluated">
      {orderCandidates(evaluations).map((route) => (
        <CandidateCard
          key={route.candidateId}
          route={route}
          status={candidateStatus(route, evaluations)}
        />
      ))}
    </ul>
  );
}
