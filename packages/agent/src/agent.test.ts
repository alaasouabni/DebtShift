import type { PositionSnapshot } from '@debtshift/domain';
import {
  evaluateRefinancingFeasibility,
  refinancingFeasibilityInputSchema,
  type RouteCandidate,
  type RouteComparison,
  type RoutePolicy,
} from '@debtshift/optimizer';
import { describe, expect, it, vi } from 'vitest';

import {
  assertPublicRemoteEndpoint,
  isNonPublicIp,
  parseLocalOllamaBaseUrl,
  parseRemoteBaseUrl,
  type DnsLookup,
} from './endpoint-security.js';
import { RouteExplanationService } from './explanations.js';
import {
  DeterministicRouteRiskAgent,
  ROUTE_RISK_AGENT_CAPABILITIES,
  type RouteRiskTools,
} from './route-risk-agent.js';

const BORROWER = '0xa1d79dfa76e98D5e8A776114d9524c4B6E888daa' as const;

describe('deterministic Route/Risk Agent', () => {
  it('uses only read-only discovery tools and returns identical financial decisions', async () => {
    const source = sourcePosition();
    const candidate = routeCandidate();
    const tools: RouteRiskTools = {
      getSourcePositions: vi.fn(async () => [source]),
      getRouteCandidates: vi.fn(async () => [candidate]),
    };
    const agent = new DeterministicRouteRiskAgent(tools);
    const request = { wallet: BORROWER, sourceChainIds: [8453], policy: routePolicy() };

    const first = await agent.analyzeWallet(request);
    const second = await agent.analyzeWallet(request);

    expect(first).toEqual(second);
    expect(first.analyses[0]?.comparison.selectedCandidateId).toBe('safe-route');
    expect(ROUTE_RISK_AGENT_CAPABILITIES).toEqual([
      'GET_SOURCE_POSITIONS',
      'GET_ROUTE_CANDIDATES',
      'COMPARE_ROUTES',
    ]);
    expect(ROUTE_RISK_AGENT_CAPABILITIES.join(' ')).not.toMatch(/SIGN|BROADCAST|RESERVE|TRANSFER/);
  });
});

