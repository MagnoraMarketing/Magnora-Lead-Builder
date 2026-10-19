'use client';

import { useState } from 'react';
import { LeadForm } from '@/components/builder/LeadForm';
import { LeadsMessagesTable } from '@/components/builder/LeadsMessagesTable';

/** Form and table share one reload signal, so a saved lead appears at once. */
export function AiLeadBuilder() {
  const [reloadKey, setReloadKey] = useState(0);
  return (
    <div className="space-y-5">
      <LeadForm onSaved={() => setReloadKey((k) => k + 1)} />
      <LeadsMessagesTable reloadKey={reloadKey} />
    </div>
  );
}
