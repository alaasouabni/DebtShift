'use client';

/*
 * Charts for the route comparison.
 *
 * Every one of these is a DISPLAY projection of authoritative backend values.
 * None of them computes an amount: widths come from `ratioPercent`, which
 * divides in BigInt and only lets a bounded percentage become a number, and the
 * figure printed beside every bar is always the formatted base-unit string.
 *
 * Where a chart extrapolates — the break-even line is a straight-line
 * projection — it says so on the chart, and names the backend field that is
 * authoritative instead.
 */

import type { ReactNode } from 'react';

import type { RouteEconomics, RouteSafety, TokenReference } from '../../lib/api/types';
import {
  bpsPercent,
  bpsToPoints,
  formatBaseUnits,
  formatBps,
  formatDuration,
  formatUsdMicro,
  ratioPercent,
} from '../../lib/formatting';
import { FINANCING_CLASS_LABELS, FINANCING_COST_KIND_LABELS } from '../../lib/labels';
import { Badge } from '../../components/ui';

/* --------------------------------------------------------------- rate bars */

interface RateRow {
  readonly label: string;
  readonly bps: number;
  readonly tone: 'muted' | 'strong' | 'accent' | 'dashed';
}

export function RateBars({ economics }: { readonly economics: RouteEconomics }) {
  const rows: RateRow[] = [
    { label: 'Today · source market', bps: economics.sourceAprBps, tone: 'strong' },
    { label: 'Destination, before your borrow', bps: economics.targetAprBeforeBps, tone: 'muted' },
    { label: 'Destination, after your borrow', bps: economics.targetAprAfterBps, tone: 'accent' },
    { label: 'Destination, under stress', bps: economics.stressTargetAprBps, tone: 'dashed' },
  ];

  // A round scale above the largest rate, so the axis reads in whole percents.
  const peak = Math.max(...rows.map((row) => row.bps));
  const scaleBps = Math.max(100, Math.ceil(peak / 100) * 100 + 100);
  const ticks = Array.from({ length: 5 }, (_, index) => (scaleBps / 4) * index);

  return (
    <figure style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <figcaption
        className="eyebrow"
        style={{ paddingBottom: 12, borderBottom: '2px solid var(--ink)' }}
      >
        Borrow rate, APR
      </figcaption>

      {rows.map((row) => (
        <div
          key={row.label}
          className="bar num"
          title={`${row.label}: ${formatBps(row.bps)}`}
          style={{
            display: 'grid',
            gridTemplateColumns: '240px minmax(0, 1fr) 72px',
            gap: '8px 16px',
            alignItems: 'center',
            padding: '14px 0',
            borderBottom: '1px solid var(--line)',
          }}
        >
          <span
            style={{
              fontSize: 15,
              lineHeight: '22px',
              fontWeight: row.tone === 'accent' ? 700 : 400,
              color: row.tone === 'muted' || row.tone === 'dashed' ? 'var(--ink-muted)' : undefined,
            }}
          >
            {row.label}
          </span>
          <span className="bar__track" style={{ display: 'block', height: 14 }}>
            <span
              style={{
                display: 'block',
                width: `${bpsPercent(row.bps, scaleBps)}%`,
                height: row.tone === 'dashed' ? 12 : 14,
                background:
                  row.tone === 'accent'
                    ? 'var(--accent)'
                    : row.tone === 'strong'
                      ? 'var(--line-strong)'
                      : row.tone === 'dashed'
                        ? 'transparent'
                        : 'var(--line)',
                border: row.tone === 'dashed' ? '1px dashed var(--line-strong)' : undefined,
                boxSizing: 'border-box',
                borderRadius: '0 4px 4px 0',
              }}
            />
          </span>
          <span
            style={{
              fontSize: 18,
              fontWeight: row.tone === 'accent' ? 700 : 600,
              textAlign: 'right',
              color: row.tone === 'muted' || row.tone === 'dashed' ? 'var(--ink-muted)' : undefined,
            }}
          >
            {formatBps(row.bps)}
          </span>
        </div>
      ))}

      <div
        className="num bar__axis"
        aria-hidden="true"
        style={{
          display: 'grid',
          gridTemplateColumns: '240px minmax(0, 1fr) 72px',
          gap: 16,
          fontSize: 12,
          lineHeight: '16px',
          color: 'var(--ink-muted)',
          paddingTop: 6,
        }}
      >
        <span />
        <span style={{ display: 'flex', justifyContent: 'space-between' }}>
          {ticks.map((tick) => (
            <span key={tick}>{formatBps(tick)}</span>
          ))}
        </span>
        <span />
      </div>

      <p
        style={{ margin: '12px 0 0', fontSize: 13, lineHeight: '18px', color: 'var(--ink-muted)' }}
      >
        Your own borrow moves the destination rate by{' '}
        <strong>{bpsToPoints(economics.targetRateImpactBps)} points</strong>. That is already priced
        in — the saving shown is after it.
      </p>
    </figure>
  );
}

