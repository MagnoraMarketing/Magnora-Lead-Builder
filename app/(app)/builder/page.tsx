import type { Metadata } from 'next';
import { AiLeadBuilder } from '@/components/builder/AiLeadBuilder';

export const metadata: Metadata = { title: 'AI Lead Builder' };

export default function BuilderPage() {
  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <header>
        <h1 className="text-xl font-semibold text-slate-900">AI Lead Builder</h1>
        <p className="mt-1 text-sm text-slate-500">
          Generate a personalised LinkedIn message for a lead, review it, and track it from draft
          to sent.
        </p>
      </header>
      <AiLeadBuilder />
    </div>
  );
}
