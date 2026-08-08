import { appendFileSync, writeFileSync } from 'node:fs';

/**
 * Emits progress to stdout and, if configured, to a file synchronously.
 * `shortLine` overwrites a single interactive terminal line, so it has to stay
 * well under one line; `detailedLine` goes to the progress file and to CI logs,
 * which scroll instead of overwriting.
 */
export type ProgressReporter = (shortLine: string, detailedLine?: string) => void;

export function createProgressReporter(
  progressFile: string | null,
  startedAt: number,
): ProgressReporter {
  const isGitHubActions = process.env.GITHUB_ACTIONS === 'true';
  if (progressFile) {
    try {
      writeFileSync(progressFile, '');
    } catch {
      /* ignore */
    }
  }

  return (shortLine: string, detailedLine?: string) => {
    const line = detailedLine ?? shortLine;
    process.stdout.write(isGitHubActions ? `${line}\n` : `${shortLine}\r`);
    if (!progressFile) return;
    const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(0);
    // Best-effort: never fail the build because progress couldn't be written.
    try {
      appendFileSync(progressFile, `${line}  |  ${elapsedSeconds}s elapsed\n`);
    } catch {
      /* ignore */
    }
  };
}
