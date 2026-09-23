import { motion } from 'framer-motion';
import { Bell, ClipboardList, MapPin, Radar, Timer, Truck } from 'lucide-react';
import PageHeader from '../components/layout/PageHeader';
import SectionHeading from '../components/ui/SectionHeading';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';

// The published weights. Shown rather than described, because "we consider
// several factors" is what every opaque system says.
const FACTORS = [
  {
    name: 'Distance',
    weight: 0.35,
    body: 'How far the collector is from the pickup, as a straight line falling off to zero at the edge of the search radius.',
    why: 'It decides whether food arrives while it is still worth eating. The largest single factor — and still only a third of the decision.',
  },
  {
    name: 'Category fit',
    weight: 0.25,
    body: 'Whether their equipment suits this kind of food, from a compatibility matrix.',
    why: 'A close collector who cannot keep food at temperature delivers something nobody can serve.',
  },
  {
    name: 'Current load',
    weight: 0.2,
    body: 'How many pickups they are already committed to, as 1 / (1 + pending).',
    why: 'Without it, donations stack onto whoever is nearest until they are overwhelmed and everyone else is idle.',
  },
  {
    name: 'Rating',
    weight: 0.15,
    body: 'Their track record, out of five.',
    why: 'Smallest on purpose: it is the least direct evidence about this pickup, and over-weighting it would starve new collectors of the work they need to build a record.',
  },
];

const STAGES = [
  {
    icon: ClipboardList,
    title: 'The donation is recorded',
    body: 'Saved first, published second. If the event log is unavailable at that moment, the donation is still accepted and a sweeper publishes it when the log comes back — the donor is never told to try again.',
  },
  {
    icon: Radar,
    title: 'Candidates are found',
    body: 'A geospatial query returns collectors on shift within the radius. Anyone who cannot handle the category, or is unavailable, is excluded before scoring rather than merely penalised.',
  },
  {
    icon: MapPin,
    title: 'Everyone left is scored',
    body: 'Four factors, each normalised to a 0–1 scale before its weight is applied, so a count and a distance in kilometres cannot drown each other out.',
  },
  {
    icon: Bell,
    title: 'The top three are offered it at once',
    body: 'In parallel, not one after another. Waiting out each refusal in turn would spend the food’s remaining life on politeness.',
  },
  {
    icon: Timer,
    title: 'A clock runs',
    body: 'Ninety seconds for cooked food, five minutes for tinned goods. The urgency of the food sets the deadline, not the ranking.',
  },
  {
    icon: Truck,
    title: 'First acceptance wins',
    body: 'Three collectors can tap accept in the same second; exactly one wins the lock. If nobody answers, the donation is scored again over a wider radius, excluding whoever just ignored it.',
  },
];

