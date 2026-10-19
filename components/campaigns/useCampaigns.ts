'use client';

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api/client';
import type { Campaign } from '@/types/database';

/** The caller's campaigns, for pickers and filters. Failure leaves the list empty. */
export function useCampaigns() {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ items: Campaign[] }>('/api/campaigns')
      .then((data) => {
        if (!cancelled) setCampaigns(data.items);
      })
      .catch(() => {
        // Pickers degrade to "No campaign"; the pages that need the list show their own errors.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return campaigns;
}
