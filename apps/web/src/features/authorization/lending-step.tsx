'use client';

/*
 * The lending-permissions step.
 *
 * Shown only when the backend prepared a permission a lending protocol needs.
 * Each one is its own card with its exact terms, its own network requirement
 * and its own button: nothing here is batched behind a single click, and a
 * permission that does not match what the card says is refused before the
 * wallet is asked.
 */

import { Alert, Badge, Button } from '../../components/ui/index';
import type { ExecutionPlan } from '../../lib/api/types';
import { chainName } from '../../lib/chains';
import { formatAmount, formatUnixTimestamp, truncateHex } from '../../lib/formatting';
import {
  approvalProblem,
  morphoPairProblem,
  type Erc20Approval,
  type LendingProgress,
  type MorphoAuthorization,
} from './lending-authorization';

function Fact({
  label,
  value,
  raw,
}: {
  readonly label: string;
  readonly value: React.ReactNode;
  readonly raw?: string | undefined;
}) {
  return (
    <div className="review__row">
      <dt>{label}</dt>
      <dd className="num">
        <span className="review__value">{value}</span>
        {raw ? <span className="mono review__raw">{raw}</span> : null}
      </dd>
    </div>
  );
}

function NetworkGate({
  required,
  current,
  onSwitch,
}: {
  readonly required: number;
  readonly current: number | undefined;
  readonly onSwitch: () => void;
}) {
  if (current === required) return null;
  return (
    <Alert
      tone="warning"
      title={`This permission is given on ${chainName(required)}`}
      action={
        <Button size="sm" variant="secondary" onClick={onSwitch}>
          Switch network
        </Button>
      }
    >
      Your wallet reports chain {current ?? 'unknown'}. DebtShift will ask — it never switches by
      itself.
    </Alert>
  );
}

export function MorphoPermissionCard({
  authorization,
  borrower,
  progress,
  walletChainId,
  busy,
  disabled,
  onSwitch,
  onSign,
}: {
  readonly authorization: MorphoAuthorization;
  readonly borrower: string;
  readonly progress: LendingProgress;
  readonly walletChainId: number | undefined;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onSwitch: () => void;
  readonly onSign: (side: 'enable' | 'disable') => void;
}) {
  const problem = morphoPairProblem(authorization, borrower);
  const onChain = walletChainId === authorization.chainId;
  const granted = progress.enableSignature !== undefined;
  const removed = progress.disableSignature !== undefined;
  const blocked = disabled || busy || !onChain || problem !== undefined;

  return (
    <section className="lending-card" aria-labelledby="morpho-permission">
      <header className="lending-card__head">
        <h3 id="morpho-permission" className="lending-card__title">
          Morpho permission for the new loan
        </h3>
        <Badge tone={granted && removed ? 'success' : 'neutral'}>
          {granted && removed ? 'Both signed' : `${Number(granted) + Number(removed)} of 2 signed`}
        </Badge>
      </header>
      <p className="lending-card__lede">
        Morpho only lets a contract open a loan for you if you authorize it. You sign two messages:
        the first grants the DebtShift module that permission, the second removes it. Both expire
        with this migration.
      </p>

      <dl className="facts review__rows">
        <Fact
          label="Network"
          value={chainName(authorization.chainId)}
          raw={`chainId ${authorization.chainId}`}
        />
        <Fact
          label="Morpho contract"
          value={authorization.morpho}
          raw={`morpho ${authorization.morpho}`}
        />
        <Fact
          label="Contract being authorized"
          value={authorization.module}
          raw={`module ${authorization.module}`}
        />
        <Fact
          label="Signature 1 grants it"
          value="Permission on"
          raw={`enable.isAuthorized true · nonce ${authorization.enable.nonce}`}
        />
        <Fact
          label="Signature 2 removes it"
          value="Permission off"
          raw={`disable.isAuthorized false · nonce ${authorization.disable.nonce}`}
        />
        <Fact
          label="Both expire"
          value={formatUnixTimestamp(authorization.enable.deadline)}
          raw={`deadline ${authorization.enable.deadline}`}
        />
      </dl>

      {problem ? (
        <Alert tone="danger" title="This permission will not be requested">
          {problem} Prepare the authorization again; if it repeats, do not sign.
        </Alert>
      ) : (
        <NetworkGate required={authorization.chainId} current={walletChainId} onSwitch={onSwitch} />
      )}

      <div className="lending-card__actions">
        <Button onClick={() => onSign('enable')} disabled={blocked || granted}>
          {granted ? 'Grant signed' : 'Sign the grant'}
        </Button>
        <Button onClick={() => onSign('disable')} disabled={blocked || !granted || removed}>
          {removed ? 'Removal signed' : 'Sign the removal'}
        </Button>
      </div>
    </section>
  );
}

