/** Human-readable renderings shared by progress lines, diagnostics, and step summaries. */

export function formatMebibytes(bytes: number): string {
  return (bytes / 1_048_576).toFixed(2);
}

export function formatSeconds(milliseconds: number): string {
  return `${(milliseconds / 1_000).toFixed(1)}s`;
}

export function averageMs(totalMs: number, count: number): number {
  return count > 0 ? Math.round(totalMs / count) : 0;
}
