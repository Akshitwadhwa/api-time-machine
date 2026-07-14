import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type { CapturedResponse, ClientRelease } from "@atm/contracts";

import {
  runHistoricalCompatibilityGate,
  type CompatibilityGateAdapters,
} from "../src/index.js";

const body = JSON.stringify({ status: "MANUAL_REVIEW" });
const sha256 = createHash("sha256").update(body).digest("hex");

const releases: ClientRelease[] = [
  {
    platform: "android-react-native",
    version: "1.0.0",
    gitTag: "app-v1.0.0",
    activeShare: 0.18,
    supported: true,
    source: "hackathon-sample",
    observedAt: "2026-07-14T00:00:00.000Z",
    testCommand: "pnpm test -- --runInBand",
  },
  {
    platform: "android-react-native",
    version: "1.2.0",
    gitTag: "app-v1.2.0",
    activeShare: 0.82,
    supported: true,
    source: "hackathon-sample",
    observedAt: "2026-07-14T00:00:00.000Z",
    testCommand: "pnpm test -- --runInBand",
  },
];

function response(release: ClientRelease): CapturedResponse {
  return {
    request: {
      method: "GET",
      url: "/verification/verification_123",
      appVersion: release.version,
    },
    statusCode: 200,
    headers: {},
    body,
    sha256,
    capturedAt: "2026-07-14T10:30:00.000Z",
  };
}

describe("runHistoricalCompatibilityGate", () => {
  it("connects captures, historical outcomes, commit evidence, and blast radius", async () => {
    const writeEvidence = vi.fn().mockResolvedValue({
      directory: "/runs/run_123",
      manifestPath: "/runs/run_123/manifest.json",
      matrixPath: "/runs/run_123/survival-matrix.md",
    });
    const adapters: CompatibilityGateAdapters = {
      loadReleases: vi.fn().mockResolvedValue(releases),
      captureResponse: async (release) => response(release),
      runClient: async (release, captured) => ({
        release,
        status: release.version === "1.0.0" ? "incompatible" : "compatible",
        responseSha256: captured.sha256,
        durationMs: 10,
        summary: "Historical parser result",
        evidence: {},
      }),
      resolveCommit: async () => "a".repeat(40),
      writeEvidence,
    };

    const result = await runHistoricalCompatibilityGate(
      {
        runId: "run_123",
        manifestPath: "/unused/releases.json",
        repositoryPath: "/repo",
        worktreesRoot: "/repo/.worktrees",
        runsRoot: "/repo/runs",
      },
      adapters,
    );

    expect(result.run.status).toBe("incompatible");
    expect(result.run.blastRadius).toBe(0.18);
    expect(writeEvidence).toHaveBeenCalledWith(
      result.run,
      expect.arrayContaining([expect.objectContaining({ sha256 })]),
      { "1.0.0": "a".repeat(40), "1.2.0": "a".repeat(40) },
    );
  });
});