export default function HowItWorks() {
  return (
    <>
      <PageHeader
        eyebrow="How it works"
        title="The matching, with the numbers shown"
        description="Four weighted factors decide who is asked to collect a donation. Here they are, including why each one weighs what it does."
      >
        <Button to="/signup" size="lg">
          Try it yourself
        </Button>
      </PageHeader>

      {/* ----------------------------------------------------- the factors */}
      <section className="mx-auto max-w-5xl px-4 py-20 sm:px-6">
        <SectionHeading
          eyebrow="The score"
          title="Nearest is a third of the answer"
          description="Each term is scaled to 0–1 first, then multiplied by its weight. A perfect candidate scores 0.95."
        />

        <div className="mt-14 space-y-4">
          {FACTORS.map(({ name, weight, body, why }, i) => (
            <motion.div
              key={name}
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.3 }}
              transition={{ duration: 0.4, delay: i * 0.07, ease: 'easeOut' }}
              className="rounded-xl2 border border-cream-200 bg-white p-6 shadow-soft"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <h3 className="text-xl font-semibold">{name}</h3>
                <span className="font-mono text-sm font-semibold text-leaf-700">
                  × {weight.toFixed(2)}
                </span>
              </div>

              {/* The bar is the weight itself, scaled against the largest one,
                  so the ranking is readable before the numbers are. */}
              <div
                className="mt-3 h-2 overflow-hidden rounded-full bg-cream-200"
                role="img"
                aria-label={`${name} carries a weight of ${weight} out of 0.95`}
              >
                <motion.span
                  initial={{ width: 0 }}
                  whileInView={{ width: `${(weight / 0.35) * 100}%` }}
                  viewport={{ once: true }}
                  transition={{ duration: 0.7, delay: 0.15, ease: 'easeOut' }}
                  className="block h-full rounded-full bg-leaf-500"
                />
              </div>

              <p className="mt-4 text-sm leading-relaxed text-ink-600">{body}</p>
              <p className="mt-2 text-sm leading-relaxed text-ink-400">
                <span className="font-semibold text-ink-500">Why: </span>
                {why}
              </p>
            </motion.div>
          ))}
        </div>

        <Card className="mt-8 border-warm-200 bg-warm-50">
          <h3 className="text-base font-semibold text-warm-900">
            Why the weights add up to 0.95
          </h3>
          <p className="mt-2 text-sm leading-relaxed text-warm-800">
            0.35 + 0.25 + 0.20 + 0.15 = 0.95, not 1.0. These are the values the design specified,
            and they are kept rather than quietly rescaled — every candidate is scaled by the same
            constant, so no ranking changes. It only matters when a person reads a score, which is
            why scores are always shown as <span className="font-mono">/ 0.95</span>.
          </p>
        </Card>
      </section>

      {/* --------------------------------------------------- specialisation */}
      <section className="border-y border-cream-200 bg-white py-20 sm:py-24">
        <div className="mx-auto max-w-5xl px-4 sm:px-6">
          <SectionHeading
            eyebrow="Category fit"
            title="The rule that looks backwards"
            description="A collector with an insulated box scores lower on dry goods than one without. That is on purpose."
          />

          <div className="mt-12 overflow-x-auto">
            <table className="w-full min-w-[34rem] border-separate border-spacing-0 text-sm">
              <caption className="sr-only">
                Compatibility scores by collector equipment and food category
              </caption>
              <thead>
                <tr>
                  <th scope="col" className="rounded-tl-xl bg-cream-100 p-3 text-left font-semibold">
                    Equipment
                  </th>
                  {['Cooked', 'Perishable', 'Bakery', 'Packaged'].map((c, i) => (
                    <th
                      key={c}
                      scope="col"
                      className={`bg-cream-100 p-3 text-center font-semibold ${i === 3 ? 'rounded-tr-xl' : ''}`}
                    >
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[
                  ['Insulated + refrigerated', '1.00', '1.00', '0.70', '0.55'],
                  ['Insulated only', '1.00', '0.75', '0.75', '0.60'],
                  ['Neither', '0.40', '0.45', '1.00', '1.00'],
                ].map(([label, ...values]) => (
                  <tr key={label}>
                    <th scope="row" className="border-b border-cream-200 p-3 text-left font-medium">
                      {label}
                    </th>
                    {values.map((v, i) => (
                      <td
                        key={i}
                        className="border-b border-cream-200 p-3 text-center font-mono text-ink-600"
                      >
                        {v}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-8 grid gap-6 md:grid-cols-2">
            <Card>
              <h3 className="text-base font-semibold">Specialists stay available</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-500">
                If equipped collectors won everything, the one hot meal that genuinely needs an
                insulated box would find them all busy carrying tins.
              </p>
            </Card>
            <Card>
              <h3 className="text-base font-semibold">Nothing scores zero</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-500">
                A zero would make every candidate score zero in an area with no equipped
                collectors, and the ranking would collapse into noise. The floor is 0.35.
              </p>
            </Card>
          </div>
        </div>
      </section>

      {/* ------------------------------------------------------- the stages */}
      <section className="mx-auto max-w-5xl px-4 py-20 sm:px-6">
        <SectionHeading
          eyebrow="End to end"
          title="What happens after you press post"
          description="Six stages, none of which involve a person deciding anything."
        />

        <ol className="mt-14 grid gap-6 sm:grid-cols-2">
          {STAGES.map(({ icon: Icon, title, body }, i) => (
            <motion.li
              key={title}
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.3 }}
              transition={{ duration: 0.4, delay: i * 0.06, ease: 'easeOut' }}
              className="rounded-xl2 border border-cream-200 bg-white p-6 shadow-soft"
            >
              <div className="flex items-center gap-3">
                <span className="flex size-10 items-center justify-center rounded-xl bg-leaf-100 text-leaf-600">
                  <Icon className="size-5" aria-hidden="true" />
                </span>
                <span className="font-mono text-xs font-bold text-ink-400">
                  {String(i + 1).padStart(2, '0')}
                </span>
              </div>
              <h3 className="mt-4 text-lg font-semibold">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-500">{body}</p>
            </motion.li>
          ))}
        </ol>

        <div className="mt-14 text-center">
          <Button to="/signup" size="lg">
            Post your first donation
          </Button>
        </div>
      </section>
    </>
  );
}
