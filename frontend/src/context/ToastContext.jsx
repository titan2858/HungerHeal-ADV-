import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle2, Info, XCircle, X } from 'lucide-react';
import { createContext, useCallback, useContext, useMemo, useState } from 'react';

// A small toast system rather than a dependency.
//
// The app needs three kinds of transient message and nothing more; a library
// would add weight for behaviour that is twenty lines here.
const ToastContext = createContext(null);

const TONES = {
  success: { Icon: CheckCircle2, ring: 'ring-leaf-200', icon: 'text-leaf-600' },
  error: { Icon: XCircle, ring: 'ring-red-200', icon: 'text-red-600' },
  info: { Icon: Info, ring: 'ring-warm-200', icon: 'text-warm-600' },
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const dismiss = useCallback((id) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (message, tone = 'info', ms = 4500) => {
      const id = crypto.randomUUID();
      setToasts((current) => [...current, { id, message, tone }]);
      // Errors linger, because they usually need reading twice.
      setTimeout(() => dismiss(id), tone === 'error' ? ms + 2500 : ms);
    },
    [dismiss],
  );

  const value = useMemo(
    () => ({
      toast: push,
      success: (m) => push(m, 'success'),
      error: (m) => push(m, 'error'),
      info: (m) => push(m, 'info'),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}

      {/* aria-live so a screen reader announces these without stealing focus. */}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4 sm:items-end"
        aria-live="polite"
      >
        <AnimatePresence initial={false}>
          {toasts.map(({ id, message, tone }) => {
            const { Icon, ring, icon } = TONES[tone] ?? TONES.info;
            return (
              <motion.div
                key={id}
                initial={{ opacity: 0, y: 12, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 8, scale: 0.97 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
                className={`pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-xl2 bg-white p-4 shadow-lift ring-1 ${ring}`}
              >
                <Icon className={`mt-0.5 size-5 shrink-0 ${icon}`} aria-hidden="true" />
                <p className="flex-1 text-sm text-ink-700">{message}</p>
                <button
                  type="button"
                  onClick={() => dismiss(id)}
                  className="rounded p-0.5 text-ink-400 transition hover:text-ink-700"
                  aria-label="Dismiss notification"
                >
                  <X className="size-4" />
                </button>
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside ToastProvider');
  return ctx;
}
