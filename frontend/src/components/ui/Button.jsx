import { Link } from 'react-router-dom';
import { Loader2 } from 'lucide-react';

// One button, three jobs: <button>, <Link> and <a>. Which element it renders is
// decided by the props, so a "button" that navigates is still a real link and
// keeps middle-click, open-in-new-tab and the right screen-reader role.

const VARIANTS = {
  primary:
    'bg-leaf-600 text-white shadow-soft hover:bg-leaf-700 active:bg-leaf-800 disabled:bg-leaf-300',
  secondary:
    'bg-warm-500 text-white shadow-soft hover:bg-warm-600 active:bg-warm-700 disabled:bg-warm-300',
  outline:
    'border border-leaf-300 bg-white text-leaf-700 hover:border-leaf-500 hover:bg-leaf-50 disabled:text-leaf-300',
  ghost: 'text-ink-600 hover:bg-cream-200 hover:text-ink-900',
  danger: 'bg-red-600 text-white shadow-soft hover:bg-red-700 disabled:bg-red-300',
};

const SIZES = {
  sm: 'px-3.5 py-2 text-sm gap-1.5',
  md: 'px-5 py-2.5 text-sm gap-2',
  lg: 'px-7 py-3.5 text-base gap-2.5',
};

export default function Button({
  as,
  to,
  href,
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled = false,
  className = '',
  children,
  ...rest
}) {
  const classes = [
    'inline-flex items-center justify-center rounded-full font-semibold',
    'transition-colors duration-150 disabled:cursor-not-allowed',
    VARIANTS[variant] ?? VARIANTS.primary,
    SIZES[size] ?? SIZES.md,
    className,
  ].join(' ');

  const content = (
    <>
      {loading && <Loader2 className="size-4 animate-spin" aria-hidden="true" />}
      {children}
    </>
  );

  if (to) {
    return (
      <Link to={to} className={classes} {...rest}>
        {content}
      </Link>
    );
  }

  if (href) {
    return (
      <a href={href} className={classes} {...rest}>
        {content}
      </a>
    );
  }

  const Tag = as ?? 'button';
  return (
    <Tag className={classes} disabled={disabled || loading} {...rest}>
      {content}
    </Tag>
  );
}
