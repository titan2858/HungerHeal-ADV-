import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import PageHeader from '../components/layout/PageHeader';
import Card from '../components/ui/Card';
import SectionHeading from '../components/ui/SectionHeading';
import Button from '../components/ui/Button';
import { IMAGES } from '../lib/images';

const TIMELINE = [
  {
    label: 'The original',
    title: 'A monolith with a coordinator',
    body: 'One application, one database, and an administrator who read each donation and picked a collector by hand. It worked, at the speed of whoever was on duty.',
  },
  {
    label: 'The problem',
    title: 'The bottleneck was a person',
    body: 'Perishable food is worst served by a queue. The delay was never technical — it was the wait for someone to look.',
  },
  {
    label: 'The rebuild',
    title: 'Services that talk through events',
    body: 'Nine services, each owning its own data, communicating over an event log rather than calling one another. A donation is recorded as a fact; everything downstream reacts to it.',
  },
  {
    label: 'The result',
    title: 'Assignment with nobody in it',
    body: 'A scoring engine ranks nearby collectors on four weighted factors and offers the donation to the top three at once. Every decision keeps its full breakdown.',
  },
];

export default function About() {
  return (
    <>
      <PageHeader
        eyebrow="About HungerHeal"
        title="Built to remove one specific delay"
        description="HungerHeal is a rebuild of a food-donation platform with a single goal: take the human out of the assignment step, and be able to explain every decision that replaced them."
      />

      <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <div className="grid gap-12 lg:grid-cols-[1fr_1.15fr] lg:items-center">
          <motion.img
            initial={{ opacity: 0, scale: 1.03 }}
            whileInView={{ opacity: 1, scale: 1 }}
            viewport={{ once: true, amount: 0.3 }}
            transition={{ duration: 0.6, ease: 'easeOut' }}
            src={IMAGES.kitchen.src}
            alt={IMAGES.kitchen.alt}
            className="aspect-4/5 w-full rounded-xl3 object-cover shadow-lift"
          />

          <div>
            <SectionHeading
              align="left"
              eyebrow="The story"
              title="Good intentions, stuck behind a screen"
              description="Surplus food is rarely the hard part. The hard part is that it is surplus for a few hours, and the people who could collect it do not know it exists."
            />
            <div className="mt-6 space-y-4 text-base leading-relaxed text-ink-600">
              <p>
                The earlier version of this platform had everything a donation needed — a form,
                a map, a list of volunteers — and one step that undid the rest. An administrator
                opened each donation and chose who should collect it.
              </p>
              <p>
                That decision is not hard for a person to make. It is just impossible for a
                person to make quickly, every time, at three in the afternoon and at eleven at
                night, without ever being the reason forty portions of biryani went in a bin.
              </p>
              <p>
                So the rebuild changed one thing deliberately, and rearranged everything else to
                support it: the assignment is made by a scoring engine, and the reasoning is kept
                so a human can audit it afterwards rather than make it in the moment.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="border-y border-cream-200 bg-white py-20 sm:py-24">
        <div className="mx-auto max-w-4xl px-4 sm:px-6">
          <SectionHeading
            eyebrow="How it got here"
            title="From one application to nine services"
          />

          <ol className="mt-14 space-y-8 border-l-2 border-cream-200 pl-8">
            {TIMELINE.map(({ label, title, body }, i) => (
              <motion.li
                key={title}
                initial={{ opacity: 0, x: -14 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true, amount: 0.4 }}
                transition={{ duration: 0.4, delay: i * 0.08, ease: 'easeOut' }}
                className="relative"
              >
                <span className="absolute -left-[2.6rem] top-1 flex size-4 items-center justify-center rounded-full border-4 border-white bg-leaf-500" />
                <p className="text-xs font-semibold uppercase tracking-wider text-leaf-600">
                  {label}
                </p>
                <h3 className="mt-1.5 text-xl font-semibold">{title}</h3>
                <p className="mt-2 leading-relaxed text-ink-500">{body}</p>
              </motion.li>
            ))}
          </ol>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <SectionHeading
          eyebrow="Honest about it"
          title="What this is, and what it is not"
          description="It is a working system, not a deployed charity. Saying so plainly is more useful than a number nobody can check."
        />

        <div className="mt-12 grid gap-6 md:grid-cols-2">
          <Card>
            <h3 className="text-lg font-semibold">What is real</h3>
            <ul className="mt-4 space-y-2.5 text-sm leading-relaxed text-ink-600">
              <li>The matching engine, its scoring, and the timeout and re-offer loop.</li>
              <li>Live agent locations, geospatial search, and the accept race.</li>
              <li>Donation tracking, notifications, and a read-only audit of every decision.</li>
              <li>242 unit tests and 333 end-to-end checks against the running stack.</li>
            </ul>
          </Card>

          <Card>
            <h3 className="text-lg font-semibold">What is not claimed</h3>
            <ul className="mt-4 space-y-2.5 text-sm leading-relaxed text-ink-600">
              <li>
                No totals of meals rescued are shown here. The system has served test data, and
                inventing a figure would be the easiest lie on the page.
              </li>
              <li>Notifications are in-app only — no SMS, push or email is delivered.</li>
              <li>
                The scoring weights are reasoned heuristics, not learned from outcomes. The data
                to fit them is only now being collected.
              </li>
              <li>Distance is straight-line, not travel time.</li>
            </ul>
          </Card>
        </div>

        <div className="mt-12 text-center">
          <Button to="/how-it-works" size="lg">
            Read how the matching works
          </Button>
          <p className="mt-4 text-sm text-ink-400">
            Or see{' '}
            <Link to="/mission" className="font-semibold text-leaf-700 hover:underline">
              the values behind it
            </Link>
            .
          </p>
        </div>
      </section>
    </>
  );
}
