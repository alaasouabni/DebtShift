'use client';

/*
 * What to show after the wallet did not switch network.
 *
 * Rendered next to every "Switch network" prompt. It says why the switch did
 * not happen and, when the wallet simply does not know a public testnet this
 * app works on, offers to add it.
 *
 * The offer is deliberately not automatic. It lists the exact details that
 * would be handed to the wallet, so the user reads them here and again in the
 * wallet's own approval prompt, and nothing is added unless they press the
 * button and approve there. DebtShift never adds or switches a network by
 * itself.
 */

import { useState } from 'react';

import { Alert, Button } from '../../components/ui';
import { chainName, walletChainParameters } from '../../lib/chains';
import { useWallet } from './wallet-context';

export function NetworkHelp({ chainId }: { readonly chainId: number | undefined }) {
  const wallet = useWallet();
  const [adding, setAdding] = useState(false);

  const issue = wallet.chainIssue;
  // Only the issue for the network this prompt is about, and only while the
  // wallet is still somewhere else.
  if (issue === undefined || issue.chainId !== chainId || wallet.chainId === chainId) return null;

  const parameters = issue.kind === 'unknown-addable' ? walletChainParameters(chainId) : undefined;

  if (parameters === undefined) {
    return (
      <div aria-live="polite">
        <Alert tone="warning" title="The network was not switched">
          {issue.message}
        </Alert>
      </div>
    );
  }

  const add = async () => {
    setAdding(true);
    try {
      await wallet.addChain(issue.chainId);
    } finally {
      setAdding(false);
    }
  };

  return (
    <div aria-live="polite">
      <Alert
        tone="warning"
        title={`Add ${parameters.chainName} to your wallet`}
        action={
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void add()}
            disabled={adding}
            aria-busy={adding}
          >
            {adding ? 'Waiting for your wallet…' : `Add ${parameters.chainName}`}
          </Button>
        }
      >
        {issue.message} These are the details your wallet will be given. It shows them again and
        asks you to approve; nothing is added until you do.
        <dl
          style={{
            margin: '12px 0 0',
            display: 'grid',
            gridTemplateColumns: 'max-content minmax(0, 1fr)',
            gap: '4px 16px',
            fontSize: 13,
            lineHeight: '20px',
          }}
        >
          <dt style={{ color: 'var(--ink-muted)' }}>Network</dt>
          <dd style={{ margin: 0 }}>{chainName(issue.chainId)}</dd>
          <dt style={{ color: 'var(--ink-muted)' }}>RPC endpoint</dt>
          <dd className="mono" style={{ margin: 0, wordBreak: 'break-all' }}>
            {parameters.rpcUrls[0]}
          </dd>
          <dt style={{ color: 'var(--ink-muted)' }}>Currency</dt>
          <dd style={{ margin: 0 }}>{parameters.nativeCurrency.symbol} (test funds)</dd>
          <dt style={{ color: 'var(--ink-muted)' }}>Explorer</dt>
          <dd className="mono" style={{ margin: 0, wordBreak: 'break-all' }}>
            {parameters.blockExplorerUrls[0]}
          </dd>
        </dl>
      </Alert>
    </div>
  );
}
