import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { verifyNearDeploymentReadiness } from './lib/near-deployment-readiness.mjs';

const WASM = new Uint8Array([0, 97, 115, 109]);

describe('NEAR deployment readiness', () => {
  it('verifies code, roles, storage, and final transaction evidence through every endpoint', async () => {
    const manifest = validManifest();
    const result = await verifyNearDeploymentReadiness({
      manifest,
      rpcUrls: ['https://primary.example', 'https://fallback.example'],
      providerFactory: () => provider(manifest),
    });

    assert.deepEqual(result, {
      rpcEndpointCount: 2,
      minimumObservedCodeBlockHeight: 200,
      minimumObservedStorageUsage: '1200',
    });
  });

  it('fails closed on code, network, ownership, or transaction drift', async () => {
    const manifest = validManifest();
    await assert.rejects(
      verifyNearDeploymentReadiness({
        manifest,
        rpcUrls: ['https://primary.example'],
        providerFactory: () => provider(manifest, { codeHash: '9'.repeat(44) }),
      }),
      /code does not match/,
    );
    await assert.rejects(
      verifyNearDeploymentReadiness({
        manifest,
        rpcUrls: ['https://primary.example'],
        providerFactory: () => provider(manifest, { network: 'mainnet' }),
      }),
      /network mainnet does not match/,
    );
    await assert.rejects(
      verifyNearDeploymentReadiness({
        manifest,
        rpcUrls: ['https://primary.example'],
        providerFactory: () => provider(manifest, { pendingOwner: 'attacker.testnet' }),
      }),
      /pending owner transfer/,
    );
    await assert.rejects(
      verifyNearDeploymentReadiness({
        manifest,
        rpcUrls: ['https://primary.example'],
        providerFactory: () => provider(manifest, { transactionFailure: true }),
      }),
      /transaction does not match/,
    );
  });
});

function provider(
  manifest,
  {
    network = 'testnet',
    codeHash = manifest.deployedCodeHash,
    pendingOwner = null,
    transactionFailure = false,
  } = {},
) {
  return {
    getNetworkId: async () => network,
    viewContractCode: async () => ({
      code: WASM,
      hash: codeHash,
      block_hash: '6'.repeat(44),
      block_height: 200,
    }),
    viewAccount: async () => ({ storage_usage: 1200 }),
    callFunction: async ({ method }) => {
      if (method === 'owner_id') return manifest.ownerAccount;
      if (method === 'pending_owner_id') return pendingOwner;
      if (method === 'list_verifiers') return manifest.verifierAccounts;
      throw new Error(`Unexpected method ${method}.`);
    },
    viewTransactionStatus: async () => ({
      final_execution_status: 'FINAL',
      status: transactionFailure ? { Failure: { error: 'failed' } } : { SuccessValue: '' },
      transaction: {
        hash: manifest.deploymentTransaction.transactionHash,
        signer_id: manifest.deploymentTransaction.signerAccount,
        receiver_id: manifest.deploymentTransaction.receiverAccount,
      },
      transaction_outcome: { block_hash: manifest.deploymentTransaction.blockHash },
    }),
  };
}

function validManifest() {
  const transaction = {
    transactionHash: '4'.repeat(44),
    signerAccount: 'registry.debtshift.testnet',
    receiverAccount: 'registry.debtshift.testnet',
    blockHeight: '100',
    blockHash: '5'.repeat(44),
  };
  return {
    network: 'testnet',
    registryAccount: 'registry.debtshift.testnet',
    ownerAccount: 'owner.debtshift.testnet',
    verifierAccounts: ['verifier.debtshift.testnet'],
    wasmSha256: `0x${createHash('sha256').update(WASM).digest('hex')}`,
    deployedCodeHash: '3'.repeat(44),
    initialStorageUsage: '1000',
    deploymentTransaction: transaction,
    initializationTransaction: transaction,
  };
}
