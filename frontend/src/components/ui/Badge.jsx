// Tone names, not colours. A caller asks for "success", not "green", so the
// palette can change in one place without hunting through every component.
const TONES = {
  neutral: 'bg-cream-200 text-ink-600',
  success: 'bg-leaf-100 text-leaf-700',
  warning: 'bg-warm-100 text-warm-700',
  danger: 'bg-red-100 text-red-700',
  info: 'bg-sky-100 text-sky-700',
};

export default function Badge({ tone = 'neutral', className = '', children }) {
  return (
    <span
      className={[
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold',
        TONES[tone] ?? TONES.neutral,
        className,
      ].join(' ')}
    >
      {children}
    </span>
  );
}