describe('explanation-only providers', () => {
  const comparison = selectedComparison();

  it('uses deterministic templates by default with no credential or model', async () => {
    const result = await new RouteExplanationService().explain(comparison);

    expect(result.provider).toBe('DETERMINISTIC');
    expect(result.fallbackUsed).toBe(false);
    expect(result.explanation.summary).toContain('passes the deterministic');
    expect(result.explanation.reviewAndSignStatement).toContain('cannot authorize execution');
  });

  it('accepts a user-supplied API response without exposing the key in its payload', async () => {
    const credential = 'user-secret-that-must-not-persist';
    let capturedBody = '';
    let capturedAuthorization = '';
    const fetcher: typeof fetch = vi.fn(async (_input, init) => {
      capturedBody = String(init?.body ?? '');
      capturedAuthorization = new Headers(init?.headers).get('authorization') ?? '';
      return new Response(
        JSON.stringify({ choices: [{ message: { content: JSON.stringify(aiExplanation()) } }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    const service = new RouteExplanationService({ allowCustomEndpoints: true, fetcher });
    const deterministic = await service.explain(comparison);

    const result = await service.explain(comparison, {
      mode: 'USER_API',
      provider: 'CUSTOM',
      model: 'user-model',
      apiKey: credential,
      baseUrl: 'https://93.184.216.34/v1/',
    });

    expect(result.provider).toBe('USER_API');
    expect(result.fallbackUsed).toBe(false);
    expect(result.decisionHash).toBe(deterministic.decisionHash);
    expect(capturedAuthorization).toBe(`Bearer ${credential}`);
    expect(capturedBody).not.toContain(credential);
    expect(JSON.stringify(result)).not.toContain(credential);
  });

  it('falls back without changing the deterministic decision hash on malformed model output', async () => {
    const service = new RouteExplanationService({
      fetcher: vi.fn(async () =>
        Promise.resolve(
          new Response(JSON.stringify({ message: { content: '{"summary":"incomplete"}' } }), {
            status: 200,
          }),
        ),
      ),
    });
    const deterministic = await service.explain(comparison);
    const local = await service.explain(comparison, {
      mode: 'LOCAL_AI',
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen3.5:4b',
    });

    expect(local.fallbackUsed).toBe(true);
    expect(local.decisionHash).toBe(deterministic.decisionHash);
    expect(local.explanation).toEqual(deterministic.explanation);
  });
});

describe('AI endpoint security', () => {
  it('separates loopback-only Ollama from public HTTPS remote endpoints', () => {
    expect(parseLocalOllamaBaseUrl('http://127.0.0.1:11434').hostname).toBe('127.0.0.1');
    expect(() => parseLocalOllamaBaseUrl('http://192.168.1.10:11434')).toThrow('loopback');
    expect(() => parseRemoteBaseUrl('http://example.com/v1')).toThrow('HTTPS');
    expect(() => parseRemoteBaseUrl('https://127.0.0.1/v1')).toThrow('non-public');
    expect(() => parseRemoteBaseUrl('https://user:password@example.com/v1')).toThrow('credentials');
  });

  it('rejects private, loopback, link-local, documentation, and mapped addresses', () => {
    for (const address of [
      '10.0.0.1',
      '127.0.0.1',
      '169.254.169.254',
      '172.16.0.1',
      '192.168.1.1',
      '198.51.100.10',
      '203.0.113.10',
      '::1',
      'fc00::1',
      'fe80::1',
      '2001:db8::1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '2002:7f00:1::',
    ]) {
      expect(isNonPublicIp(address), address).toBe(true);
    }
    expect(isNonPublicIp('93.184.216.34')).toBe(false);
    expect(isNonPublicIp('2606:4700:4700::1111')).toBe(false);
  });

  it('rejects a hostname when any DNS result is private and never reaches the provider', async () => {
    const lookup = (async () => [
      { address: '93.184.216.34', family: 4 as const },
      { address: '169.254.169.254', family: 4 as const },
    ]) as unknown as DnsLookup;

    await expect(
      assertPublicRemoteEndpoint(new URL('https://provider.example/v1/'), lookup),
    ).rejects.toThrow('non-public');
  });
});

function sourcePosition(): PositionSnapshot {
  return {
    snapshotId: `0x${'11'.repeat(32)}`,
    position: {
      market: {
        chainId: 8453,
        protocol: 'AAVE_V3',
        deployment: '0x1000000000000000000000000000000000000001',
        marketId: `0x${'12'.repeat(32)}`,
      },
      borrower: BORROWER,
      collateralAsset: {
        chainId: 8453,
        address: '0x2000000000000000000000000000000000000002',
        decimals: 18,
        symbol: 'WETH',
      },
      debtAsset: {
        chainId: 8453,
        address: '0x3000000000000000000000000000000000000003',
        decimals: 6,
        symbol: 'USDC',
      },
    },
    collateralUnits: '10000000000000000000' as never,
    debtUnits: '10000000000' as never,
    health: { kind: 'AAVE_HEALTH_FACTOR', healthFactorWad: '1600000000000000000' as never },
    borrowAprBps: 900,
    block: {
      number: '100' as never,
      hash: `0x${'13'.repeat(32)}`,
      observedAt: '2026-11-09T12:00:00.000Z',
    },
  };
}

function routeCandidate(): RouteCandidate {
  return {
    candidateId: 'safe-route',
    market: {
      snapshotId: `0x${'21'.repeat(32)}`,
      market: {
        chainId: 42161,
        protocol: 'MORPHO_BLUE',
        deployment: '0x4000000000000000000000000000000000000004',
        marketId: `0x${'22'.repeat(32)}`,
      },
      collateralAsset: {
        chainId: 42161,
        address: '0x5000000000000000000000000000000000000005',
        decimals: 18,
        symbol: 'WETH',
      },
      debtAsset: {
        chainId: 42161,
        address: '0x6000000000000000000000000000000000000006',
        decimals: 6,
        symbol: 'USDC',
      },
      borrowAprBps: 500,
      availableBorrowUnits: '100000000000' as never,
      lltvBps: 7500,
      oracle: {
        oracle: 'verified-oracle',
        priceMantissa: '2000000000000000000000' as never,
        priceDecimals: 18,
        updatedAt: '2026-11-09T12:00:00.000Z',
        block: {
          number: '200' as never,
          hash: `0x${'23'.repeat(32)}`,
          observedAt: '2026-11-09T12:00:00.000Z',
        },
      },
      block: {
        number: '200' as never,
        hash: `0x${'23'.repeat(32)}`,
        observedAt: '2026-11-09T12:00:00.000Z',
      },
    },
    requestedBorrowUnits: '10000000000' as never,
    principalDebtValueUsdMicro: '10000000000' as never,
    targetDebtValueUsdMicro: '10000000000' as never,
    deliveredCollateralValueUsdMicro: '20000000000' as never,
    costs: {
      sourceGasUsdMicro: '10000000' as never,
      destinationGasUsdMicro: '10000000' as never,
      transportFeeUsdMicro: '20000000' as never,
      slippageUsdMicro: '10000000' as never,
      solverFeeUsdMicro: '10000000' as never,
      protocolFeeUsdMicro: '5000000' as never,
      collateralSwapCostUsdMicro: '0' as never,
    },
    carryingCostAprBps: 0,
    tailLossEstimateUsdMicro: '0' as never,
    settlementRiskCostUsdMicro: '0' as never,
    dependencyRiskCostUsdMicro: '0' as never,
    estimatedSettlementSeconds: 120,
    settlementTimeP95Seconds: 300,
    rateProjection: {
      kind: 'DIRECT_PROJECTION',
      currentBorrowAprBps: 500,
      projectedBorrowAprBps: 500,
      provenance: 'direct-read-fixture',
    },
    assetRouteSupported: true,
    adapterVersionApproved: true,
    transportMinimumMet: true,
    financing: financingInput(),
  };
}

function routePolicy(): RoutePolicy {
  return {
    evaluatedAt: '2026-11-09T12:00:10.000Z',
    horizonDays: 180,
    maxAllInCostUsdMicro: '100000000' as never,
    minAprReductionBps: 150,
    maxPositionSnapshotAgeSeconds: 15,
    maxMarketSnapshotAgeSeconds: 15,
    maxOracleAgeSeconds: 15,
    minimumLiquidityBufferBps: 1000,
    stressCollateralDropBps: 1000,
    stressTargetAprIncreaseBps: 200,
    requirePositiveNetBenefit: true,
    safetyPolicy: {
      kind: 'MAX_LTV_BPS',
      maximumLtvBps: 7000,
      stressMaximumLtvBps: 6500,
    },
  };
}

function selectedComparison(): RouteComparison {
  return {
    policyVersion: 1,
    selectedCandidateId: 'safe-route',
    evaluations: [
      {
        candidateId: 'safe-route',
        eligible: true,
        rank: 1,
        scoreUsdMicro: '100000000',
        economics: {
          sourceAprBps: 900,
          targetAprBeforeBps: 500,
          targetAprAfterBps: 500,
          targetRateImpactBps: 0,
          aprReductionBps: 400,
          stressTargetAprBps: 700,
          allInCostUsdMicro: '85000000',
          carryingCostUsdMicro: '0',
          grossSavingsUsdMicro: '197260273',
          stressGrossSavingsUsdMicro: '98630136',
          netBenefitUsdMicro: '112260273',
          stressNetBenefitUsdMicro: '13630136',
          annualGrossSavingsUsdMicro: '400000000',
          breakEvenSeconds: '6701400',
        },
        safety: {
          kind: 'MAX_LTV_BPS',
          postLtvBps: 5000,
          stressLtvBps: 5556,
          maximumLtvBps: 7000,
          stressMaximumLtvBps: 6500,
        },
        rejections: [],
        financing: evaluateRefinancingFeasibility(financingInput()),
        provenance: {
          sourceSnapshotId: `0x${'11'.repeat(32)}`,
          marketSnapshotId: `0x${'21'.repeat(32)}`,
          marketBlockNumber: '200',
          marketBlockHash: `0x${'23'.repeat(32)}`,
          oracleUpdatedAt: '2026-11-09T12:00:00.000Z',
          evaluatedAt: '2026-11-09T12:00:10.000Z',
          rateProjection: 'direct-read-fixture',
        },
      },
    ],
  };
}

function financingInput() {
  const sourceAsset = {
    chainId: 8453,
    address: '0x3000000000000000000000000000000000000003',
    decimals: 6,
    symbol: 'USDC',
  };
  const settlementAsset = {
    chainId: 42161,
    address: '0x6000000000000000000000000000000000000006',
    decimals: 6,
    symbol: 'USDC',
  };
  return refinancingFeasibilityInputSchema.parse({
    evaluatedAt: '2026-11-09T12:00:10.000Z',
    settlementAsset,
    sourcePayoff: {
      asset: sourceAsset,
      amountUnits: '10000000000',
      settlementAmountUnits: '10000000000',
      conversion: {
        quoteHash: `0x${'24'.repeat(32)}`,
        provider: 'agent-fixture-conversion',
        inputAsset: sourceAsset,
        outputAsset: settlementAsset,
        amountInUnits: '10000000000',
        amountOutUnits: '10000000000',
        expiresAt: '2026-11-09T12:10:00.000Z',
      },
    },
    costs: [],
    solverFee: {
      asset: settlementAsset,
      amountUnits: '0',
      signedCapUnits: '100000000',
    },
    externalFunding: [],
    capacities: {
      protocolUnits: '20000000000',
      policyUnits: '20000000000',
      liquidityUnits: '20000000000',
      signedUnits: '20000000000',
    },
  });
}

function aiExplanation() {
  return {
    summary: 'The route passes deterministic policy.',
    mainEconomicBenefit: 'The route lowers projected borrowing cost.',
    mainRisks: ['Rates can change before settlement.'],
    breakEvenExplanation: 'Projected break-even is 77.6 days.',
    safetyExplanation: 'Stressed LTV remains below policy.',
    dataFreshnessWarning: 'Critical state must be read again before execution.',
    reviewAndSignStatement: 'Review all exact terms before signing.',
  };
}
