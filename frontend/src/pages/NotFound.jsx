import { motion } from 'framer-motion';
import { Compass } from 'lucide-react';
import Button from '../components/ui/Button';

export default function NotFound() {
  return (
    <section className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center px-4 py-20 text-center sm:px-6">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: 'easeOut' }}
      >
        <span className="mx-auto flex size-16 items-center justify-center rounded-full bg-leaf-100 text-leaf-600">
          <Compass className="size-7" aria-hidden="true" />
        </span>
        <p className="mt-6 font-mono text-sm font-semibold text-ink-400">404</p>
        <h1 className="mt-2 text-3xl font-semibold sm:text-4xl">This page is not on the map</h1>
        <p className="mt-4 text-ink-500">
          The link may be out of date, or the page may have moved. Everything else is still
          where you left it.
        </p>
        <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
          <Button to="/" size="lg">
            Back to the homepage
          </Button>
          <Button to="/how-it-works" variant="outline" size="lg">
            How it works
          </Button>
        </div>
      </motion.div>
    </section>
  );
}
