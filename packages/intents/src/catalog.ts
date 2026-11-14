import type { TokenReference } from '@debtshift/domain';
import { getAddress, isAddressEqual } from 'viem';

import type { OneClickToken } from './one-click.js';

export interface ResolvedOneClickAsset {
  readonly assetId: string;
  readonly blockchain: string;
  readonly symbol: string;
  readonly decimals: number;
  readonly contractAddress: string;
  readonly price: number;
  readonly priceUpdatedAt: string;
}

/**
 * Resolves provider identity by the exact configured asset ID and then proves
 * the provider row still matches the onchain token address and decimals. A
 * symbol-only match is never accepted.
 */
export function resolveOneClickAsset(
  catalog: readonly OneClickToken[],
  token: TokenReference,
): ResolvedOneClickAsset {
  if (token.providerAssetId === undefined) {
    throw new Error(`Token ${token.chainId}:${token.address} has no 1Click asset ID.`);
  }
  const matches = catalog.filter((entry) => entry.assetId === token.providerAssetId);
  if (matches.length !== 1) {
    throw new Error(
      `1Click catalog must contain exactly one row for asset ${token.providerAssetId}.`,
    );
  }
  const match = matches[0];
  if (match === undefined || match.contractAddress == null) {
    throw new Error(`1Click asset ${token.providerAssetId} has no EVM contract address.`);
  }
  let providerAddress;
  try {
    providerAddress = getAddress(match.contractAddress);
  } catch {
    throw new Error(`1Click asset ${token.providerAssetId} has an invalid EVM contract address.`);
  }
  if (!isAddressEqual(providerAddress, token.address) || match.decimals !== token.decimals) {
    throw new Error(
      `1Click asset ${token.providerAssetId} does not match the configured token identity.`,
    );
  }
  return {
    assetId: match.assetId,
    blockchain: match.blockchain,
    symbol: match.symbol,
    decimals: match.decimals,
    contractAddress: providerAddress,
    price: match.price,
    priceUpdatedAt: match.priceUpdatedAt,
  };
}

export function verifyOneClickRouteAssets(
  catalog: readonly OneClickToken[],
  tokens: readonly TokenReference[],
): readonly ResolvedOneClickAsset[] {
  const seen = new Set<string>();
  return tokens.map((token) => {
    const resolved = resolveOneClickAsset(catalog, token);
    if (seen.has(resolved.assetId)) {
      throw new Error(`1Click route contains duplicate asset identity ${resolved.assetId}.`);
    }
    seen.add(resolved.assetId);
    return resolved;
  });
}