/* --------------------------------------------------------- break-even chart */

/**
 * Cumulative net benefit over 90 days.
 *
 * A straight line from minus the one-off cost to the net benefit. It is an
 * orientation aid, not a model: the caption says so, and the authoritative
 * figure is the backend's `breakEvenSeconds`.
 */
export function BreakEvenChart({ economics }: { readonly economics: RouteEconomics }) {
  const horizonDays = 90;
  const cost = Number(BigInt(economics.allInCostUsdMicro) / 10_000n) / 100;
  const net = Number(BigInt(economics.netBenefitUsdMicro) / 10_000n) / 100;
  const stressNet = Number(BigInt(economics.stressNetBenefitUsdMicro) / 10_000n) / 100;

  const top = Math.max(net, stressNet, 0);
  const bottom = Math.min(-cost, stressNet, 0);
  const span = top - bottom || 1;

  const left = 56;
  const right = 700;
  const chartTop = 40;
  const chartBottom = 260;
  const y = (value: number) => chartBottom - ((value - bottom) / span) * (chartBottom - chartTop);
  const x = (day: number) => left + (day / horizonDays) * (right - left);

  const zeroY = y(0);
  const baseBreakEvenDays = net > -cost ? (cost / (net + cost)) * horizonDays : undefined;
  const stressBreakEvenDays =
    stressNet > -cost && stressNet > 0 ? (cost / (stressNet + cost)) * horizonDays : undefined;

  const backendBreakEven = economics.breakEvenSeconds
    ? formatDuration(Number(BigInt(economics.breakEvenSeconds)))
    : undefined;

  return (
    <figure style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          gap: '8px 24px',
          paddingBottom: 12,
          borderBottom: '2px solid var(--ink)',
        }}
      >
        <figcaption className="eyebrow">Cumulative net benefit, USD, first 90 days</figcaption>
        <span
          style={{
            display: 'flex',
            gap: 20,
            fontSize: 13,
            lineHeight: '16px',
            color: 'var(--ink-muted)',
          }}
        >
          <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
            <span
              aria-hidden="true"
              style={{ width: 20, height: 2, background: 'var(--accent-strong)' }}
            />
            Base case
          </span>
          <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
            <span
              aria-hidden="true"
              style={{ width: 20, height: 0, borderTop: '2px dashed var(--line-strong)' }}
            />
            Stressed
          </span>
        </span>
      </div>

      <svg
        viewBox="0 0 760 300"
        role="img"
        aria-label={`Cumulative net benefit over ${horizonDays} days. The base case starts at minus ${formatUsdMicro(economics.allInCostUsdMicro)} and reaches ${formatUsdMicro(economics.netBenefitUsdMicro)}. The stressed case reaches ${formatUsdMicro(economics.stressNetBenefitUsdMicro)}.`}
        style={{ width: '100%', height: 'auto', display: 'block', overflow: 'visible' }}
      >
        <line
          x1={left}
          y1={zeroY}
          x2={right}
          y2={zeroY}
          style={{ stroke: 'var(--ink)' }}
          strokeWidth="1"
        />

        <g
          className="num"
          style={{ fill: 'var(--ink-muted)', fontSize: 12, fontFamily: 'var(--font-sans)' }}
        >
          <text x={left} y="286" textAnchor="middle">
            Day 0
          </text>
          <text x={x(30)} y="286" textAnchor="middle">
            30
          </text>
          <text x={x(60)} y="286" textAnchor="middle">
            60
          </text>
          <text x={right} y="286" textAnchor="middle">
            {horizonDays}
          </text>
          <text x={left - 12} y={zeroY + 4} textAnchor="end">
            $0
          </text>
        </g>

        <line
          x1={left}
          y1={y(-cost)}
          x2={right}
          y2={y(stressNet)}
          style={{ stroke: 'var(--line-strong)' }}
          strokeWidth="2"
          strokeDasharray="6 5"
          strokeLinecap="round"
        />
        <line
          x1={left}
          y1={y(-cost)}
          x2={right}
          y2={y(net)}
          style={{ stroke: 'var(--accent-strong)' }}
          strokeWidth="2"
          strokeLinecap="round"
        />

        {baseBreakEvenDays !== undefined && baseBreakEvenDays <= horizonDays ? (
          <>
            <circle
              cx={x(baseBreakEvenDays)}
              cy={zeroY}
              r="6"
              style={{ fill: 'var(--accent-strong)', stroke: 'var(--surface)' }}
              strokeWidth="2"
            />
            <text
              x={x(baseBreakEvenDays)}
              y={zeroY + 25}
              textAnchor="middle"
              className="num"
              style={{
                fill: 'var(--ink)',
                fontFamily: 'var(--font-sans)',
                fontSize: 13,
                fontWeight: 600,
              }}
            >
              {Math.round(baseBreakEvenDays)} days
            </text>
          </>
        ) : null}

        {stressBreakEvenDays !== undefined && stressBreakEvenDays <= horizonDays ? (
          <circle
            cx={x(stressBreakEvenDays)}
            cy={zeroY}
            r="6"
            style={{ fill: 'var(--surface)', stroke: 'var(--line-strong)' }}
            strokeWidth="2"
          />
        ) : null}

        <g
          className="num"
          style={{ fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 600 }}
        >
          <text x={right + 10} y={y(net) + 4} style={{ fill: 'var(--ink)' }}>
            {formatUsdMicro(economics.netBenefitUsdMicro)}
          </text>
          <text x={right + 10} y={y(stressNet) + 4} style={{ fill: 'var(--ink-muted)' }}>
            {formatUsdMicro(economics.stressNetBenefitUsdMicro)}
          </text>
        </g>
      </svg>

      <p style={{ margin: 0, fontSize: 13, lineHeight: '18px', color: 'var(--ink-muted)' }}>
        Straight-line projection at the stated rates, for orientation only.
        {backendBreakEven
          ? ` The backend's breakEvenSeconds — ${backendBreakEven} — is the authoritative figure.`
          : ' The backend reported no break-even for this route.'}
      </p>
    </figure>
  );
}

