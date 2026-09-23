import Button from './Button';

// Every empty list in the app routes through this, so "nothing here" always
// explains itself and offers the next step instead of leaving a blank panel.
export default function EmptyState({ icon: Icon, title, description, action, className = '' }) {
  return (
    <div
      className={`flex flex-col items-center rounded-xl2 border border-dashed border-cream-300 bg-cream-50 px-6 py-14 text-center ${className}`}
    >
      {Icon && (
        <span className="mb-4 flex size-14 items-center justify-center rounded-full bg-white text-leaf-500 shadow-soft">
          <Icon className="size-6" aria-hidden="true" />
        </span>
      )}
      <h3 className="text-lg font-semibold">{title}</h3>
      {description && <p className="mt-2 max-w-sm text-sm text-ink-500">{description}</p>}
      {action && (
        <Button to={action.to} onClick={action.onClick} size="sm" className="mt-6">
          {action.label}
        </Button>
      )}
    </div>
  );
}
