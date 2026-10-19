/**
 * Helpers for <input type="datetime-local">, which works in the browser's
 * local time with no zone, while the API stores UTC instants.
 */

/** ISO instant → "YYYY-MM-DDTHH:mm" in the browser's local time. */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

/** "YYYY-MM-DDTHH:mm" in local time → ISO instant, or null when blank/invalid. */
export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** End of the browser's current day, as an ISO instant. */
export function endOfLocalDay(now = new Date()): string {
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  return end.toISOString();
}

/** A local time `days` from now at 09:00, the default for a planned follow-up. */
export function morningInDays(days: number, now = new Date()): string {
  const date = new Date(now);
  date.setDate(date.getDate() + days);
  date.setHours(9, 0, 0, 0);
  return date.toISOString();
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}
