import { motion } from 'framer-motion';
import { BookOpen, Info, Mail, MapPin, Phone } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import PageHeader from '../components/layout/PageHeader';
import Button from '../components/ui/Button';
import Card from '../components/ui/Card';
import { Field } from '../components/ui/Field';
import { useToast } from '../context/ToastContext';

const DETAILS = [
  { icon: Mail, label: 'Email', value: 'hello@hungerheal.example' },
  { icon: Phone, label: 'Phone', value: '+91 80 4000 1200' },
  { icon: MapPin, label: 'Based in', value: 'Bengaluru, India' },
];

const FAQ = [
  {
    q: 'How quickly is a donation matched?',
    a: 'Usually within a couple of seconds of posting, provided a collector is on shift within range. If nobody is nearby, the search widens through progressively larger radii.',
  },
  {
    q: 'What if no collector accepts?',
    a: 'The offer window closes — ninety seconds for cooked food, five minutes for packaged goods — and the donation is scored again, excluding everyone who ignored it the first time.',
  },
  {
    q: 'Can I choose which collector gets my donation?',
    a: 'No, and that is the point of the rebuild. Letting anyone pick by hand reintroduces exactly the delay the scoring engine was built to remove.',
  },
  {
    q: 'Do you need my exact address?',
    a: 'A pin on the map is enough. You can drop it yourself or use your device location, and your phone number is only shared once a collector has accepted.',
  },
];

export default function Contact() {
  const [form, setForm] = useState({ name: '', email: '', subject: '', message: '' });
  const toast = useToast();

  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  function submit(e) {
    e.preventDefault();
    // There is no contact endpoint in this system, and pretending to send the
    // message would be worse than saying so. The form validates and clears;
    // the notice above it is honest about where the message goes.
    toast.info('This demo has no message inbox — please use the email address listed.');
    setForm({ name: '', email: '', subject: '', message: '' });
  }

  return (
    <>
      <PageHeader
        eyebrow="Contact"
        title="Questions, or want to collect in your area?"
        description="Whether you have surplus food regularly, want to go on shift as a collector, or just want to know how the matching works — here is how to reach us."
      />

      <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <div className="grid gap-12 lg:grid-cols-[1fr_1.1fr]">
          {/* ------------------------------------------------------- details */}
          <div>
            <h2 className="text-2xl font-semibold">Get in touch</h2>
            <ul className="mt-8 space-y-6">
              {DETAILS.map(({ icon: Icon, label, value }) => (
                <li key={label} className="flex gap-4">
                  <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-leaf-100 text-leaf-600">
                    <Icon className="size-5" aria-hidden="true" />
                  </span>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-ink-400">
                      {label}
                    </p>
                    <p className="mt-1 text-base font-medium text-ink-800">{value}</p>
                  </div>
                </li>
              ))}
            </ul>

            <Card className="mt-10 border-warm-200 bg-warm-50">
              <div className="flex gap-3">
                <Info className="mt-0.5 size-5 shrink-0 text-warm-600" aria-hidden="true" />
                <p className="text-sm leading-relaxed text-warm-800">
                  HungerHeal is a student project built to demonstrate event-driven
                  microservices. The contact details above are placeholders and the form
                  alongside does not deliver mail anywhere — there is no contact service in the
                  system, and a form that silently discards messages would be worse than one
                  that admits it.
                </p>
              </div>
            </Card>

            <Link
              to="/how-it-works"
              className="mt-8 inline-flex items-center gap-2 text-sm font-semibold text-leaf-700 hover:underline"
            >
              <BookOpen className="size-4" aria-hidden="true" />
              Read how the matching works
            </Link>
          </div>

          {/* ---------------------------------------------------------- form */}
          <motion.div
            initial={{ opacity: 0, y: 18 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.3 }}
            transition={{ duration: 0.45, ease: 'easeOut' }}
          >
            <Card className="p-8">
              <h2 className="text-2xl font-semibold">Send a message</h2>
              <form onSubmit={submit} className="mt-6 space-y-5">
                <Field label="Your name" required>
                  {(props) => (
                    <input
                      {...props}
                      autoComplete="name"
                      value={form.name}
                      onChange={set('name')}
                      required
                    />
                  )}
                </Field>

                <Field label="Email" required>
                  {(props) => (
                    <input
                      {...props}
                      type="email"
                      autoComplete="email"
                      value={form.email}
                      onChange={set('email')}
                      required
                    />
                  )}
                </Field>

                <Field label="Subject">
                  {(props) => (
                    <input
                      {...props}
                      value={form.subject}
                      onChange={set('subject')}
                      placeholder="Collecting in Indiranagar"
                    />
                  )}
                </Field>

                <Field label="Message" required>
                  {(props) => (
                    <textarea
                      {...props}
                      rows={5}
                      value={form.message}
                      onChange={set('message')}
                      placeholder="Tell us what you have in mind."
                      required
                    />
                  )}
                </Field>

                <Button type="submit" size="lg" className="w-full">
                  Send message
                </Button>
              </form>
            </Card>
          </motion.div>
        </div>
      </section>

      {/* ------------------------------------------------------------- faq */}
      <section className="border-t border-cream-200 bg-white py-20 sm:py-24">
        <div className="mx-auto max-w-3xl px-4 sm:px-6">
          <h2 className="text-center text-3xl font-semibold sm:text-4xl">Common questions</h2>

          <div className="mt-12 space-y-3">
            {FAQ.map(({ q, a }) => (
              <details
                key={q}
                className="group rounded-xl2 border border-cream-200 bg-cream-50 px-6 py-5 [&_summary::-webkit-details-marker]:hidden"
              >
                <summary className="flex cursor-pointer items-center justify-between gap-4 text-base font-semibold text-ink-800">
                  {q}
                  <span
                    className="shrink-0 text-xl leading-none text-leaf-600 transition-transform group-open:rotate-45"
                    aria-hidden="true"
                  >
                    +
                  </span>
                </summary>
                <p className="mt-3 text-sm leading-relaxed text-ink-500">{a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>
    </>
  );
}
