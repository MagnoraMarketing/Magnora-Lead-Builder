import type { Metadata } from 'next';
import { TodayBoard } from '@/components/today/TodayBoard';

export const metadata: Metadata = { title: 'Today' };

export default function TodayPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <header>
        <h1 className="text-xl font-semibold text-slate-900">Today</h1>
        <p className="mt-1 text-sm text-slate-500">
          Follow-ups that are due, replies waiting for an answer, and messages ready to send. The
          app plans and drafts; you send each message on LinkedIn and mark it as sent.
        </p>
      </header>
      <TodayBoard />
    </div>
  );
}
