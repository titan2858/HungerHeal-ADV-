import { motion } from 'framer-motion';
import {
  ArrowRight,
  Clock,
  HandHeart,
  MapPin,
  PackageCheck,
  Scale,
  Sparkles,
  Truck,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import SectionHeading from '../components/ui/SectionHeading';
import { useAuth } from '../context/AuthContext';
import { IMAGES } from '../lib/images';

const STEPS = [
  {
    icon: HandHeart,
    title: 'Post what you have',
    body: 'A photo, a category, a quantity and a pin on the map. Under a minute from a phone.',
  },
  {
    icon: MapPin,
    title: 'The engine finds collectors',
    body: 'A geospatial search returns everyone on shift nearby, and scores them on distance, equipment, current load and track record.',
  },
  {
    icon: Truck,
    title: 'The top three are asked at once',
    body: 'Whoever accepts first gets it. Nobody ignored answers, and the donation is re-offered to others.',
  },
  {
    icon: PackageCheck,
    title: 'Collected, and you can see it',
    body: 'Status moves in front of you, with the collector’s number once they are on the way.',
  },
];

const PRINCIPLES = [
  {
    icon: Clock,
    title: 'Speed is the whole point',
    body: 'Cooked food gets a 90-second response window; tinned goods get five minutes. Urgency sets the clock, not the ranking.',
  },
  {
    icon: Scale,
    title: 'Distance is 35%, not 100%',
    body: 'A closer collector without an insulated box loses to a farther one who has it — because food nobody can serve is not a delivery.',
  },
  {
    icon: Sparkles,
    title: 'Work is spread, not stacked',
    body: 'Current load is part of the score, so donations do not all pile onto whoever happens to be nearest.',
  },
];

export default function Home() {
  const { isAuthenticated, isDonor } = useAuth();

  return (
    <>
      {/* ------------------------------------------------------------ hero */}
      <section className="relative overflow-hidden bg-gradient-to-b from-leaf-50 via-cream-50 to-cream-50">
        <div className="mx-auto grid max-w-6xl gap-12 px-4 py-16 sm:px-6 sm:py-24 lg:grid-cols-[1.05fr_1fr] lg:items-center">
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, ease: 'easeOut' }}
          >
            <p className="eyebrow">Food rescue, without the waiting</p>
            <h1 className="mt-5 text-4xl font-semibold leading-[1.1] sm:text-5xl lg:text-6xl">
              Good food should not wait on somebody&nbsp;to&nbsp;notice.
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-ink-500">
              HungerHeal connects surplus food to the nearest collector who can actually carry
              it — automatically, in seconds. No coordinator, no queue, no phone tree.
            </p>

            <div className="mt-9 flex flex-col gap-3 sm:flex-row">
              {isAuthenticated ? (
                <Button to={isDonor ? '/donate' : '/dashboard'} size="lg">
                  {isDonor ? 'Post a donation' : 'Open your dashboard'}
                  <ArrowRight className="size-4" aria-hidden="true" />
                </Button>
              ) : (
                <Button to="/signup" size="lg">
                  Donate food
                  <ArrowRight className="size-4" aria-hidden="true" />
                </Button>
              )}
              <Button to="/how-it-works" variant="outline" size="lg">
                See how it works
              </Button>
            </div>

            <p className="mt-8 text-sm text-ink-400">
              Built as event-driven microservices — the matching decision is explainable, and
              every donation can be traced across the system.
            </p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, scale: 1.04 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: 0.7, ease: 'easeOut' }}
            className="relative"
          >
            <img
              src={IMAGES.hero.src}
              alt={IMAGES.hero.alt}
              className="aspect-4/3 w-full rounded-xl3 object-cover shadow-lift"
            />

            {/* A real score breakdown in shape, so the hero shows the product's
                actual idea rather than a decorative gradient. */}
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.5, delay: 0.35, ease: 'easeOut' }}
              className="absolute -bottom-6 left-4 right-4 rounded-xl2 bg-white/95 p-5 shadow-lift backdrop-blur sm:left-8 sm:right-auto sm:w-72"
            >
              <p className="text-xs font-semibold uppercase tracking-wider text-leaf-600">
                Matched in 1.2s
              </p>
              <p className="mt-2 font-display text-lg font-semibold text-ink-900">
                Ranked #1 for this pickup
              </p>
              <dl className="mt-3 space-y-1.5 text-xs text-ink-500">
                {[
                  ['Distance', '0.99'],
                  ['Category fit', '1.00'],
                  ['Current load', '1.00'],
                ].map(([label, value]) => (
                  <div key={label} className="flex items-center gap-2">
                    <dt className="w-24 shrink-0">{label}</dt>
                    <dd className="h-1.5 flex-1 overflow-hidden rounded-full bg-cream-200">
                      <span
                        className="block h-full rounded-full bg-leaf-500"
                        style={{ width: `${Number(value) * 100}%` }}
                      />
                    </dd>
                    <dd className="w-8 text-right font-mono">{value}</dd>
                  </div>
                ))}
              </dl>
            </motion.div>
          </motion.div>
        </div>
      </section>

      {/* -------------------------------------------------------- the idea */}
      <section className="mx-auto max-w-6xl px-4 pb-20 pt-28 sm:px-6">
        <SectionHeading
          eyebrow="What changed"
          title="The coordinator was the bottleneck"
          description="In the version before this one, an administrator read every donation and decided who should collect it. That works until it is a Sunday evening and forty meals are going cold."
        />

        <div className="mt-12 grid gap-6 md:grid-cols-2">
          <Card className="border-red-100 bg-red-50/40">
            <p className="text-xs font-semibold uppercase tracking-wider text-red-500">Before</p>
            <h3 className="mt-3 text-xl font-semibold">A person in the middle</h3>
            <ul className="mt-4 space-y-2.5 text-sm leading-relaxed text-ink-600">
              <li>Every donation waited for someone to look at a screen.</li>
              <li>Assignment quality depended on who was on duty.</li>
              <li>Nobody could say why a particular collector was chosen.</li>
            </ul>
          </Card>

          <Card className="border-leaf-200 bg-leaf-50/60">
            <p className="text-xs font-semibold uppercase tracking-wider text-leaf-600">Now</p>
            <h3 className="mt-3 text-xl font-semibold">A scoring engine</h3>
            <ul className="mt-4 space-y-2.5 text-sm leading-relaxed text-ink-600">
              <li>Matching starts the moment a donation is posted.</li>
              <li>Four weighted factors, applied the same way every time.</li>
              <li>
                Every decision keeps its full breakdown —{' '}
                <Link to="/how-it-works" className="font-semibold text-leaf-700 hover:underline">
                  including the candidates who lost
                </Link>
                .
              </li>
            </ul>
          </Card>
        </div>
      </section>

      {/* ------------------------------------------------------ how it works */}
      <section className="border-y border-cream-200 bg-white py-20 sm:py-24">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <SectionHeading
            eyebrow="How it works"
            title="Four steps, and you are only in the first one"
            description="Posting is the only thing that needs a human. Everything after it happens on its own."
          />

          <ol className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            {STEPS.map(({ icon: Icon, title, body }, i) => (
              <motion.li
                key={title}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, amount: 0.3 }}
                transition={{ duration: 0.4, delay: i * 0.08, ease: 'easeOut' }}
                className="relative rounded-xl2 border border-cream-200 bg-cream-50 p-6"
              >
                <span className="absolute -top-3 left-6 rounded-full bg-leaf-600 px-2.5 py-0.5 font-mono text-xs font-bold text-white">
                  {i + 1}
                </span>
                <Icon className="size-6 text-leaf-600" aria-hidden="true" />
                <h3 className="mt-4 text-base font-semibold">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-ink-500">{body}</p>
              </motion.li>
            ))}
          </ol>
        </div>
      </section>

      {/* ------------------------------------------------------- principles */}
      <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-24">
        <div className="grid gap-14 lg:grid-cols-[1fr_1.1fr] lg:items-center">
          <motion.div
            initial={{ opacity: 0, x: -20 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true, amount: 0.3 }}
            transition={{ duration: 0.5, ease: 'easeOut' }}
            className="grid gap-4 sm:grid-cols-2"
          >
            <img
              src={IMAGES.produce.src}
              alt={IMAGES.produce.alt}
              className="aspect-3/4 w-full rounded-xl2 object-cover shadow-soft"
            />
            <img
              src={IMAGES.crate.src}
              alt={IMAGES.crate.alt}
              className="aspect-3/4 w-full rounded-xl2 object-cover shadow-soft sm:mt-10"
            />
          </motion.div>

          <div>
            <SectionHeading
              align="left"
              eyebrow="How the matching thinks"
              title="Nearest is not the same as best"
              description="The score is four numbers, each normalised before it is weighted, so no single factor quietly dominates the others."
            />

            <div className="mt-8 space-y-5">
              {PRINCIPLES.map(({ icon: Icon, title, body }, i) => (
                <motion.div
                  key={title}
                  initial={{ opacity: 0, y: 14 }}
                  whileInView={{ opacity: 1, y: 0 }}
                  viewport={{ once: true, amount: 0.4 }}
                  transition={{ duration: 0.4, delay: i * 0.08, ease: 'easeOut' }}
                  className="flex gap-4"
                >
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-warm-100 text-warm-600">
                    <Icon className="size-5" aria-hidden="true" />
                  </span>
                  <div>
                    <h3 className="text-base font-semibold">{title}</h3>
                    <p className="mt-1.5 text-sm leading-relaxed text-ink-500">{body}</p>
                  </div>
                </motion.div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* -------------------------------------------------------- humanity */}
      <section className="relative isolate overflow-hidden">
        <img
          src={IMAGES.connection.src}
          alt=""
          aria-hidden="true"
          className="absolute inset-0 -z-10 size-full object-cover"
        />
        <div className="absolute inset-0 -z-10 bg-leaf-900/75" />

        <div className="mx-auto max-w-3xl px-4 py-24 text-center sm:px-6 sm:py-28">
          <motion.blockquote
            initial={{ opacity: 0, y: 18 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.4 }}
            transition={{ duration: 0.5, ease: 'easeOut' }}
          >
            <p className="font-display text-3xl font-semibold leading-snug text-white sm:text-4xl">
              A meal thrown away and a meal missed are the same meal, separated only by
              someone being told in time.
            </p>
            <footer className="mt-6 text-sm text-leaf-200">
              The reason the assignment step had to stop being manual.
            </footer>
          </motion.blockquote>
        </div>
      </section>

      {/* ------------------------------------------------------------- cta */}
      <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6 sm:py-24">
        <div className="rounded-xl3 border border-cream-200 bg-white px-6 py-14 text-center shadow-soft sm:px-14">
          <h2 className="text-3xl font-semibold sm:text-4xl">Two ways to take part</h2>
          <p className="mx-auto mt-4 max-w-xl text-ink-500">
            Post surplus food when you have it, or go on shift and collect what is posted near
            you. Both take a couple of minutes to set up.
          </p>

          <div className="mt-9 flex flex-col justify-center gap-3 sm:flex-row">
            <Button to={isAuthenticated ? '/dashboard' : '/signup'} size="lg">
              {isAuthenticated ? 'Open your dashboard' : 'Create an account'}
              <ArrowRight className="size-4" aria-hidden="true" />
            </Button>
            <Button to="/partners" variant="outline" size="lg">
              Who receives the food
            </Button>
          </div>
        </div>
      </section>
    </>
  );
}
