import { describe, expect, it, vi } from 'vitest';

import { RetryableReceiptRegistryError } from '../handlers.js';
import {
  NearRpcFailoverClient,
  NearRpcNetworkMismatchError,
  type NearRpcEndpoint,
} from './near-rpc-failover.js';

describe('NEAR RPC failover', () => {
  it('fails over final-state reads and keeps the healthy endpoint selected for writes', async () => {
    const primary = endpoint('testnet', new Error('primary unavailable'));
    const fallback = endpoint('testnet', { agreement: 'final' });
    const client = new NearRpcFailoverClient('testnet', [primary, fallback]);

    await expect(client.view('get_agreement', { agreement_id: 'one' })).resolves.toEqual({
      agreement: 'final',
    });
    await expect(client.code('registry.testnet')).resolves.toEqual(
      new Uint8Array([0, 97, 115, 109]),
    );
    await expect(client.call('append_attestation', { agreement_id: 'one' })).resolves.toEqual({
      transaction: 'final',
    });

    expect(primary.view).toHaveBeenCalledOnce();
    expect(primary.call).not.toHaveBeenCalled();
    expect(fallback.view).toHaveBeenCalledOnce();
    expect(fallback.code).toHaveBeenCalledOnce();
    expect(fallback.call).toHaveBeenCalledOnce();
  });

  it('never rebroadcasts a write and rotates only for the next reconciled attempt', async () => {
    const primary = endpoint('testnet', { agreement: 'final' });
    primary.call.mockRejectedValueOnce(new Error('response lost after submission'));
    const fallback = endpoint('testnet', { agreement: 'final-on-fallback' });
    const client = new NearRpcFailoverClient('testnet', [primary, fallback]);

    await client.view('get_agreement', { agreement_id: 'one' });
    await expect(client.call('register_agreement', { agreement_id: 'one' })).rejects.toThrow(
      'write outcome is uncertain',
    );
    expect(primary.call).toHaveBeenCalledOnce();
    expect(fallback.call).not.toHaveBeenCalled();

    await expect(client.view('get_agreement', { agreement_id: 'one' })).resolves.toEqual({
      agreement: 'final-on-fallback',
    });
    expect(fallback.view).toHaveBeenCalledOnce();
  });

  it('fails closed when an endpoint targets the wrong network', async () => {
    const wrongNetwork = endpoint('mainnet', { agreement: 'wrong' });
    const client = new NearRpcFailoverClient('testnet', [wrongNetwork]);

    await expect(client.view('get_agreement', {})).rejects.toBeInstanceOf(
      NearRpcNetworkMismatchError,
    );
    expect(wrongNetwork.view).not.toHaveBeenCalled();
  });

  it('returns a retryable generic error without exposing endpoint failures', async () => {
    const first = endpoint('testnet', new Error('https://provider.example/secret-key'));
    const second = endpoint('testnet', new Error('authorization token leaked by provider'));
    const client = new NearRpcFailoverClient('testnet', [first, second]);

    const failure = await client.view('get_agreement', {}).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(RetryableReceiptRegistryError);
    expect(String(failure)).not.toContain('secret-key');
    expect(String(failure)).not.toContain('authorization token');
  });
});

function endpoint(network: string, viewResult: unknown) {
  return {
    getNetworkId: vi.fn(async () => network),
    code: vi.fn(async () => new Uint8Array([0, 97, 115, 109])),
    view:
      viewResult instanceof Error
        ? vi.fn(async () => Promise.reject(viewResult))
        : vi.fn(async () => viewResult),
    call: vi.fn(async () => ({ transaction: 'final' })),
  } satisfies NearRpcEndpoint & {
    getNetworkId: ReturnType<typeof vi.fn>;
    code: ReturnType<typeof vi.fn>;
    view: ReturnType<typeof vi.fn>;
    call: ReturnType<typeof vi.fn>;
  };
}
