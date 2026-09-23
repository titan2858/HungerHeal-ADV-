import { motion } from 'framer-motion';
import { Eye, Gauge, HeartHandshake, ShieldCheck, Sprout, Users } from 'lucide-react';
import PageHeader from '../components/layout/PageHeader';
import SectionHeading from '../components/ui/SectionHeading';
import Button from '../components/ui/Button';
import { IMAGES } from '../lib/images';

const VALUES = [
  {
    icon: Gauge,
    title: 'Speed over ceremony',
    body: 'Every extra approval step is time a hot meal spends getting colder. If a step can be automated safely, it should be.',
  },
  {
    icon: Eye,
    title: 'Explain the decision',
    body: 'An automated choice that cannot be questioned is worse than a human one. Every match keeps the full score for every candidate, winners and losers alike.',
  },
  {
    icon: ShieldCheck,
    title: 'Dignity, not spectacle',
    body: 'No photographs of people in need, no counting strangers as impact statistics. The people receiving food are not the product.',
  },
  {
    icon: Users,
    title: 'Spread the work',
    body: 'Current workload is part of the score, so the most convenient volunteer does not quietly become the only one.',
  },
  {
    icon: Sprout,
    title: 'Waste is the first target',
    body: 'Food already cooked and already paid for is the cheapest meal in the system. Getting it moved is worth more than producing more.',
  },
  {
    icon: HeartHandshake,
    title: 'Honest numbers or none',
    body: 'The platform shows what it actually measured. Where there is no real figure, it says so instead of rounding a guess.',
  },
];

export default function Mission() {
  return (
    <>
      <PageHeader
        eyebrow="Mission & values"
        title="Move surplus food while it is still food"
        description="One mission, and six commitments about how it gets pursued — including the ones that cost us a nicer-looking homepage."
      />

      <section className="mx-auto max-w-4xl px-4 py-20 sm:px-6">
        <motion.blockquote
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.4 }}
          transition={{ duration: 0.5, ease: 'easeOut' }}
          className="rounded-xl3 border border-leaf-200 bg-leaf-50 px-8 py-12 text-center"
        >
          <p className="font-display text-2xl font-semibold leading-snug text-leaf-900 sm:text-3xl">
            To close the gap between food that exists and people who need it, fast enough that
            the food is still worth eating — and to be able to explain every decision made on
            the way.
          </p>
        </motion.blockquote>
      </section>

      <section className="border-y border-cream-200 bg-white py-20 sm:py-24">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <SectionHeading
            eyebrow="What we hold to"
            title="Six commitments"
            description="These are not decoration. Each one shows up somewhere concrete in how the system behaves."
          />

          <div className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {VALUES.map(({ icon: Icon, title, body }, i) => (
              <motion.div
                key={title}
                initial={{ opacity: 0, y: 18 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true, amount: 0.3 }}
                transition={{ duration: 0.4, delay: i * 0.06, ease: 'easeOut' }}
                className="rounded-xl2 border border-cream-200 bg-cream-50 p-6"
              >
                <span className="flex size-11 items-center justify-center rounded-xl bg-leaf-100 text-leaf-600">
                  <Icon className="size-5" aria-hidden="true" />
                </span>
                <h3 className="mt-5 text-lg font-semibold">{title}</h3>
                <p className="mt-2 text-sm leading-relaxed text-ink-500">{body}</p>
              </motion.div>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <div className="grid gap-12 lg:grid-cols-2 lg:items-center">
          <div>
            <SectionHeading
              align="left"
              eyebrow="The value with teeth"
              title="Why there is no override button"
              description="The monitoring view shows every scoring decision the engine made. It cannot change any of them, and that is deliberate."
            />
            <div className="mt-6 space-y-4 leading-relaxed text-ink-600">
              <p>
                An override button would be used. The first time a donation looked slow, somebody
                would press it — and the manual assignment this whole rebuild removed would be
                back, now with a dashboard around it.
              </p>
              <p>
                The right response to a bad match is to open the breakdown, find which of the four
                terms produced it, and change the scoring so every future donation benefits. Fixing
                one case by hand fixes exactly one case.
              </p>
            </div>
            <Button to="/how-it-works" className="mt-8">
              See the four factors
            </Button>
          </div>

          <motion.img
            initial={{ opacity: 0, scale: 1.03 }}
            whileInView={{ opacity: 1, scale: 1 }}
            viewport={{ once: true, amount: 0.3 }}
            transition={{ duration: 0.6, ease: 'easeOut' }}
            src={IMAGES.crate.src}
            alt={IMAGES.crate.alt}
            className="aspect-4/3 w-full rounded-xl3 object-cover shadow-lift"
          />
        </div>
      </section>
    </>
  );
}
