import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './context/AuthContext';
import { ToastProvider } from './context/ToastContext';
import Layout from './components/layout/Layout';

import Home from './pages/Home';
import About from './pages/About';
import Mission from './pages/Mission';
import HowItWorks from './pages/HowItWorks';
import Partners from './pages/Partners';
import Contact from './pages/Contact';
import Login from './pages/Login';
import Signup from './pages/Signup';
import Donate from './pages/Donate';
import Dashboard from './pages/Dashboard';
import Monitoring from './pages/Monitoring';
import NotFound from './pages/NotFound';

// Remembers where you were going, so logging in returns you there instead of
// dumping you on a generic dashboard.
function RequireAuth({ roles, children }) {
  const { user, isAuthenticated } = useAuth();
  const location = useLocation();

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  // A role that cannot use this page is sent to one it can, not shown an error.
  if (roles && !roles.includes(user.role)) {
    return <Navigate to="/dashboard" replace />;
  }

  return children;
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <Routes>
            <Route element={<Layout />}>
              <Route index element={<Home />} />
              <Route path="about" element={<About />} />
              <Route path="mission" element={<Mission />} />
              <Route path="how-it-works" element={<HowItWorks />} />
              <Route path="partners" element={<Partners />} />
              <Route path="contact" element={<Contact />} />
              <Route path="login" element={<Login />} />
              <Route path="signup" element={<Signup />} />

              <Route
                path="donate"
                element={
                  <RequireAuth roles={['DONOR']}>
                    <Donate />
                  </RequireAuth>
                }
              />
              <Route
                path="dashboard"
                element={
                  <RequireAuth>
                    <Dashboard />
                  </RequireAuth>
                }
              />
              <Route
                path="monitoring"
                element={
                  <RequireAuth roles={['ADMIN']}>
                    <Monitoring />
                  </RequireAuth>
                }
              />

              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