/* -------------------------------------------------------------- safety bars */

function SafetyRow({
  label,
  valueLabel,
  limitLabel,
  valuePercent,
  limitPercent,
  marginLabel,
  within,
  accent,
}: {
  readonly label: string;
  readonly valueLabel: string;
  readonly limitLabel: string;
  readonly valuePercent: number;
  readonly limitPercent: number;
  readonly marginLabel: string;
  readonly within: boolean;
  readonly accent: boolean;
}) {
  return (
    <div
      style={{
        padding: '24px 0',
        borderBottom: '1px solid var(--line)',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div
        className="num"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          alignItems: 'baseline',
          gap: 8,
        }}
      >
        <span style={{ fontSize: 16, color: 'var(--ink-muted)' }}>{label}</span>
        <span>
          <span className="facts__amount" style={{ fontSize: 40, lineHeight: '44px' }}>
            {valueLabel}
          </span>{' '}
          <span style={{ fontSize: 16, color: 'var(--ink-muted)' }}>of a {limitLabel} limit</span>
        </span>
      </div>

      <div
        role="img"
        aria-label={`${label}: ${valueLabel} against a ${limitLabel} limit`}
        style={{ position: 'relative', height: 10, background: 'var(--line)', borderRadius: 4 }}
      >
        <span
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            bottom: 0,
            width: `${valuePercent}%`,
            background: within
              ? accent
                ? 'var(--accent)'
                : 'var(--line-strong)'
              : 'var(--danger)',
            borderRadius: 4,
          }}
        />
        <span
          style={{
            position: 'absolute',
            left: `${limitPercent}%`,
            top: -6,
            width: 2,
            height: 22,
            background: 'var(--ink)',
          }}
        />
      </div>

      <span
        className="num"
        style={{
          fontSize: 14,
          fontWeight: 600,
          color: within ? 'var(--success)' : 'var(--danger)',
        }}
      >
        {within ? 'Within limit' : 'Breaches the limit'} · {marginLabel}
      </span>
    </div>
  );
}

