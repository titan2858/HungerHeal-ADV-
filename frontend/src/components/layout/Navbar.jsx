import { AnimatePresence, motion } from 'framer-motion';
import { Leaf, LogOut, Menu, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import Button from '../ui/Button';

const PUBLIC_LINKS = [
  { to: '/', label: 'Home', end: true },
  { to: '/about', label: 'About' },
  { to: '/how-it-works', label: 'How it works' },
  { to: '/partners', label: 'Who receives it' },
  { to: '/contact', label: 'Contact' },
];

export default function Navbar() {
  const { user, isAuthenticated, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();

  // Close the mobile menu whenever the route changes, otherwise it stays open
  // over the page you just navigated to.
  useEffect(() => setOpen(false), [location.pathname]);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const handleSignOut = () => {
    signOut();
    navigate('/');
  };

  const linkClass = ({ isActive }) =>
    [
      'relative px-1 py-2 text-sm font-medium transition-colors',
      isActive ? 'text-leaf-700' : 'text-ink-500 hover:text-ink-900',
    ].join(' ');

  return (
    <header
      className={[
        'sticky top-0 z-40 border-b transition-colors duration-200',
        scrolled
          ? 'border-cream-200 bg-cream-50/90 backdrop-blur-md'
          : 'border-transparent bg-cream-50',
      ].join(' ')}
    >
      {/* A keyboard user should be able to jump past the nav on every page. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-full focus:bg-leaf-600 focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-white"
      >
        Skip to content
      </a>

      <nav className="mx-auto flex max-w-6xl items-center justify-between gap-6 px-4 py-4 sm:px-6">
        <Link to="/" className="flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-xl bg-leaf-600 text-white">
            <Leaf className="size-5" aria-hidden="true" />
          </span>
          <span className="font-display text-xl font-semibold text-ink-900">HungerHeal</span>
        </Link>

        <div className="hidden items-center gap-7 lg:flex">
          {PUBLIC_LINKS.map((link) => (
            <NavLink key={link.to} to={link.to} end={link.end} className={linkClass}>
              {({ isActive }) => (
                <>
                  {link.label}
                  {isActive && (
                    <motion.span
                      layoutId="nav-underline"
                      className="absolute inset-x-0 -bottom-0.5 h-0.5 rounded-full bg-leaf-500"
                    />
                  )}
                </>
              )}
            </NavLink>
          ))}
        </div>

        <div className="hidden items-center gap-3 lg:flex">
          {isAuthenticated ? (
            <>
              <Button to="/dashboard" variant="outline" size="sm">
                {user.name?.split(' ')[0] ?? 'Dashboard'}
              </Button>
              <Button variant="ghost" size="sm" onClick={handleSignOut}>
                <LogOut className="size-4" aria-hidden="true" />
                Log out
              </Button>
            </>
          ) : (
            <>
              <Button to="/login" variant="ghost" size="sm">
                Log in
              </Button>
              <Button to="/signup" size="sm">
                Get started
              </Button>
            </>
          )}
        </div>

        <button
          type="button"
          className="rounded-lg p-2 text-ink-600 transition hover:bg-cream-200 lg:hidden"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? 'Close menu' : 'Open menu'}
        >
          {open ? <X className="size-6" /> : <Menu className="size-6" />}
        </button>
      </nav>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: 'easeOut' }}
            className="overflow-hidden border-t border-cream-200 bg-cream-50 lg:hidden"
          >
            <div className="space-y-1 px-4 py-4 sm:px-6">
              {PUBLIC_LINKS.map((link) => (
                <NavLink
                  key={link.to}
                  to={link.to}
                  end={link.end}
                  className={({ isActive }) =>
                    [
                      'block rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
                      isActive ? 'bg-leaf-100 text-leaf-700' : 'text-ink-600 hover:bg-cream-200',
                    ].join(' ')
                  }
                >
                  {link.label}
                </NavLink>
              ))}

              <div className="flex flex-col gap-2 border-t border-cream-200 pt-4">
                {isAuthenticated ? (
                  <>
                    <Button to="/dashboard" variant="outline" size="sm">
                      Go to dashboard
                    </Button>
                    <Button variant="ghost" size="sm" onClick={handleSignOut}>
                      Log out
                    </Button>
                  </>
                ) : (
                  <>
                    <Button to="/login" variant="outline" size="sm">
                      Log in
                    </Button>
                    <Button to="/signup" size="sm">
                      Get started
                    </Button>
                  </>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}
