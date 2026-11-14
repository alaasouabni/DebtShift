import { createHash } from 'node:crypto';

export async function verifyNearDeploymentReadiness({ manifest, rpcUrls, providerFactory }) {
  if (!Array.isArray(rpcUrls) || rpcUrls.length === 0) {
    throw new Error('At least one NEAR RPC endpoint is required.');
  }
  const reports = [];
  for (const rpcUrl of rpcUrls) {
    const provider = providerFactory(rpcUrl);
    const actualNetwork = await provider.getNetworkId();
    if (actualNetwork !== manifest.network) {
      throw new Error(`Configured NEAR RPC network ${actualNetwork} does not match the manifest.`);
    }
    const [code, account, owner, pendingOwner, verifierAccounts] = await Promise.all([
      provider.viewContractCode({
        contractId: manifest.registryAccount,
        blockQuery: { finality: 'final' },
      }),
      provider.viewAccount({
        accountId: manifest.registryAccount,
        blockQuery: { finality: 'final' },
      }),
      view(provider, manifest.registryAccount, 'owner_id', {}),
      view(provider, manifest.registryAccount, 'pending_owner_id', {}),
      view(provider, manifest.registryAccount, 'list_verifiers', { from_index: 0, limit: 50 }),
    ]);
    const wasmSha256 = `0x${createHash('sha256').update(code.code).digest('hex')}`;
    if (wasmSha256 !== manifest.wasmSha256 || code.hash !== manifest.deployedCodeHash) {
      throw new Error('NEAR registry code does not match the deployment manifest.');
    }
    if (owner !== manifest.ownerAccount) {
      throw new Error('NEAR registry owner does not match the deployment manifest.');
    }
    if (pendingOwner !== null) throw new Error('NEAR registry has a pending owner transfer.');
    if (JSON.stringify(verifierAccounts) !== JSON.stringify(manifest.verifierAccounts)) {
      throw new Error('NEAR registry verifier set does not match the deployment manifest.');
    }
    if (BigInt(account.storage_usage) < BigInt(manifest.initialStorageUsage)) {
      throw new Error('NEAR registry storage usage is below its initialized manifest value.');
    }
    if (code.block_height < Number(manifest.initializationTransaction.blockHeight)) {
      throw new Error('NEAR registry final code view predates its initialization transaction.');
    }
    reports.push({
      codeBlockHeight: code.block_height,
      storageUsage: account.storage_usage.toString(),
    });
  }

  const primary = providerFactory(rpcUrls[0]);
  for (const transaction of uniqueTransactions(manifest)) {
    const outcome = await primary.viewTransactionStatus({
      txHash: transaction.transactionHash,
      accountId: transaction.signerAccount,
      waitUntil: 'FINAL',
    });
    if (
      outcome.final_execution_status !== 'FINAL' ||
      (typeof outcome.status === 'object' &&
        outcome.status !== null &&
        'Failure' in outcome.status) ||
      outcome.transaction.hash !== transaction.transactionHash ||
      outcome.transaction.signer_id !== transaction.signerAccount ||
      outcome.transaction.receiver_id !== transaction.receiverAccount ||
      outcome.transaction_outcome.block_hash !== transaction.blockHash
    ) {
      throw new Error('NEAR deployment transaction does not match the manifest.');
    }
  }

  return Object.freeze({
    rpcEndpointCount: reports.length,
    minimumObservedCodeBlockHeight: Math.min(...reports.map((report) => report.codeBlockHeight)),
    minimumObservedStorageUsage: reports
      .map((report) => BigInt(report.storageUsage))
      .reduce((minimum, value) => (value < minimum ? value : minimum))
      .toString(),
  });
}

function uniqueTransactions(manifest) {
  const transactions = [manifest.deploymentTransaction, manifest.initializationTransaction];
  return transactions.filter(
    (transaction, index) =>
      transactions.findIndex(
        (candidate) => candidate.transactionHash === transaction.transactionHash,
      ) === index,
  );
}

function view(provider, contractId, method, args) {
  return provider.callFunction({ contractId, method, args, blockQuery: { finality: 'final' } });
}