export function SafetyBars({ safety }: { readonly safety: RouteSafety }) {
  if (safety.kind === 'MAX_LTV_BPS') {
    // The chart scale is the looser of the two limits plus headroom, so both
    // rows share one axis and the tighter stressed limit visibly sits further
    // left — which is the direction the schema guarantees.
    const scale = Math.max(safety.maximumLtvBps, safety.stressMaximumLtvBps, 1) * 1.25;
    return (
      <>
        <SafetyRow
          label="After migration"
          valueLabel={formatBps(safety.postLtvBps)}
          limitLabel={formatBps(safety.maximumLtvBps)}
          valuePercent={bpsPercent(safety.postLtvBps, scale)}
          limitPercent={bpsPercent(safety.maximumLtvBps, scale)}
          marginLabel={`${bpsToPoints(safety.maximumLtvBps - safety.postLtvBps)} points of margin`}
          within={safety.postLtvBps <= safety.maximumLtvBps}
          accent
        />
        <SafetyRow
          label="Under stress"
          valueLabel={formatBps(safety.stressLtvBps)}
          limitLabel={formatBps(safety.stressMaximumLtvBps)}
          valuePercent={bpsPercent(safety.stressLtvBps, scale)}
          limitPercent={bpsPercent(safety.stressMaximumLtvBps, scale)}
          marginLabel={`${bpsToPoints(safety.stressMaximumLtvBps - safety.stressLtvBps)} points of margin`}
          within={safety.stressLtvBps <= safety.stressMaximumLtvBps}
          accent={false}
        />
        <p
          style={{
            margin: '16px 0 0',
            fontSize: 13,
            lineHeight: '18px',
            color: 'var(--ink-muted)',
          }}
        >
          The stressed limit is tighter than the normal one, never looser — the signing schema
          enforces that.
        </p>
      </>
    );
  }

  // Health factor: higher is safer, so the bar fills towards a comfortable 3.00.
  const scale = '3000000000000000000';
  return (
    <>
      <SafetyRow
        label="After migration"
        valueLabel={formatBaseUnits(safety.postHealthFactorWad, 18, { fractionDigits: 2 })}
        limitLabel={`${formatBaseUnits(safety.minimumWad, 18, { fractionDigits: 2 })} minimum`}
        valuePercent={ratioPercent(safety.postHealthFactorWad, scale)}
        limitPercent={ratioPercent(safety.minimumWad, scale)}
        marginLabel="above the minimum you sign"
        within={BigInt(safety.postHealthFactorWad) >= BigInt(safety.minimumWad)}
        accent
      />
      <SafetyRow
        label="Under stress"
        valueLabel={formatBaseUnits(safety.stressHealthFactorWad, 18, { fractionDigits: 2 })}
        limitLabel={`${formatBaseUnits(safety.stressMinimumWad, 18, { fractionDigits: 2 })} minimum`}
        valuePercent={ratioPercent(safety.stressHealthFactorWad, scale)}
        limitPercent={ratioPercent(safety.stressMinimumWad, scale)}
        marginLabel="above the stressed minimum"
        within={BigInt(safety.stressHealthFactorWad) >= BigInt(safety.stressMinimumWad)}
        accent={false}
      />
      <p
        style={{ margin: '16px 0 0', fontSize: 13, lineHeight: '18px', color: 'var(--ink-muted)' }}
      >
        A health factor below 1.00 is liquidatable. The scale runs to 3.00.
      </p>
    </>
  );
}

