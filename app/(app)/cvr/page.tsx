import type { Metadata } from 'next';
import { CvrFinder } from '@/components/cvr/CvrFinder';

export const metadata: Metadata = { title: 'Find in CVR' };

export default function CvrPage() {
  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <header>
        <h1 className="text-xl font-semibold text-slate-900">Find in CVR</h1>
        <p className="mt-1 text-sm text-slate-500">
          Search the Danish company register by branche, place, size, company form and age, and add
          the directors as leads. Contact details are the company&apos;s own, as registered in CVR.
        </p>
      </header>
      <CvrFinder />
    </div>
  );
}
