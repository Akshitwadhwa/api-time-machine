import {
  ChangeProfileSchema,
  RepairProposalSchema,
  type CapturedResponse,
  type ChangeProfile,
  type ClientResult,
  type RepairProposal,
} from "@atm/contracts";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

export type CodexTask =
  | {
      kind: "analyze-change";
      diff: string;
      capturedResponse: CapturedResponse;
    }
  | {
      kind: "propose-repair";
      change: ChangeProfile;
      failures: ClientResult[];
    };

export interface CodexAdapter {
  run(task: CodexTask): Promise<unknown>;
}

export interface CodexCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CodexCliDependencies {
  ensureDirectory(path: string): Promise<void>;
  writeText(path: string, contents: string): Promise<void>;
  readText(path: string): Promise<string>;
  runCommand(executable: string, arguments_: string[]): Promise<CodexCommandResult>;
  nextId(): string;
}

export interface CodexCliAdapterOptions {
  repositoryPath: string;
  artifactsRoot: string;
}

export class CodexCliError extends Error {
  override readonly name = "CodexCliError";
}

const CODEX_TIMEOUT_MS = 120_000;

function runCodexCommand(
  executable: string,
  arguments_: string[],
): Promise<CodexCommandResult> {
  return new Promise((resolveResult) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolveResult({ exitCode, stdout, stderr });
    };
    const child = spawn(executable, arguments_, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      stderr += `${error.message}\n`;
      finish(-1);
    });
    child.on("close", (code) => finish(code ?? -1));
    const timeout = setTimeout(() => child.kill("SIGTERM"), CODEX_TIMEOUT_MS);
  });
}

const defaultCliDependencies: CodexCliDependencies = {
  async ensureDirectory(path) {
    await mkdir(path, { recursive: true });
  },
  writeText(path, contents) {
    return writeFile(path, contents, "utf8");
  },
  readText(path) {
    return readFile(path, "utf8");
  },
  runCommand: runCodexCommand,
  nextId: randomUUID,
};

function outputSchema(task: CodexTask): Record<string, unknown> {
  if (task.kind === "analyze-change") {
    return {
      type: "object",
      additionalProperties: false,
      required: ["endpoint", "responseType", "field", "changeType", "previousValues", "proposedValues", "newValues", "sourceFile"],
      properties: {
        endpoint: { type: "string" },
        responseType: { type: "string" },
        field: { type: "string" },
        changeType: { const: "enum_value_added" },
        previousValues: { type: "array", items: { type: "string" } },
        proposedValues: { type: "array", items: { type: "string" } },
        newValues: { type: "array", minItems: 1, items: { type: "string" } },
        sourceFile: { type: "string" },
      },
    };
  }

  return {
    type: "object",
    additionalProperties: false,
    required: ["summary", "patch", "regressionTestPatch", "allowedPaths", "legacyProjection"],
    properties: {
      summary: { type: "string" },
      patch: { type: "string" },
      regressionTestPatch: { type: "string" },
      allowedPaths: { type: "array", minItems: 1, items: { type: "string" } },
      legacyProjection: {
        anyOf: [
          { type: "null" },
          {
            type: "object",
            additionalProperties: false,
            required: ["from", "to", "capabilityThreshold", "justification"],
            properties: {
              from: { type: "string" },
              to: { type: "string" },
              capabilityThreshold: { type: "string" },
              justification: { type: "string" },
            },
          },
        ],
      },
    },
  };
}

function promptFor(task: CodexTask): string {
  const taskInstruction =
    task.kind === "analyze-change"
      ? "Identify only the response-contract change represented by this diff and captured response."
      : "Propose the smallest semantically safe backend-only legacy repair and regression test. Do not weaken client validation.";

  return [
    "You are API Time Machine's advisory repair analyst.",
    "Work read-only. Do not edit files, run mutations, or claim a repair is verified.",
    taskInstruction,
    "Return only the JSON object required by the supplied output schema.",
    "Task input:",
    JSON.stringify(task),
  ].join("\n\n");
}

export function createCodexCliAdapter(
  options: CodexCliAdapterOptions,
  dependencies: CodexCliDependencies = defaultCliDependencies,
): CodexAdapter {
  return {
    async run(task) {
      const artifactId = dependencies.nextId();
      const artifactDirectory = resolve(options.artifactsRoot, artifactId);
      const schemaPath = resolve(artifactDirectory, "output-schema.json");
      const responsePath = resolve(artifactDirectory, "response.json");
      await dependencies.ensureDirectory(artifactDirectory);
      await dependencies.writeText(
        schemaPath,
        `${JSON.stringify(outputSchema(task), null, 2)}\n`,
      );

      const result = await dependencies.runCommand("codex", [
        "exec",
        "--ephemeral",
        "--sandbox",
        "read-only",
        "--ask-for-approval",
        "never",
        "--output-schema",
        schemaPath,
        "--output-last-message",
        responsePath,
        "-C",
        options.repositoryPath,
        promptFor(task),
      ]);
      if (result.exitCode !== 0) {
        throw new CodexCliError(
          `Codex analysis failed with exit code ${result.exitCode}: ${result.stderr || result.stdout}`,
        );
      }

      try {
        return JSON.parse(await dependencies.readText(responsePath));
      } catch (error) {
        throw new CodexCliError(
          `Codex returned invalid structured output: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}

export interface CodexWorkflow {
  analyzeChange(input: {
    diff: string;
    capturedResponse: CapturedResponse;
  }): Promise<ChangeProfile>;
  proposeRepair(input: {
    change: ChangeProfile;
    failures: ClientResult[];
  }): Promise<RepairProposal>;
}

export interface RepairAdvice {
  change: ChangeProfile;
  proposal: RepairProposal;
}

export function createCodexWorkflow(adapter: CodexAdapter): CodexWorkflow {
  return {
    async analyzeChange(input) {
      return ChangeProfileSchema.parse(
        await adapter.run({ kind: "analyze-change", ...input }),
      );
    },
    async proposeRepair(input) {
      return RepairProposalSchema.parse(
        await adapter.run({ kind: "propose-repair", ...input }),
      );
    },
  };
}

export async function adviseRepairForFailures(
  workflow: CodexWorkflow,
  input: {
    diff: string;
    capturedResponse: CapturedResponse;
    clients: ClientResult[];
  },
): Promise<RepairAdvice | null> {
  const failures = input.clients.filter(
    (client) => client.status === "incompatible",
  );
  if (failures.length === 0) {
    return null;
  }

  const change = await workflow.analyzeChange({
    diff: input.diff,
    capturedResponse: input.capturedResponse,
  });
  const proposal = await workflow.proposeRepair({ change, failures });

  return { change, proposal };
}
