import { useId } from 'react';

// A label that is actually associated with its input, an error that is actually
// announced. Doing this once here is what keeps it consistent across six forms.
export function Field({ label, hint, error, required, children }) {
  const id = useId();
  const describedBy = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean).join(' ');

  return (
    <div>
      <label htmlFor={id} className="block text-sm font-semibold text-ink-700">
        {label}
        {required && <span className="ml-1 text-red-500">*</span>}
      </label>
      {hint && (
        <p id={`${id}-hint`} className="mt-1 text-xs text-ink-400">
          {hint}
        </p>
      )}
      <div className="mt-2">
        {children({
          id,
          'aria-invalid': error ? 'true' : undefined,
          'aria-describedby': describedBy || undefined,
          className: inputClasses(error),
        })}
      </div>
      {error && (
        <p id={`${id}-error`} className="mt-1.5 text-xs font-medium text-red-600">
          {error}
        </p>
      )}
    </div>
  );
}

export function inputClasses(error) {
  return [
    'w-full rounded-xl border bg-white px-4 py-2.5 text-sm text-ink-800',
    'placeholder:text-ink-400 transition-colors',
    error
      ? 'border-red-300 focus:border-red-500'
      : 'border-cream-300 focus:border-leaf-500',
  ].join(' ');
}
