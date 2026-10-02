/** Human-readable renderings shared by progress lines, diagnostics, and step summaries. */

export function formatMebibytes(bytes: number): string {
  return (bytes / 1_048_576).toFixed(2);
}
