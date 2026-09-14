export function progressBar(
  percent: number | undefined,
  width = 18,
  filled = "█",
  empty = "░",
): string {
  if (percent === undefined || Number.isNaN(percent)) {
    return `${empty.repeat(width)}`;
  }

  const p = Math.max(0, Math.min(100, percent));
  const count = Math.round((p / 100) * width);
  return filled.repeat(count) + empty.repeat(width - count);
}
