import { motion } from 'framer-motion';
import { Leaf } from 'lucide-react';
import { Link } from 'react-router-dom';
import { IMAGES } from '../../lib/images';

// A split layout shared by log in and sign up: the form on the left, a
// photograph on the right. The image is hidden below lg rather than shrunk -
// on a phone it would only push the form below the fold.
export default function AuthShell({ title, subtitle, image = IMAGES.connection, footer, children }) {
  return (
    <div className="mx-auto grid min-h-[calc(100vh-4.5rem)] max-w-6xl gap-12 px-4 py-12 sm:px-6 lg:grid-cols-2 lg:items-center">
      <motion.div
        initial={{ opacity: 0, y: 18 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: 'easeOut' }}
        className="mx-auto w-full max-w-md"
      >
        <Link to="/" className="mb-8 inline-flex items-center gap-2.5 lg:hidden">
          <span className="flex size-9 items-center justify-center rounded-xl bg-leaf-600 text-white">
            <Leaf className="size-5" aria-hidden="true" />
          </span>
          <span className="font-display text-xl font-semibold">HungerHeal</span>
        </Link>

        <h1 className="text-3xl font-semibold sm:text-4xl">{title}</h1>
        <p className="mt-3 text-ink-500">{subtitle}</p>

        <div className="mt-8">{children}</div>

        {footer && <div className="mt-6 text-sm text-ink-500">{footer}</div>}
      </motion.div>

      <div className="relative hidden lg:block">
        <motion.img
          initial={{ opacity: 0, scale: 1.03 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.7, ease: 'easeOut' }}
          src={image.src}
          alt={image.alt}
          className="aspect-4/5 w-full rounded-xl3 object-cover shadow-lift"
        />
        <div className="absolute inset-x-6 bottom-6 rounded-xl2 bg-white/90 p-5 backdrop-blur">
          <p className="font-display text-lg font-semibold text-ink-900">
            No one waits on an admin.
          </p>
          <p className="mt-1 text-sm text-ink-500">
            Every donation is matched to a nearby collector automatically, usually within
            seconds of being posted.
          </p>
        </div>
      </div>
    </div>
  );
}