/* ------------------------------------------------------------ capacity bars */

interface CapacityRow {
  readonly label: string;
  readonly units: string;
}

/**
 * The four capacity bounds and the required borrow.
 *
 * The whole point of this chart is to show WHICH bound is the minimum — the
 * backend's `maximumSafeBorrowingCapacityUnits` is that minimum, so the binding
 * row is found by matching it rather than by recomputing it here.
 */
export function CapacityBars({
  financing,
  asset,
}: {
  readonly financing: {
    readonly protocolBorrowCapacityUnits: string;
    readonly policyBorrowCapacityUnits: string;
    readonly liquidityBorrowCapacityUnits: string;
    readonly signedBorrowCapacityUnits: string;
    readonly maximumSafeBorrowingCapacityUnits: string;
    readonly requiredDestinationBorrowUnits: string;
  };
  readonly asset: TokenReference;
}) {
  const rows: CapacityRow[] = [
    { label: 'Protocol', units: financing.protocolBorrowCapacityUnits },
    { label: 'Policy', units: financing.policyBorrowCapacityUnits },
    { label: 'Liquidity', units: financing.liquidityBorrowCapacityUnits },
    { label: 'Signed', units: financing.signedBorrowCapacityUnits },
  ];

  const safe = BigInt(financing.maximumSafeBorrowingCapacityUnits);
  const required = BigInt(financing.requiredDestinationBorrowUnits);

  // A scale twice the binding capacity keeps the interesting bars readable; a
  // bound far above it is marked off-scale rather than squashing everything.
  const scale = (safe > required ? safe : required) * 2n;
  const scaleUnits = (scale === 0n ? 1n : scale).toString();
  const requiredPercent = ratioPercent(financing.requiredDestinationBorrowUnits, scaleUnits);

  const headroom = safe - required;

  return (
    <figure style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <figcaption
        className="eyebrow"
        style={{ paddingBottom: 12, borderBottom: '2px solid var(--ink)' }}
      >
        Borrow capacity vs. required borrow, {asset.symbol}
      </figcaption>

      <div style={{ position: 'relative' }}>
        <div
          aria-hidden="true"
          className="capacity__marker"
          style={{
            position: 'absolute',
            left: `calc(256px + (100% - 256px - 112px) * ${requiredPercent / 100})`,
            top: 0,
            bottom: 0,
            width: 0,
            borderLeft: '2px dashed var(--ink)',
            zIndex: 1,
          }}
        />

        {rows.map((row) => {
          const binding = BigInt(row.units) === safe;
          const offScale = BigInt(row.units) > scale;
          return (
            <div
              key={row.label}
              className="num bar"
              title={`${row.label} capacity ${formatBaseUnits(row.units, asset.decimals)}${binding ? ' — binding' : ''}`}
              style={{
                display: 'grid',
                gridTemplateColumns: '240px minmax(0, 1fr) 96px',
                gap: 16,
                alignItems: 'center',
                padding: '14px 0',
                borderBottom: '1px solid var(--line)',
              }}
            >
              <span
                style={{
                  fontSize: 15,
                  fontWeight: binding ? 700 : 400,
                  color: binding ? undefined : 'var(--ink-muted)',
                  display: 'flex',
                  gap: 8,
                  alignItems: 'center',
                  flexWrap: 'wrap',
                }}
              >
                {row.label}
                {binding ? <Badge tone="accent">Binding</Badge> : null}
              </span>

              <span
                className="bar__track"
                style={
                  offScale
                    ? { display: 'flex', alignItems: 'center', gap: 4, height: 12 }
                    : { display: 'block', height: 12 }
                }
              >
                {offScale ? (
                  <>
                    <span style={{ flex: 1, height: 12, background: 'var(--line)' }} />
                    <span aria-hidden="true" style={{ fontSize: 12, color: 'var(--ink-muted)' }}>
                      →
                    </span>
                  </>
                ) : (
                  <span
                    style={{
                      display: 'block',
                      width: `${ratioPercent(row.units, scaleUnits)}%`,
                      height: 12,
                      background: binding ? 'var(--accent)' : 'var(--line)',
                      borderRadius: '0 4px 4px 0',
                    }}
                  />
                )}
              </span>

              <span
                style={{
                  fontSize: 15,
                  textAlign: 'right',
                  fontWeight: binding ? 700 : 400,
                  color: binding ? undefined : 'var(--ink-muted)',
                }}
              >
                {formatBaseUnits(row.units, asset.decimals)}
              </span>
            </div>
          );
        })}
      </div>

      <div
        className="num"
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          gap: 8,
          paddingTop: 8,
          fontSize: 13,
          lineHeight: '18px',
          color: 'var(--ink-muted)',
        }}
      >
        <span>
          <span
            aria-hidden="true"
            style={{
              display: 'inline-block',
              width: 14,
              borderTop: '2px dashed var(--ink)',
              verticalAlign: 'middle',
              marginRight: 6,
            }}
          />
          Required borrow{' '}
          {formatBaseUnits(financing.requiredDestinationBorrowUnits, asset.decimals)}
          {headroom >= 0n
            ? ` — ${formatBaseUnits(headroom.toString(), asset.decimals)} under the binding limit`
            : ` — ${formatBaseUnits((-headroom).toString(), asset.decimals)} OVER the binding limit`}
        </span>
        <span>Safe capacity is the smallest of the four.</span>
      </div>
    </figure>
  );
}

