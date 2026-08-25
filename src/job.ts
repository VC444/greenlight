/**
 * A PR event the pipeline should process.
 *
 * Built by src/actionMain.ts from the workflow's event payload. It stays a
 * plain descriptor rather than the raw event so the pipeline reads only the
 * handful of fields it actually needs.
 */
export interface PullRequestJob {
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  action: "opened" | "synchronize";
}
