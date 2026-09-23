import { motion } from 'framer-motion';
import { Bike, Building2, Info, Snowflake, ThermometerSun, UtensilsCrossed } from 'lucide-react';
import PageHeader from '../components/layout/PageHeader';
import SectionHeading from '../components/ui/SectionHeading';
import Card from '../components/ui/Card';
import Button from '../components/ui/Button';
import { IMAGES } from '../lib/images';

// NOTE ON HONESTY
// ---------------
// The design brief asked for a directory of partner NGOs. There is no
// organisation model anywhere in this system - donations are matched to
// individual collection agents, and no partner has been onboarded. A grid of
// invented charity names with invented meal counts would be the single most
// misleading thing on the site, so this page explains the real chain instead
// and says plainly where the gap is.

const CHAIN = [
  {
    icon: UtensilsCrossed,
    title: 'A donor with surplus',
    body: 'A restaurant closing for the night, a canteen with trays left over, a wedding that catered for forty more than turned up.',
  },
  {
    icon: Bike,
    title: 'A collection agent nearby',
    body: 'A volunteer or rider on shift, matched automatically on distance, equipment, current workload and track record.',
  },
  {
    icon: Building2,
    title: 'A community kitchen or shelter',
    body: 'Where the agent takes it. The platform routes the pickup; the agent knows the drop-off in their own area.',
  },
];

const CAPABILITIES = [
  {
    icon: ThermometerSun,
    title: 'Insulated transport',
    body: 'A hot box or thermal bag. Required before a collector is eligible for cooked food at all.',
  },
  {
    icon: Snowflake,
    title: 'Refrigeration',
    body: 'Preferred for dairy and fresh produce, and scored as a better fit for perishable raw items.',
  },
  {
    icon: Bike,
    title: 'Vehicle',
    body: 'Recorded at sign-up. Captured but not yet scored — a capacity model would be needed, and inventing thresholds would be worse than the gap.',
  },
];

export default function Partners() {
  return (
    <>
      <PageHeader
        eyebrow="Who receives it"
        title="Where a donation actually goes"
        description="HungerHeal matches donations to individual collection agents, who take them on to the kitchens and shelters they serve. Here is the full chain, and the part of it the platform does not yet cover."
      />

      {/* --------------------------------------------------------- the chain */}
      <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <SectionHeading
          eyebrow="The chain"
          title="Three links, one of them automated"
          description="The middle link is the one this platform replaced. The other two are people."
        />

        <div className="mt-14 grid gap-6 md:grid-cols-3">
          {CHAIN.map(({ icon: Icon, title, body }, i) => (
            <motion.div
              key={title}
              initial={{ opacity: 0, y: 18 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.3 }}
              transition={{ duration: 0.4, delay: i * 0.08, ease: 'easeOut' }}
              className="relative rounded-xl2 border border-cream-200 bg-white p-6 shadow-soft"
            >
              <span className="flex size-11 items-center justify-center rounded-xl bg-leaf-100 text-leaf-600">
                <Icon className="size-5" aria-hidden="true" />
              </span>
              <h3 className="mt-5 text-lg font-semibold">{title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-500">{body}</p>
            </motion.div>
          ))}
        </div>

        {/* The gap, stated where someone looking for a partner list will read it. */}
        <Card className="mt-10 border-warm-200 bg-warm-50">
          <div className="flex gap-4">
            <Info className="mt-0.5 size-5 shrink-0 text-warm-600" aria-hidden="true" />
            <div>
              <h3 className="text-base font-semibold text-warm-900">
                There is no partner directory yet — and this page will not invent one
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-warm-800">
                HungerHeal currently models donors and collection agents. Receiving organisations
                are not registered on the platform, so there is no list of partner NGOs to show
                and no count of meals delivered to them. A grid of plausible-looking charity
                names would be easy to add and completely untrue, so this page describes the real
                chain instead. Registering receiving organisations, and tracking the drop-off as
                a fourth status, is the natural next step for the system.
              </p>
            </div>
          </div>
        </Card>
      </section>

      {/* -------------------------------------------------- what agents carry */}
      <section className="border-y border-cream-200 bg-white py-20 sm:py-24">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="grid gap-12 lg:grid-cols-[1.1fr_1fr] lg:items-center">
            <div>
              <SectionHeading
                align="left"
                eyebrow="Collection agents"
                title="What a collector declares"
                description="Equipment is recorded at sign-up because the matching engine reads it from the very first donation. It is not profile decoration."
              />

              <div className="mt-8 space-y-5">
                {CAPABILITIES.map(({ icon: Icon, title, body }, i) => (
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

            <motion.img
              initial={{ opacity: 0, scale: 1.03 }}
              whileInView={{ opacity: 1, scale: 1 }}
              viewport={{ once: true, amount: 0.3 }}
              transition={{ duration: 0.6, ease: 'easeOut' }}
              src={IMAGES.produce.src}
              alt={IMAGES.produce.alt}
              className="aspect-4/5 w-full rounded-xl3 object-cover shadow-lift"
            />
          </div>
        </div>
      </section>

      {/* -------------------------------------------------------------- cta */}
      <section className="mx-auto max-w-3xl px-4 py-20 text-center sm:px-6">
        <h2 className="text-3xl font-semibold sm:text-4xl">Collect food in your area</h2>
        <p className="mt-4 text-ink-500">
          If you can carry a box and know a kitchen that needs it, that is the whole
          qualification. You choose your shift and your categories.
        </p>
        <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
          <Button to="/signup" size="lg">
            Become a collector
          </Button>
          <Button to="/contact" variant="outline" size="lg">
            Talk to us first
          </Button>
        </div>
      </section>
    </>
  );
}