/* -------------------------------------------------------- cost composition */

interface CostComponent {
  readonly componentId: string;
  readonly kind: keyof typeof FINANCING_COST_KIND_LABELS;
  readonly financingClass: keyof typeof FINANCING_CLASS_LABELS;
  readonly settlementAmountUnits: string;
  readonly counted?: boolean | undefined;
}

const CLASS_FILL: Record<string, string> = {
  CAPITALIZED: 'var(--ink)',
  SOLVER_ADVANCED: 'var(--accent)',
  SEPARATELY_PAID: 'var(--line-strong)',
};

/**
 * Where the financed costs go.
 *
 * The legend is built from the classes actually present in the response rather
 * than from a fixed pair — on the local stack every component currently comes
 * back SEPARATELY_PAID, and a chart hardcoded to "capitalized vs advanced"
 * would have rendered an empty bar and a lie.
 */
export function CostComposition({
  components,
  asset,
  totals,
}: {
  readonly components: readonly CostComponent[];
  readonly asset: TokenReference;
  readonly totals: {
    readonly capitalizedCostUnits: string;
    readonly solverAdvancedCostUnits: string;
    readonly separatelyPaidCostUnits: string;
  };
}) {
  const counted = components.filter((component) => component.counted !== false);
  const total = counted.reduce(
    (sum, component) => sum + BigInt(component.settlementAmountUnits),
    0n,
  );
  const presentClasses = [...new Set(counted.map((component) => component.financingClass))];

  if (counted.length === 0 || total === 0n) {
    return (
      <p style={{ margin: 0, fontSize: 15, lineHeight: '22px', color: 'var(--ink-muted)' }}>
        The backend reported no financed cost components for this route.
      </p>
    );
  }

  return (
    <figure style={{ margin: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'space-between',
          gap: '8px 24px',
          paddingBottom: 12,
          borderBottom: '2px solid var(--ink)',
        }}
      >
        <figcaption className="eyebrow">
          Where the {formatBaseUnits(total.toString(), asset.decimals)} {asset.symbol} of costs go
        </figcaption>
        <span
          style={{
            display: 'flex',
            gap: 20,
            flexWrap: 'wrap',
            fontSize: 13,
            lineHeight: '16px',
            color: 'var(--ink-muted)',
          }}
        >
          {presentClasses.map((financingClass) => (
            <span
              key={financingClass}
              style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 12,
                  height: 12,
                  borderRadius: 2,
                  background: CLASS_FILL[financingClass] ?? 'var(--line)',
                }}
              />
              {FINANCING_CLASS_LABELS[financingClass].label}
            </span>
          ))}
        </span>
      </div>

      <div
        role="img"
        aria-label={counted
          .map(
            (component) =>
              `${FINANCING_COST_KIND_LABELS[component.kind]} ${formatBaseUnits(component.settlementAmountUnits, asset.decimals)}, ${FINANCING_CLASS_LABELS[component.financingClass].label.toLowerCase()}`,
          )
          .join('; ')}
        style={{ display: 'flex', gap: 2, height: 28 }}
      >
        {counted.map((component, index) => (
          <span
            key={component.componentId}
            title={`${FINANCING_COST_KIND_LABELS[component.kind]} · ${formatBaseUnits(component.settlementAmountUnits, asset.decimals)} · ${FINANCING_CLASS_LABELS[component.financingClass].label}`}
            style={{
              flex: ratioPercent(component.settlementAmountUnits, total.toString()) || 0.01,
              background: CLASS_FILL[component.financingClass] ?? 'var(--line)',
              borderRadius:
                index === 0
                  ? '4px 0 0 4px'
                  : index === counted.length - 1
                    ? '0 4px 4px 0'
                    : undefined,
            }}
          />
        ))}
      </div>

      <div
        className="num costlbl"
        style={{ display: 'flex', gap: 2, fontSize: 13, lineHeight: '18px' }}
      >
        {counted.map((component) => (
          <span
            key={component.componentId}
            style={{
              flex: ratioPercent(component.settlementAmountUnits, total.toString()) || 0.01,
              minWidth: 0,
            }}
          >
            <strong>{formatBaseUnits(component.settlementAmountUnits, asset.decimals)}</strong>
            <br />
            <span style={{ color: 'var(--ink-muted)' }}>
              {FINANCING_COST_KIND_LABELS[component.kind]}
            </span>
          </span>
        ))}
      </div>

      <p
        className="num"
        style={{ margin: 0, fontSize: 13, lineHeight: '18px', color: 'var(--ink-muted)' }}
      >
        Each cost appears once: {counted.length} component{counted.length === 1 ? '' : 's'}, all
        counted. Capitalized {formatBaseUnits(totals.capitalizedCostUnits, asset.decimals)} ·
        solver-advanced {formatBaseUnits(totals.solverAdvancedCostUnits, asset.decimals)} · paid
        separately {formatBaseUnits(totals.separatelyPaidCostUnits, asset.decimals)}.
      </p>
    </figure>
  );
}

