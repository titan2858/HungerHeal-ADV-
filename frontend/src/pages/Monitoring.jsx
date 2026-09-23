import MonitoringView from '../components/MonitoringView';
import PageHeader from '../components/layout/PageHeader';

export default function Monitoring() {
  return (
    <>
      <PageHeader
        eyebrow="Monitoring"
        title="Every decision, and the reasoning behind it"
        description="Read-only by design. There is no assign or reassign control here — the point of the rebuild was removing the human from assignment, and an override button would put them straight back."
      />
      <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6">
        <MonitoringView />
      </div>
    </>
  );
}
