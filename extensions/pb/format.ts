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
