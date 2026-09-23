import { Leaf, Mail, MapPin, Phone } from 'lucide-react';
import { Link } from 'react-router-dom';

const COLUMNS = [
  {
    title: 'The platform',
    links: [
      { to: '/how-it-works', label: 'How it works' },
      { to: '/partners', label: 'Who receives it' },
      { to: '/donate', label: 'Donate food' },
      { to: '/signup', label: 'Become a collector' },
    ],
  },
  {
    title: 'About',
    links: [
      { to: '/about', label: 'Our story' },
      { to: '/mission', label: 'Mission & values' },
      { to: '/contact', label: 'Contact us' },
    ],
  },
];

export default function Footer() {
  return (
    <footer className="mt-24 border-t border-leaf-800 bg-leaf-900 text-leaf-100">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-14 sm:px-6 md:grid-cols-2 lg:grid-cols-4">
        <div className="lg:col-span-2">
          <div className="flex items-center gap-2.5">
            <span className="flex size-9 items-center justify-center rounded-xl bg-leaf-600 text-white">
              <Leaf className="size-5" aria-hidden="true" />
            </span>
            <span className="font-display text-xl font-semibold text-white">HungerHeal</span>
          </div>
          <p className="mt-4 max-w-sm text-sm leading-relaxed text-leaf-200">
            Surplus food, matched to a nearby collection agent automatically — so good food
            reaches people while it is still good.
          </p>
        </div>

        {COLUMNS.map((column) => (
          <div key={column.title}>
            <h3 className="text-sm font-semibold uppercase tracking-wider text-leaf-300">
              {column.title}
            </h3>
            <ul className="mt-4 space-y-2.5">
              {column.links.map((link) => (
                <li key={link.to}>
                  <Link
                    to={link.to}
                    className="text-sm text-leaf-100 transition-colors hover:text-white"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}

        <div className="md:col-span-2 lg:col-span-4">
          <ul className="flex flex-col gap-3 border-t border-leaf-800 pt-8 text-sm text-leaf-200 sm:flex-row sm:gap-8">
            <li className="flex items-center gap-2">
              <Mail className="size-4 shrink-0" aria-hidden="true" />
              hello@hungerheal.example
            </li>
            <li className="flex items-center gap-2">
              <Phone className="size-4 shrink-0" aria-hidden="true" />
              +91 80 4000 1200
            </li>
            <li className="flex items-center gap-2">
              <MapPin className="size-4 shrink-0" aria-hidden="true" />
              Bengaluru, India
            </li>
          </ul>
        </div>
      </div>

      <div className="border-t border-leaf-800">
        <p className="mx-auto max-w-6xl px-4 py-5 text-xs text-leaf-300 sm:px-6">
          HungerHeal — a student project demonstrating event-driven microservices. Contact
          details above are placeholders.
        </p>
      </div>
    </footer>
  );
}
