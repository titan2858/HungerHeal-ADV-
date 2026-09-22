import { useState } from 'react';
import Login from './components/Login';
import AgentDashboard from './components/AgentDashboard';
import DonorDashboard from './components/DonorDashboard';
import MonitoringView from './components/MonitoringView';
import { auth } from './api/client';
import './App.css';

export default function App() {
  const [user, setUser] = useState(auth.user);

  if (!user) {
    return (
      <div className="shell">
        <header>
          <div>
            <h1>HungerHeal</h1>
            <p className="tagline">Surplus food, matched to a collection agent automatically.</p>
          </div>
        </header>
        <Login onAuthenticated={setUser} />
      </div>
    );
  }

  return (
    <div className="shell">
      <header>
        <div>
          <h1>HungerHeal</h1>
          <p className="tagline">
            {user.name} · {user.role.toLowerCase()}
          </p>
        </div>
        <button
          className="secondary"
          onClick={() => {
            auth.clear();
            setUser(null);
          }}
        >
          Log out
        </button>
      </header>

      {user.role === 'AGENT' && <AgentDashboard user={user} />}
      {user.role === 'DONOR' && <DonorDashboard />}
      {user.role === 'ADMIN' && <MonitoringView />}
    </div>
  );
}
