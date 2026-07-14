import { fileURLToPath } from "node:url";

import { captureVerificationResponse } from "@atm/backend";
import {
  compatibilityExitCode,
  renderSurvivalMatrix,
  runHistoricalCompatibilityGate,
} from "@atm/orchestrator";

const repositoryPath = fileURLToPath(new URL("../../../", import.meta.url));
const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;

try {
  const { evidence, run } = await runHistoricalCompatibilityGate(
    {
      runId,
      manifestPath: `${repositoryPath}config/releases.json`,
      repositoryPath,
      worktreesRoot: `${repositoryPath}.worktrees`,
      runsRoot: `${repositoryPath}runs`,
    },
    {
      captureResponse(release) {
        return captureVerificationResponse({ appVersion: release.version });
      },
    },
  );

  console.log(renderSurvivalMatrix(run));
  console.log(`Evidence: ${evidence.directory}`);
  process.exitCode = compatibilityExitCode(run.status);
} catch (error) {
  console.error(
    "API Time Machine could not complete compatibility verification:",
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 2;
}
