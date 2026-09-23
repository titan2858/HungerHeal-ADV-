import { useNavigate } from 'react-router-dom';
import DonationForm from '../components/DonationForm';
import PageHeader from '../components/layout/PageHeader';
import Card from '../components/ui/Card';
import { useToast } from '../context/ToastContext';

const NOTES = [
  'Pick the category carefully — it decides which collectors are eligible and how long they get to respond.',
  'Drop the pin on the actual gate or door. A typed address often resolves to the middle of a long road.',
  'Your phone number is only shared once a collector has accepted.',
];

export default function Donate() {
  const toast = useToast();
  const navigate = useNavigate();

  return (
    <>
      <PageHeader
        eyebrow="Post a donation"
        title="Tell us what you have"
        description="Under a minute to post. A nearby collector is found automatically — you do not have to contact anyone."
      />

      <div className="mx-auto grid max-w-5xl gap-8 px-4 py-12 sm:px-6 lg:grid-cols-[1.6fr_1fr] lg:items-start">
        <DonationForm
          onCreated={() => {
            toast.success('Donation posted. Finding a collector now.');
            // The donor's own list lives on the dashboard, and the pipeline
            // needs a moment before the status is meaningful.
            setTimeout(() => navigate('/dashboard'), 2500);
          }}
        />

        <Card className="lg:sticky lg:top-24">
          <h2 className="text-base font-semibold">Before you post</h2>
          <ul className="mt-4 space-y-3">
            {NOTES.map((note) => (
              <li key={note} className="flex gap-2.5 text-sm leading-relaxed text-ink-500">
                <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-leaf-500" />
                {note}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}
