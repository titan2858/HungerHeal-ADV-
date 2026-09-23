// Skeletons rather than a spinner: they hold the layout still, so the page does
// not jump when the data lands.
export function SkeletonCard() {
  return (
    <div className="rounded-xl2 border border-cream-200 bg-white p-6 shadow-soft">
      <div className="skeleton h-4 w-1/3" />
      <div className="skeleton mt-4 h-6 w-3/4" />
      <div className="skeleton mt-3 h-4 w-full" />
      <div className="skeleton mt-2 h-4 w-5/6" />
    </div>
  );
}

export default function LoadingState({ count = 3, label = 'Loading' }) {
  return (
    <div className="grid gap-4" role="status" aria-label={label}>
      {Array.from({ length: count }, (_, i) => (
        <SkeletonCard key={i} />
      ))}
      <span className="sr-only">{label}</span>
    </div>
  );
}