/* ------------------------------------------------------------- figure strip */

export function FigureStrip({
  figures,
}: {
  readonly figures: readonly {
    readonly label: string;
    readonly value: string;
    readonly note: ReactNode;
    readonly tone?: 'success' | 'danger';
  }[];
}) {
  return (
    <div
      className="figs num"
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${figures.length}, minmax(0, 1fr))`,
        gap: '0 var(--space-6)',
        marginTop: 16,
        borderTop: '2px solid var(--ink)',
      }}
    >
      {figures.map((figure) => (
        <div
          key={figure.label}
          style={{ padding: '20px 0', display: 'flex', flexDirection: 'column', gap: 4 }}
        >
          <span style={{ fontSize: 14, lineHeight: '20px', color: 'var(--ink-muted)' }}>
            {figure.label}
          </span>
          <span
            className="figs__amount"
            style={{ fontSize: 40, lineHeight: '44px', fontWeight: 700, letterSpacing: '-0.02em' }}
          >
            {figure.value}
          </span>
          <span
            style={{
              fontSize: 13,
              lineHeight: '18px',
              color: figure.tone ? `var(--${figure.tone})` : 'var(--ink-muted)',
              fontWeight: figure.tone ? 600 : 400,
            }}
          >
            {figure.note}
          </span>
        </div>
      ))}
    </div>
  );
}
