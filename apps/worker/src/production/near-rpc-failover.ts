import { RetryableReceiptRegistryError } from '../handlers.js';

export interface NearRpcEndpoint {
  getNetworkId(): Promise<string>;
  view(methodName: string, args: Readonly<Record<string, unknown>>): Promise<unknown>;
  call(methodName: string, args: Readonly<Record<string, unknown>>): Promise<unknown>;
}

export class NearRpcNetworkMismatchError extends Error {
  override readonly name = 'NearRpcNetworkMismatchError';
}

/**
 * Fails over idempotent final-state reads immediately. A write is attempted on
 * exactly one endpoint: an ambiguous failure rotates the preferred endpoint
 * for the next durable command attempt, which must reconcile contract state
 * before it is permitted to write again.
 */
export class NearRpcFailoverClient {
  readonly #validated = new Set<number>();
  #activeIndex = 0;

  constructor(
    private readonly expectedNetwork: 'sandbox' | 'testnet' | 'mainnet',
    private readonly endpoints: readonly NearRpcEndpoint[],
  ) {
    if (endpoints.length === 0 || endpoints.length > 5) {
      throw new Error('NEAR RPC failover requires between one and five endpoints.');
    }
  }

  async view(methodName: string, args: Readonly<Record<string, unknown>>): Promise<unknown> {
    let networkMismatch: NearRpcNetworkMismatchError | undefined;
    for (let offset = 0; offset < this.endpoints.length; offset += 1) {
      const index = (this.#activeIndex + offset) % this.endpoints.length;
      const endpoint = this.endpoints[index];
      if (endpoint === undefined) continue;
      try {
        await this.#ensureNetwork(index, endpoint);
        const result = await endpoint.view(methodName, args);
        this.#activeIndex = index;
        return result;
      } catch (error) {
        if (error instanceof NearRpcNetworkMismatchError) networkMismatch = error;
      }
    }
    if (networkMismatch !== undefined) throw networkMismatch;
    throw new RetryableReceiptRegistryError(
      `All ${this.endpoints.length.toString()} configured NEAR RPC endpoints failed a final-state read.`,
    );
  }

  async call(methodName: string, args: Readonly<Record<string, unknown>>): Promise<unknown> {
    const index = this.#activeIndex;
    const endpoint = this.endpoints[index];
    if (endpoint === undefined) throw new Error('NEAR RPC active endpoint is unavailable.');
    try {
      await this.#ensureNetwork(index, endpoint);
    } catch (error) {
      if (error instanceof NearRpcNetworkMismatchError) throw error;
      this.#rotateAfter(index);
      throw new RetryableReceiptRegistryError(
        'NEAR RPC failed before the registry write could be submitted.',
      );
    }
    try {
      return await endpoint.call(methodName, args);
    } catch {
      this.#rotateAfter(index);
      throw new RetryableReceiptRegistryError(
        'NEAR registry write outcome is uncertain; contract state must be reconciled before retry.',
      );
    }
  }

  async #ensureNetwork(index: number, endpoint: NearRpcEndpoint): Promise<void> {
    if (this.#validated.has(index)) return;
    const actual = await endpoint.getNetworkId();
    if (actual !== this.expectedNetwork) {
      throw new NearRpcNetworkMismatchError(
        `Configured NEAR RPC network ${actual} does not match ${this.expectedNetwork}.`,
      );
    }
    this.#validated.add(index);
  }

  #rotateAfter(index: number): void {
    this.#activeIndex = (index + 1) % this.endpoints.length;
  }
}
