import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { auth } from '../api/client';

// Wraps the existing token storage in api/client.js rather than replacing it.
// The storage contract, the header it sets and the endpoints it calls are all
// untouched - this only gives React a way to re-render when the user changes.
const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => auth.user);

  const signIn = useCallback((token, nextUser) => {
    auth.save(token, nextUser);
    setUser(nextUser);
  }, []);

  const signOut = useCallback(() => {
    auth.clear();
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({
      user,
      signIn,
      signOut,
      isAuthenticated: Boolean(user),
      isDonor: user?.role === 'DONOR',
      isAgent: user?.role === 'AGENT',
      isAdmin: user?.role === 'ADMIN',
    }),
    [user, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
