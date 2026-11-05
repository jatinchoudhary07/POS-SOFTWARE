import { Loader2, type LucideIcon } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cx } from '../../lib/cx';

type Variant = 'primary' | 'success' | 'secondary' | 'plain' | 'danger';
type Size = 'sm' | 'md' | 'lg';

const variants: Record<Variant, string> = {
  primary:
    'bg-accent text-white shadow-control hover:bg-accent-hover disabled:bg-fill-strong disabled:text-ink-2 disabled:shadow-none',
  success:
    'bg-success text-white shadow-control hover:bg-success-hover disabled:bg-fill-strong disabled:text-ink-2 disabled:shadow-none',
  secondary: 'bg-surface text-ink shadow-control hover:bg-subtle disabled:text-ink-3',
  plain: 'text-ink-2 hover:bg-fill hover:text-ink disabled:text-ink-3 disabled:hover:bg-transparent',
  danger: 'text-danger hover:bg-danger-tint disabled:text-ink-3 disabled:hover:bg-transparent',
};

const sizes: Record<Size, string> = {
  sm: 'h-9 shrink-0 gap-1.5 px-3 text-[13px] whitespace-nowrap',
  md: 'h-11 shrink-0 gap-2 px-4 text-sm whitespace-nowrap',
  // Large buttons may wrap to two lines in narrow panels instead of overflowing.
  lg: 'h-14 gap-2.5 px-6 text-center text-base leading-tight',
};

// Shared by every pressable control: quick colour change + a tiny press-in.
export const pressable =
  'transition-[background-color,color,box-shadow,transform] duration-150 ease-out active:scale-[0.97] disabled:active:scale-100';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: LucideIcon;
  loading?: boolean;
  children?: ReactNode;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon: Icon,
  loading = false,
  className,
  children,
  type = 'button',
  ...rest
}: ButtonProps) {
  const iconSize = size === 'lg' ? 20 : size === 'md' ? 18 : 16;
  return (
    <button
      type={type}
      className={cx(
        'inline-flex min-w-0 items-center justify-center rounded-control font-semibold',
        pressable,
        variants[variant],
        sizes[size],
        className,
      )}
      {...rest}
    >
      {loading ? (
        <Loader2 size={iconSize} className="animate-spin" aria-hidden />
      ) : (
        Icon && <Icon size={iconSize} strokeWidth={2} aria-hidden />
      )}
      {children}
    </button>
  );
}

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  icon: LucideIcon;
  /** Required: icon-only buttons need an accessible name. */
  'aria-label': string;
  variant?: Variant;
  size?: 'md' | 'lg';
}

export function IconButton({ icon: Icon, variant = 'secondary', size = 'md', className, type = 'button', ...rest }: IconButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        'inline-flex shrink-0 items-center justify-center rounded-control',
        pressable,
        variants[variant],
        size === 'lg' ? 'h-12 w-12' : 'h-11 w-11',
        className,
      )}
      {...rest}
    >
      <Icon size={18} strokeWidth={2.25} aria-hidden />
    </button>
  );
}
