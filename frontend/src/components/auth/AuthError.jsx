import { AlertCircle } from 'lucide-react';

// The API returns field-level details on a validation failure; showing them
// beats a single "invalid input", which leaves you guessing which field.
export default function AuthError({ error }) {
  if (!error) return null;

  const details = error.details ?? [];

  return (
    <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3" role="alert">
      <p className="flex items-start gap-2 text-sm font-medium text-red-800">
        <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        {error.message}
      </p>
      {details.length > 0 && (
        <ul className="mt-2 space-y-1 pl-6 text-xs text-red-700">
          {details.map((d, i) => (
            <li key={i}>
              <span className="font-semibold">{d.field}</span>: {d.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