/** The plan asset this token is, when it is one of them, so the amount can be read. */
function knownToken(plan: ExecutionPlan, token: string) {
  const candidates = [
    plan.sourceCollateralAsset,
    plan.sourceDebtAsset,
    plan.destinationCollateralAsset,
    plan.destinationDebtAsset,
    plan.payoutAsset,
  ];
  return candidates.find((asset) => asset.address.toLowerCase() === token.toLowerCase());
}

export function TokenApprovalCard({
  authorization,
  plan,
  progress,
  walletChainId,
  busy,
  disabled,
  onSwitch,
  onSend,
}: {
  readonly authorization: Erc20Approval;
  readonly plan: ExecutionPlan;
  readonly progress: LendingProgress;
  readonly walletChainId: number | undefined;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly onSwitch: () => void;
  readonly onSend: () => void;
}) {
  const problem = approvalProblem(authorization);
  const onChain = walletChainId === authorization.chainId;
  const sent = progress.approvalHash !== undefined;
  const mined = progress.approvalBlock !== undefined;
  const asset = knownToken(plan, authorization.token);

  return (
    <section className="lending-card" aria-labelledby="token-approval">
      <header className="lending-card__head">
        <h3 id="token-approval" className="lending-card__title">
          Token approval on the source market
        </h3>
        <Badge tone={mined ? 'success' : sent ? 'warning' : 'neutral'}>
          {mined ? 'Mined' : sent ? 'Waiting to be mined' : 'Not sent'}
        </Badge>
      </header>
      <p className="lending-card__lede">
        This one is a transaction, not a signature: it costs gas and is recorded on-chain. It lets
        one contract move up to the amount below of one token, and nothing else.
      </p>

      <dl className="facts review__rows">
        <Fact
          label="Network"
          value={chainName(authorization.chainId)}
          raw={`chainId ${authorization.chainId}`}
        />
        <Fact
          label="Token"
          value={
            asset ? `${asset.symbol} · ${truncateHex(authorization.token)}` : authorization.token
          }
          raw={`token ${authorization.token}`}
        />
        <Fact
          label="Allowed to spend it"
          value={authorization.spender}
          raw={`spender ${authorization.spender}`}
        />
        <Fact
          label="Up to"
          value={
            asset
              ? formatAmount(authorization.amountUnits, asset.decimals, asset.symbol)
              : `${authorization.amountUnits} base units`
          }
          raw={`amountUnits ${authorization.amountUnits}`}
        />
        {sent ? (
          <Fact
            label="Transaction"
            value={truncateHex(progress.approvalHash ?? '', 10, 8)}
            raw={mined ? `mined in block ${progress.approvalBlock}` : 'not mined yet'}
          />
        ) : null}
      </dl>

      {problem ? (
        <Alert tone="danger" title="This transaction will not be sent">
          {problem} Prepare the authorization again; if it repeats, do not approve.
        </Alert>
      ) : (
        <NetworkGate required={authorization.chainId} current={walletChainId} onSwitch={onSwitch} />
      )}

      <div className="lending-card__actions">
        <Button
          onClick={onSend}
          disabled={disabled || busy || !onChain || problem !== undefined || sent}
        >
          {mined ? 'Approval mined' : sent ? 'Waiting for the network…' : 'Send the approval'}
        </Button>
      </div>
    </section>
  );
}
