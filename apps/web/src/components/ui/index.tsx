/*
 * Design-system primitives.
 *
 * These map one-to-one onto the DebtShift design system's components
 * (`dsh-btn`, `dsh-badge`, `dsh-alert`, `dsh-card`, `dsh-field`) whose classes
 * live in `globals.css`. No colour, radius or spacing value is written here —
 * everything comes from the custom properties.
 */

import Link from 'next/link';
import type { ButtonHTMLAttributes, ReactNode } from 'react';

import type { Tone } from '../../lib/labels/index';

/* -------------------------------------------------------------------- badge */

export function Badge({
  tone = 'neutral',
  children,
  title,
}: {
  readonly tone?: Tone;
  readonly children: ReactNode;
  readonly title?: string | undefined;
}) {
  return (
    <span className={`dsh-badge dsh-badge--${tone}`} title={title}>
      {children}
    </span>
  );
}

/* ------------------------------------------------------------------- button */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'md' | 'sm';

function buttonClass(variant: ButtonVariant, size: ButtonSize, full?: boolean): string {
  return ['dsh-btn', `dsh-btn--${variant}`, `dsh-btn--${size}`, full ? 'dsh-btn--full' : undefined]
    .filter(Boolean)
    .join(' ');
}

export function Button({
  variant = 'primary',
  size = 'md',
  full,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly full?: boolean;
}) {
  return (
    <button
      type="button"
      {...rest}
      className={`${buttonClass(variant, size, full)}${className ? ` ${className}` : ''}`}
    />
  );
}

export function ButtonLink({
  href,
  variant = 'primary',
  size = 'md',
  full,
  children,
}: {
  readonly href: string;
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly full?: boolean;
  readonly children: ReactNode;
}) {
  const className = buttonClass(variant, size, full);
  // Props are not spread through: `next/link` does not accept an explicitly
  // undefined member under exactOptionalPropertyTypes, and a styled link needs
  // nothing beyond its destination.
  if (href.startsWith('http')) {
    return (
      <a href={href} className={className}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={className}>
      {children}
    </Link>
  );
}

/* -------------------------------------------------------------------- alert */

const ALERT_ICONS: Record<'info' | 'success' | 'warning' | 'danger', ReactNode> = {
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  success: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12.5 2.5 2.5 4.5-5" />
    </>
  ),
  warning: (
    <>
      <path d="M10.3 4.3 2.6 17.4A1.9 1.9 0 0 0 4.3 20.3h15.4a1.9 1.9 0 0 0 1.7-2.9L13.7 4.3a1.9 1.9 0 0 0-3.4 0Z" />
      <path d="M12 10v4M12 17h.01" />
    </>
  ),
  danger: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 8v5M12 16h.01" />
    </>
  ),
};

export function Alert({
  tone = 'info',
  title,
  children,
  action,
}: {
  readonly tone?: 'info' | 'success' | 'warning' | 'danger';
  readonly title: string;
  readonly children?: ReactNode;
  readonly action?: ReactNode;
}) {
  const modifier = tone === 'info' ? '' : ` dsh-alert--${tone}`;
  return (
    <div className={`dsh-alert${modifier}`} role={tone === 'danger' ? 'alert' : undefined}>
      <svg
        className="dsh-alert__icon"
        aria-hidden="true"
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {ALERT_ICONS[tone]}
      </svg>
      <div className="dsh-alert__body">
        <p className="dsh-alert__title">{title}</p>
        {children ? <div className="dsh-alert__text">{children}</div> : null}
      </div>
      {action ? <div className="dsh-alert__action">{action}</div> : null}
    </div>
  );
}

/* --------------------------------------------------------------------- card */

export function Card({
  eyebrow,
  title,
  figure,
  children,
  footer,
  tone,
}: {
  readonly eyebrow?: string;
  readonly title?: string;
  readonly figure?: ReactNode;
  readonly children?: ReactNode;
  readonly footer?: ReactNode;
  readonly tone?: Tone;
}) {
  return (
    <section
      className="dsh-card"
      style={
        tone === 'danger'
          ? { borderColor: 'var(--danger)' }
          : tone === 'success'
            ? { borderColor: 'var(--success)' }
            : undefined
      }
    >
      {eyebrow || title ? (
        <div className="dsh-card__head">
          <div>
            {eyebrow ? <p className="dsh-card__eyebrow">{eyebrow}</p> : null}
            {title ? <h3 className="dsh-card__title">{title}</h3> : null}
          </div>
        </div>
      ) : null}
      {figure ? <p className="dsh-card__figure num">{figure}</p> : null}
      {children ? <div className="dsh-card__body">{children}</div> : null}
      {footer ? <div className="dsh-card__foot">{footer}</div> : null}
    </section>
  );
}

/* --------------------------------------------------------- decorative rule */

/** The brand's slanted divider. Decorative, so it is hidden from assistive tech. */
export function SectionRule() {
  return (
    <div aria-hidden="true" className="rule">
      <span className="rule__long" />
      <span className="rule__short" />
      <span className="rule__line" />
    </div>
  );
}

/* ------------------------------------------------------------------ section */

export function Section({
  id,
  number,
  title,
  note,
  aside,
  children,
  style,
}: {
  readonly id: string;
  readonly number: string;
  readonly title: string;
  readonly note?: ReactNode;
  readonly aside?: ReactNode;
  readonly children: ReactNode;
  readonly style?: React.CSSProperties;
}) {
  return (
    <section aria-labelledby={id} className="sec" style={style}>
      <div className="sec__lede">
        <span className="sec__number num">{number}</span>
        <h2 id={id} className="sec__title">
          {title}
        </h2>
        {note ? <p className="sec__note">{note}</p> : null}
        {aside}
      </div>
      <div className="sec__body">{children}</div>
    </section>
  );
}

/* ----------------------------------------------------------------- mono/raw */

/** A hash or address in monospace. */
export function Mono({
  children,
  breakAll,
  size,
}: {
  readonly children: ReactNode;
  readonly breakAll?: boolean;
  readonly size?: number;
}) {
  return (
    <span
      className="mono"
      style={{
        wordBreak: breakAll ? 'break-all' : undefined,
        fontSize: size ? `${size}px` : undefined,
      }}
    >
      {children}
    </span>
  );
}

/** The raw base-unit line shown under a formatted amount when raw mode is on. */
export function RawValue({ children }: { readonly children: ReactNode }) {
  return (
    <>
      <br />
      <span className="mono facts__raw">{children}</span>
    </>
  );
}

/* ------------------------------------------------------------ page loading */

/**
 * Shown while the app does not yet know whether a wallet (or the recorded
 * demo) is present. Without it every wallet-gated page flashed its "Connect a
 * wallet" prompt on load, even for a visitor who was already connected.
 */
export function PageLoading({ label }: { readonly label: string }) {
  return (
    <section className="page" style={{ padding: '96px var(--page-gutter)' }} aria-busy="true">
      <p className="eyebrow">{label}</p>
      <div className="skeleton" style={{ marginTop: 24, width: 'min(520px, 80%)', height: 44 }} />
      <div className="skeleton" style={{ marginTop: 16, width: 'min(380px, 60%)', height: 20 }} />
      <span className="visually-hidden">Loading</span>
    </section>
  );
}
