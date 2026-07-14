import type {
  CapturedResponse,
  ClientRelease,
  ClientResult,
  CompatibilityRun,
} from "@atm/contracts";

import { writeEvidenceBundle, type EvidenceBundle } from "./evidence.js";
import { runHistoricalProbe } from "./historical-probe.js";
import { runCompatibilityCheck } from "./index.js";
import { defaultCommandRunner } from "./process.js";
import { loadReleaseManifest } from "./releases.js";
import type { CommandRunner } from "./worktrees.js";

export interface CompatibilityGateOptions {
  runId: string;
  manifestPath: string;
  repositoryPath: string;
  worktreesRoot: string;
  runsRoot: string;
}

export interface CompatibilityGateAdapters {
  captureResponse(release: ClientRelease): Promise<CapturedResponse>;
  loadReleases?(): Promise<ClientRelease[]>;
  runClient?(
    release: ClientRelease,
    response: CapturedResponse,
  ): Promise<ClientResult>;
  resolveCommit?(release: ClientRelease): Promise<string | null>;
  writeEvidence?(
    run: CompatibilityRun,
    captures: CapturedResponse[],
    releaseCommits: Record<string, string | null>,
  ): Promise<EvidenceBundle>;
}

export interface CompatibilityGateResult {
  run: CompatibilityRun;
  evidence: EvidenceBundle;
}

function createCommitResolver(
  repositoryPath: string,
  runner: CommandRunner = defaultCommandRunner,
): (release: ClientRelease) => Promise<string | null> {
  return async (release) => {
    const result = await runner("git", [
      "-C",
      repositoryPath,
      "rev-parse",
      `${release.gitTag}^{commit}`,
    ]);
    const commitSha = result.stdout.trim();

    return result.exitCode === 0 && /^[a-f0-9]{40}$/i.test(commitSha)
      ? commitSha
      : null;
  };
}

export async function runHistoricalCompatibilityGate(
  options: CompatibilityGateOptions,
  adapters: CompatibilityGateAdapters,
): Promise<CompatibilityGateResult> {
  const releases = await (adapters.loadReleases?.() ??
    loadReleaseManifest(options.manifestPath));
  const captureByRelease = new Map<string, CapturedResponse>();
  const resolveCommit =
    adapters.resolveCommit ?? createCommitResolver(options.repositoryPath);
  const releaseCommits = Object.fromEntries(
    await Promise.all(
      releases.map(async (release) => [release.version, await resolveCommit(release)]),
    ),
  ) as Record<string, string | null>;

  const run = await runCompatibilityCheck(
    { runId: options.runId, releases },
    {
      captureResponse: async (release) => {
        const response = await adapters.captureResponse(release);
        captureByRelease.set(release.version, response);
        return response;
      },
      runClient:
        adapters.runClient ??
        ((release, response) =>
          runHistoricalProbe({
            repositoryPath: options.repositoryPath,
            worktreesRoot: options.worktreesRoot,
            runId: options.runId,
            release,
            response,
          })),
    },
  );
  const captures = releases.flatMap((release) => {
    const capture = captureByRelease.get(release.version);
    return capture ? [capture] : [];
  });
  const evidence = await (adapters.writeEvidence?.(
    run,
    captures,
    releaseCommits,
  ) ??
    writeEvidenceBundle(options.runsRoot, {
      run,
      captures,
      releaseCommits,
    }));

  return { run, evidence };
}
