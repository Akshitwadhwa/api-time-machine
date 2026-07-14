import { describe, expect, it, vi } from "vitest";

import {
  CodexCliError,
  adviseRepairForFailures,
  createCodexCliAdapter,
  createCodexWorkflow,
  type CodexAdapter,
  type CodexCliDependencies,
} from "../src/index.js";

describe("createCodexWorkflow", () => {
  it("validates structured analysis before returning it", async () => {
    const adapter: CodexAdapter = {
      async run() {
        return {
          endpoint: "GET /verification/:id",
          responseType: "VerificationResponse",
          field: "status",
          changeType: "enum_value_added",
          previousValues: ["VERIFIED", "PENDING", "REJECTED"],
          proposedValues: [
            "VERIFIED",
            "PENDING",
            "MANUAL_REVIEW",
            "REJECTED",
          ],
          newValues: ["MANUAL_REVIEW"],
          sourceFile: "apps/backend/src/domain/verification.ts",
        };
      },
    };

    const workflow = createCodexWorkflow(adapter);
    const change = await workflow.analyzeChange({
      diff: "+ MANUAL_REVIEW",
      capturedResponse: {
        request: {
          method: "GET",
          url: "/verification/verification_123",
          appVersion: "1.0.0",
        },
        statusCode: 200,
        headers: {},
        body: '{"status":"MANUAL_REVIEW"}',
        sha256: "0".repeat(64),
        capturedAt: "2026-07-14T10:30:00.000Z",
      },
    });

    expect(change.newValues).toEqual(["MANUAL_REVIEW"]);
  });
});

describe("createCodexCliAdapter", () => {
  const analysis = {
    endpoint: "GET /verification/:id",
    responseType: "VerificationResponse",
    field: "status",
    changeType: "enum_value_added",
    previousValues: ["VERIFIED", "PENDING", "REJECTED"],
    proposedValues: ["VERIFIED", "PENDING", "MANUAL_REVIEW", "REJECTED"],
    newValues: ["MANUAL_REVIEW"],
    sourceFile: "apps/backend/src/domain/verification.ts",
  };

  function dependencies(): CodexCliDependencies & {
    ensureDirectory: ReturnType<typeof vi.fn>;
    writeText: ReturnType<typeof vi.fn>;
    readText: ReturnType<typeof vi.fn>;
    runCommand: ReturnType<typeof vi.fn>;
  } {
    return {
      ensureDirectory: vi.fn().mockResolvedValue(undefined),
      writeText: vi.fn().mockResolvedValue(undefined),
      readText: vi.fn().mockResolvedValue(JSON.stringify(analysis)),
      runCommand: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" }),
      nextId: () => "codex-test",
    };
  }

  it("runs Codex in a read-only sandbox and returns the structured proposal", async () => {
    const testDependencies = dependencies();
    const adapter = createCodexCliAdapter(
      { repositoryPath: "/repo", artifactsRoot: "/runs/codex" },
      testDependencies,
    );

    await expect(
      adapter.run({
        kind: "analyze-change",
        diff: "+ MANUAL_REVIEW",
        capturedResponse: {
          request: { method: "GET", url: "/verification/verification_123", appVersion: "1.0.0" },
          statusCode: 200,
          headers: {},
          body: '{"status":"MANUAL_REVIEW"}',
          sha256: "0".repeat(64),
          capturedAt: "2026-07-14T10:30:00.000Z",
        },
      }),
    ).resolves.toEqual(analysis);

    expect(testDependencies.runCommand).toHaveBeenCalledWith(
      "codex",
      expect.arrayContaining(["--sandbox", "read-only", "--ask-for-approval", "never"]),
    );
  });

  it("fails safely when the Codex process fails", async () => {
    const testDependencies = dependencies();
    testDependencies.runCommand.mockResolvedValue({
      exitCode: 1,
      stdout: "",
      stderr: "not authenticated",
    });
    const adapter = createCodexCliAdapter(
      { repositoryPath: "/repo", artifactsRoot: "/runs/codex" },
      testDependencies,
    );

    await expect(
      adapter.run({
        kind: "propose-repair",
        change: {
          endpoint: "GET /verification/:id",
          responseType: "VerificationResponse",
          field: "status",
          changeType: "enum_value_added",
          previousValues: ["PENDING"],
          proposedValues: ["PENDING", "MANUAL_REVIEW"],
          newValues: ["MANUAL_REVIEW"],
          sourceFile: "apps/backend/src/domain/verification.ts",
        },
        failures: [],
      }),
    ).rejects.toBeInstanceOf(CodexCliError);
  });
});

describe("adviseRepairForFailures", () => {
  it("uses Codex only when deterministic evidence contains an incompatibility", async () => {
    const adapter: CodexAdapter = {
      async run(task) {
        if (task.kind === "analyze-change") {
          return {
            endpoint: "GET /verification/:id",
            responseType: "VerificationResponse",
            field: "status",
            changeType: "enum_value_added",
            previousValues: ["PENDING"],
            proposedValues: ["PENDING", "MANUAL_REVIEW"],
            newValues: ["MANUAL_REVIEW"],
            sourceFile: "apps/backend/src/domain/verification.ts",
          };
        }
        return {
          summary: "Project MANUAL_REVIEW to PENDING for legacy clients.",
          patch: "diff --git a/apps/backend/src/domain/verification.ts b/apps/backend/src/domain/verification.ts",
          regressionTestPatch: "diff --git a/apps/backend/test/capture.test.ts b/apps/backend/test/capture.test.ts",
          allowedPaths: ["apps/backend/src", "apps/backend/test"],
          legacyProjection: {
            from: "MANUAL_REVIEW",
            to: "PENDING",
            capabilityThreshold: "1.2.0",
            justification: "MANUAL_REVIEW is a refinement of PENDING.",
          },
        };
      },
    };
    const workflow = createCodexWorkflow(adapter);
    const capturedResponse = {
      request: { method: "GET", url: "/verification/verification_123", appVersion: "1.0.0" },
      statusCode: 200,
      headers: {},
      body: '{"status":"MANUAL_REVIEW"}',
      sha256: "0".repeat(64),
      capturedAt: "2026-07-14T10:30:00.000Z",
    };
    const client = {
      release: {
        platform: "android-react-native" as const,
        version: "1.0.0",
        gitTag: "app-v1.0.0",
        activeShare: 0.18,
        supported: true,
        source: "hackathon-sample",
        observedAt: "2026-07-14T00:00:00.000Z",
        testCommand: "pnpm test -- --runInBand",
      },
      status: "incompatible" as const,
      responseSha256: "0".repeat(64),
      durationMs: 10,
      summary: "Production parser rejected the response.",
      evidence: {},
    };

    await expect(
      adviseRepairForFailures(workflow, {
        diff: "+ MANUAL_REVIEW",
        capturedResponse,
        clients: [client],
      }),
    ).resolves.toMatchObject({
      proposal: { legacyProjection: { to: "PENDING" } },
    });

    await expect(
      adviseRepairForFailures(workflow, {
        diff: "+ MANUAL_REVIEW",
        capturedResponse,
        clients: [{ ...client, status: "compatible" }],
      }),
    ).resolves.toBeNull();
  });
});
