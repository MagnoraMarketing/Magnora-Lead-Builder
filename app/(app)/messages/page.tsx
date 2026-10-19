import type { Metadata } from 'next';
import { Suspense } from 'react';
import { MessagesQueue } from '@/components/outreach/MessagesQueue';

export const metadata: Metadata = { title: 'Messages' };

export default function MessagesPage() {
  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <header>
        <h1 className="text-xl font-semibold text-slate-900">Messages</h1>
        <p className="mt-1 text-sm text-slate-500">
          Review drafts, approve them, copy them into LinkedIn, then mark them as sent.
        </p>
      </header>

      <Suspense fallback={<div className="h-64 rounded-lg border border-slate-200 bg-white" />}>
        <MessagesQueue />
      </Suspense>
    </div>
  );
}
