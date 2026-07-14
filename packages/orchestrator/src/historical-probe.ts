import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { CapturedResponse, ClientRelease, ClientResult } from "@atm/contracts";

import {
  withHistoricalWorktree,
  type CommandResult,
  type HistoricalWorktreeOptions,
  type WorktreeDependencies,
} from "./worktrees.js";
import { defaultCommandRunner } from "./process.js";

const PROBE_PATH = "apps/mobile/test/api-time-machine.probe.test.ts";
const HASH_MARKER = "ATM_RESPONSE_SHA256=";
const PARSER_REJECTION_MARKER = "ATM_PARSER_REJECTION";

export interface HistoricalProbeOptions
  extends Omit<HistoricalWorktreeOptions, "release"> {
  release: ClientRelease;
  response: CapturedResponse;
}

export interface HistoricalProbeDependencies extends WorktreeDependencies {
  writeText(path: string, contents: string): Promise<void>;
  now?(): number;
}

const defaultDependencies: HistoricalProbeDependencies = {
  async ensureDirectory(path) {
    await mkdir(path, { recursive: true });
  },
  runCommand: defaultCommandRunner,
  writeText(path, contents) {
    return writeFile(path, contents, "utf8");
  },
};

function bodySha256(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

function probeSource(response: CapturedResponse): string {
  return [
    'import { createHash } from "node:crypto";',
    'import { describe, expect, it } from "vitest";',
    'import { parseVerificationResponse } from "../src/api/verification.js";',
    "",
    `const capturedBody = ${JSON.stringify(response.body)};`,
    `const expectedSha256 = ${JSON.stringify(response.sha256)};`,
    "",
    'describe("API Time Machine compatibility probe", () => {',
    '  it("replays the exact captured response through the production parser", () => {',
    '    const actualSha256 = createHash("sha256").update(capturedBody).digest("hex");',
    '    expect(actualSha256).toBe(expectedSha256);',
    `    console.log("${HASH_MARKER}" + actualSha256);`,
    "    try {",
    "      parseVerificationResponse(capturedBody);",
    "    } catch (error) {",
    `      console.error("${PARSER_REJECTION_MARKER}", error);`,
    "      throw error;",
    "    }",
    "  });",
    "});",
    "",
  ].join("\n");
}

function probeCommand(worktreePath: string): string[] {
  return [
    "--dir",
    worktreePath,
    "--filter",
    "@atm/mobile",
    "test",
    "--",
    "test/api-time-machine.probe.test.ts",
  ];
}

function installCommand(worktreePath: string): string[] {
  return ["--dir", worktreePath, "install", "--frozen-lockfile"];
}

function allowedTestCommand(release: ClientRelease): boolean {
  return release.testCommand === "pnpm test -- --runInBand";
}

function inconclusiveResult(
  release: ClientRelease,
  response: CapturedResponse,
  summary: string,
  result?: CommandResult,
): ClientResult {
  return {
    release,
    status: "inconclusive",
    responseSha256: response.sha256,
    durationMs: result?.durationMs ?? 0,
    summary,
    evidence: {
      command: result ? `pnpm ${probeCommand("<historical-worktree>").join(" ")}` : undefined,
      stdout: result?.stdout,
      stderr: result?.stderr,
      sourceFile: "apps/mobile/src/api/verification.ts",
    },
  };
}

function classifyProbe(
  release: ClientRelease,
  response: CapturedResponse,
  worktreePath: string,
  installResult: CommandResult,
  result: CommandResult,
): ClientResult {
  const output = `${result.stdout}\n${result.stderr}`;
  const command = [
    `pnpm ${installCommand(worktreePath).join(" ")}`,
    `pnpm ${probeCommand(worktreePath).join(" ")}`,
  ].join("\n");
  const stdout = [`[install]\n${installResult.stdout}`, `[probe]\n${result.stdout}`].join(
    "\n",
  );
  const stderr = [`[install]\n${installResult.stderr}`, `[probe]\n${result.stderr}`].join(
    "\n",
  );

  if (result.timedOut) {
    return inconclusiveResult(
      release,
      response,
      "Historical parser probe timed out.",
      result,
    );
  }

  if (!output.includes(`${HASH_MARKER}${response.sha256}`)) {
    return inconclusiveResult(
      release,
      response,
      "Historical parser probe did not prove it replayed the captured response bytes.",
      result,
    );
  }

  if (result.exitCode === 0) {
    return {
      release,
      status: "compatible",
      responseSha256: response.sha256,
      durationMs: result.durationMs ?? 0,
      summary: "Production parser accepted the captured response.",
      evidence: {
        command,
        stdout,
        stderr,
        sourceFile: "apps/mobile/src/api/verification.ts",
      },
    };
  }

  if (output.includes(PARSER_REJECTION_MARKER)) {
    return {
      release,
      status: "incompatible",
      responseSha256: response.sha256,
      durationMs: result.durationMs ?? 0,
      summary: "Production parser rejected the captured response.",
      evidence: {
        command,
        stdout,
        stderr,
        sourceFile: "apps/mobile/src/api/verification.ts",
      },
    };
  }

  return inconclusiveResult(
    release,
    response,
    `Historical parser probe failed with exit code ${result.exitCode} before parser evidence was produced.`,
    result,
  );
}

export async function runHistoricalProbe(
  options: HistoricalProbeOptions,
  dependencies: HistoricalProbeDependencies = defaultDependencies,
): Promise<ClientResult> {
  if (bodySha256(options.response.body) !== options.response.sha256) {
    return inconclusiveResult(
      options.release,
      options.response,
      "Captured response body does not match its declared SHA-256.",
    );
  }

  if (options.response.request.appVersion !== options.release.version) {
    return inconclusiveResult(
      options.release,
      options.response,
      "Captured response application version does not match the historical release.",
    );
  }

  if (!allowedTestCommand(options.release)) {
    return inconclusiveResult(
      options.release,
      options.response,
      `Release test command is not allowlisted: ${options.release.testCommand}`,
    );
  }

  const startedAt = dependencies.now?.() ?? performance.now();
  return withHistoricalWorktree(
    options,
    async (worktree) => {
      const installResult = await dependencies.runCommand(
        "pnpm",
        installCommand(worktree.path),
      );
      if (installResult.exitCode !== 0 || installResult.timedOut) {
        return inconclusiveResult(
          options.release,
          options.response,
          installResult.timedOut
            ? "Historical release dependency installation timed out."
            : "Historical release dependency installation failed.",
          installResult,
        );
      }

      await dependencies.writeText(
        resolve(worktree.path, PROBE_PATH),
        probeSource(options.response),
      );
      const result = await dependencies.runCommand("pnpm", probeCommand(worktree.path));
      const classified = classifyProbe(
        options.release,
        options.response,
        worktree.path,
        installResult,
        result,
      );

      return {
        ...classified,
        durationMs:
          classified.durationMs || Math.round((dependencies.now?.() ?? performance.now()) - startedAt),
      };
    },
    dependencies,
  );
}

export {
  HASH_MARKER,
  PARSER_REJECTION_MARKER,
  PROBE_PATH as HISTORICAL_PROBE_PATH,
};
