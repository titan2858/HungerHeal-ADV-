import { AlertTriangle } from 'lucide-react';
import Button from './Button';

// Shows the traceId when the API gives one. It is the id that follows the
// request through every service's logs, so quoting it turns "it broke" into
// something diagnosable.
export default function ErrorState({ error, onRetry, className = '' }) {
  const message = error?.message ?? 'Something went wrong.';
  const traceId = error?.traceId;

  return (
    <div
      className={`rounded-xl2 border border-red-200 bg-red-50 px-6 py-8 text-center ${className}`}
      role="alert"
    >
      <AlertTriangle className="mx-auto size-7 text-red-500" aria-hidden="true" />
      <p className="mt-3 font-semibold text-red-800">{message}</p>
      {traceId && <p className="mt-1 font-mono text-xs text-red-500">trace {traceId}</p>}
      {onRetry && (
        <Button variant="outline" size="sm" onClick={onRetry} className="mt-5">
          Try again
        </Button>
      )}
    </div>
  );
}
