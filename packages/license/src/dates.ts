const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A real calendar date written `YYYY-MM-DD` (so `2027-02-31` is not one). */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().slice(0, 10) === value;
}

/** `2027-10-03` -> `3 Oct 2027`. */
export function formatDate(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number) as [number, number, number];
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

/** The same day a year later; 29 Feb becomes 28 Feb. */
export function oneYearFrom(iso: string): string {
  const [year, month, day] = iso.split("-").map(Number) as [number, number, number];
  let next = new Date(Date.UTC(year + 1, month - 1, day));
  if (next.getUTCMonth() !== month - 1) next = new Date(Date.UTC(year + 1, month, 0));
  return next.toISOString().slice(0, 10);
}
