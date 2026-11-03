/**
 * Number formatting shared by the session views and the stats: one human form for counts and rates,
 * so the terminal and the machine report never disagree about how a number is written.
 */
export const human = (n: number) => (n < 1000 ? `${n}` : n < 1e6 ? `${(n / 1e3).toFixed(1)}k` : `${(n / 1e6).toFixed(2)}M`);

/** Blended throughput over a run's wall time: tokens per second, compact above a thousand. */
export const outRate = (out: number, ms: number) => {
  const rate = (out / ms) * 1000;
  return rate < 1000 ? rate.toFixed(1) : human(rate);
};

/** Human-readable elapsed time: 12s, 3m 4s, 1h 5m, 2d 3h. Zero means no measurable time. */
export const duration = (ms: number): string => {
  if (!Number.isFinite(ms) || ms <= 0) return "0s";
  if (ms < 1000) return "<1s";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest ? `${hours}h ${rest}m` : `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest ? `${days}d ${rest}h` : `${days}d`;
};
