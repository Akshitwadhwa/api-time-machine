import {
  CompatibilityRunSchema,
  type CapturedResponse,
  type ClientRelease,
  type ClientResult,
  type CompatibilityRun,
  type CompatibilityStatus,
} from "@atm/contracts";

export {
  ReleaseManifestError,
  loadReleaseManifest,
  parseReleaseManifest,
} from "./releases.js";

export {
  HistoricalWorktreeError,
  createHistoricalWorktree,
  withHistoricalWorktree,
  type CommandResult,
  type CommandRunner,
  type HistoricalWorktree,
  type HistoricalWorktreeOptions,
  type WorktreeDependencies,
} from "./worktrees.js";

export { defaultCommandRunner, runCommand } from "./process.js";

export {
  EvidenceBundleError,
  writeEvidenceBundle,
  type EvidenceBundle,
  type EvidenceBundleInput,
  type EvidenceDependencies,
} from "./evidence.js";

export {
  compatibilityExitCode,
  renderSurvivalMatrix,
  type CompatibilityExitCode,
} from "./report.js";

export {
  HASH_MARKER,
  HISTORICAL_PROBE_PATH,
  PARSER_REJECTION_MARKER,
  runHistoricalProbe,
  type HistoricalProbeDependencies,
  type HistoricalProbeOptions,
} from "./historical-probe.js";

export interface CompatibilityAdapters {
  captureResponse(release: ClientRelease): Promise<CapturedResponse>;
  runClient(
    release: ClientRelease,
    response: CapturedResponse,
  ): Promise<ClientResult>;
  now?(): Date;
}

export interface CompatibilityRequest {
  runId: string;
  releases: ClientRelease[];
}

function classifyRun(results: ClientResult[]): CompatibilityStatus {
  if (results.some((result) => result.status === "incompatible")) {
    return "incompatible";
  }
  if (results.some((result) => result.status === "inconclusive")) {
    return "inconclusive";
  }
  return "compatible";
}

export async function runCompatibilityCheck(
  request: CompatibilityRequest,
  adapters: CompatibilityAdapters,
): Promise<CompatibilityRun> {
  const now = adapters.now ?? (() => new Date());
  const startedAt = now().toISOString();

  const clients = await Promise.all(
    request.releases.map(async (release) => {
      const response = await adapters.captureResponse(release);
      return adapters.runClient(release, response);
    }),
  );

  const blastRadius = clients
    .filter((result) => result.status === "incompatible")
    .reduce((sum, result) => sum + result.release.activeShare, 0);

  return CompatibilityRunSchema.parse({
    runId: request.runId,
    status: classifyRun(clients),
    clients,
    blastRadius: Math.round(blastRadius * 1_000_000) / 1_000_000,
    startedAt,
    completedAt: now().toISOString(),
  });
}
