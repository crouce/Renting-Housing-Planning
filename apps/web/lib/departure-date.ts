/** The planner serves Chinese transit schedules, independent of browser timezone. */
export function chinaDate(now = Date.now(), days = 0) {
  return new Date(now + 8 * 60 * 60_000 + days * 86400_000)
    .toISOString()
    .slice(0, 10);
}

export function validDepartureDate(value: string, today = chinaDate()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return (
    Number.isFinite(parsed) &&
    new Date(parsed).toISOString().slice(0, 10) === value &&
    value >= today
  );
}
