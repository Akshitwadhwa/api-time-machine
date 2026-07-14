import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { CapturedResponse, ClientRelease } from "@atm/contracts";

import {
  HASH_MARKER,
  HISTORICAL_PROBE_PATH,
  PARSER_REJECTION_MARKER,
  runHistoricalProbe,
  type CommandResult,
  type HistoricalProbeDependencies,
} from "../src/index.js";

const body = JSON.stringify({
  id: "verification_123",
  status: "MANUAL_REVIEW",
  updatedAt: "2026-07-14T10:30:00.000Z",
});
const sha256 = createHash("sha256").update(body).digest("hex");

const release: ClientRelease = {
  platform: "android-react-native",
  version: "1.0.0",
  gitTag: "app-v1.0.0",
  activeShare: 0.18,
  supported: true,
  source: "hackathon-sample",
  observedAt: "2026-07-14T00:00:00.000Z",
  testCommand: "pnpm test -- --runInBand",
};

const response: CapturedResponse = {
  request: {
    method: "GET",
    url: "/verification/verification_123",
    appVersion: "1.0.0",
  },
  statusCode: 200,
  headers: { "content-type": "application/json" },
  body,
  sha256,
  capturedAt: "2026-07-14T10:30:00.000Z",
};

function commandResult(overrides: Partial<CommandResult> = {}): CommandResult {
  return { exitCode: 0, stdout: "", stderr: "", durationMs: 25, ...overrides };
}

function dependencies(
  results: CommandResult[],
): HistoricalProbeDependencies & {
  ensureDirectory: ReturnType<typeof vi.fn>;
  runCommand: ReturnType<typeof vi.fn>;
  writeText: ReturnType<typeof vi.fn>;
} {
  return {
    ensureDirectory: vi.fn().mockResolvedValue(undefined),
    runCommand: vi.fn(async () => results.shift() ?? commandResult()),
    writeText: vi.fn().mockResolvedValue(undefined),
    now: vi.fn(() => 1_000),
  };
}

const options = {
  repositoryPath: "/repo",
  worktreesRoot: "/repo/.worktrees",
  runId: "run_123",
  release,
  response,
};

describe("runHistoricalProbe", () => {
  it("accepts a successful probe even when Vitest suppresses its success log", async () => {
    const testDependencies = dependencies([
      commandResult(),
      commandResult({ stdout: `${"a".repeat(40)}\n` }),
      commandResult(),
      commandResult({ exitCode: 0 }),
      commandResult(),
      commandResult(),
    ]);

    await expect(runHistoricalProbe(options, testDependencies)).resolves.toMatchObject({
      status: "compatible",
      responseSha256: sha256,
    });
  });

  it("classifies a marked production-parser rejection as incompatible", async () => {
    const testDependencies = dependencies([
      commandResult(),
      commandResult({ stdout: `${"a".repeat(40)}\n` }),
      commandResult(),
      commandResult({
        exitCode: 1,
        stderr: `${HASH_MARKER}${sha256}\n${PARSER_REJECTION_MARKER} ZodError`,
      }),
      commandResult(),
      commandResult(),
    ]);

    const result = await runHistoricalProbe(options, testDependencies);

    expect(result.status).toBe("incompatible");
    expect(result.responseSha256).toBe(sha256);
    expect(testDependencies.writeText).toHaveBeenCalledWith(
      "/repo/.worktrees/run_123-1.0.0/apps/mobile/test/api-time-machine.probe.test.ts",
      expect.stringContaining('parseVerificationResponse(capturedBody)'),
    );
  });

  it("marks an unproven test failure as inconclusive", async () => {
    const testDependencies = dependencies([
      commandResult(),
      commandResult({ stdout: `${"b".repeat(40)}\n` }),
      commandResult(),
      commandResult({ exitCode: 1, stderr: "pnpm install failed" }),
      commandResult(),
      commandResult(),
    ]);

    await expect(runHistoricalProbe(options, testDependencies)).resolves.toMatchObject({
      status: "inconclusive",
      summary: expect.stringContaining("did not prove"),
    });
  });

  it("fails closed before creating a worktree when captured bytes do not match", async () => {
    const testDependencies = dependencies([]);

    const result = await runHistoricalProbe(
      { ...options, response: { ...response, sha256: "c".repeat(64) } },
      testDependencies,
    );

    expect(result.status).toBe("inconclusive");
    expect(testDependencies.runCommand).not.toHaveBeenCalled();
  });
});
