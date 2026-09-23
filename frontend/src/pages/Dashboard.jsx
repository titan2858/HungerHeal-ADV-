import { useAuth } from '../context/AuthContext';
import AgentDashboard from '../components/AgentDashboard';
import DonorDashboard from '../components/DonorDashboard';
import MonitoringView from '../components/MonitoringView';

const SUBTITLE = {
  DONOR: 'Post surplus food and follow it until it is collected.',
  AGENT: 'Go on shift, answer collection requests, mark pickups done.',
  ADMIN: 'A read-only view of every matching decision the engine made.',
};

export default function Dashboard() {
  const { user } = useAuth();

  return (
    <div className="mx-auto max-w-5xl px-4 py-10 sm:px-6 sm:py-14">
      <header className="mb-8">
        <p className="eyebrow mb-3">{user.role.toLowerCase()}</p>
        <h1 className="text-3xl font-semibold sm:text-4xl">
          Hello, {user.name?.split(' ')[0]}
        </h1>
        <p className="mt-2 text-ink-500">{SUBTITLE[user.role]}</p>
      </header>

      {user.role === 'AGENT' && <AgentDashboard />}
      {user.role === 'DONOR' && <DonorDashboard />}
      {user.role === 'ADMIN' && <MonitoringView />}
    </div>
  );
}
