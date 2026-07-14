import { mkdir, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";

import type {
  CapturedResponse,
  ClientResult,
  CompatibilityRun,
} from "@atm/contracts";

export interface EvidenceBundleInput {
  run: CompatibilityRun;
  captures: CapturedResponse[];
  releaseCommits: Record<string, string | null>;
}

export interface EvidenceBundle {
  directory: string;
  manifestPath: string;
  matrixPath: string;
}

export interface EvidenceDependencies {
  ensureDirectory(path: string): Promise<void>;
  writeText(path: string, contents: string): Promise<void>;
}

export class EvidenceBundleError extends Error {
  override readonly name = "EvidenceBundleError";
}

const defaultDependencies: EvidenceDependencies = {
  async ensureDirectory(path) {
    await mkdir(path, { recursive: true });
  },
  writeText(path, contents) {
    return writeFile(path, contents, "utf8");
  },
};

function safePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function resultLabel(result: ClientResult): string {
  switch (result.status) {
    case "compatible":
      return "Compatible";
    case "incompatible":
      return "Incompatible";
    case "inconclusive":
      return "Inconclusive";
  }
}

function renderMatrix(input: EvidenceBundleInput): string {
  const lines = [
    `# API Time Machine — ${input.run.runId}`,
    "",
    `Gate status: **${input.run.status}**`,
    `Configured blast radius: **${(input.run.blastRadius * 100).toFixed(2)}%**`,
    "",
    "| App version | Git tag | Commit | Result | Configured share | Response SHA-256 |",
    "| --- | --- | --- | --- | ---: | --- |",
  ];

  for (const result of input.run.clients) {
    const commit = input.releaseCommits[result.release.version] ?? "unavailable";
    lines.push(
      `| ${result.release.version} | ${result.release.gitTag} | ${commit} | ${resultLabel(result)} | ${(result.release.activeShare * 100).toFixed(2)}% | ${result.responseSha256} |`,
    );
  }

  return `${lines.join("\n")}\n`;
}

function validateEvidence(input: EvidenceBundleInput): void {
  if (input.captures.length === 0) {
    throw new EvidenceBundleError("An evidence bundle requires captured responses.");
  }

  const captureHashes = new Set(input.captures.map((capture) => capture.sha256));

  for (const result of input.run.clients) {
    if (!captureHashes.has(result.responseSha256)) {
      throw new EvidenceBundleError(
        `No captured response matches ${result.release.version} response hash ${result.responseSha256}.`,
      );
    }

    const commitSha = input.releaseCommits[result.release.version];
    if (commitSha !== null && !/^[a-f0-9]{40}$/i.test(commitSha ?? "")) {
      throw new EvidenceBundleError(
        `Evidence has an invalid commit SHA for ${result.release.version}.`,
      );
    }
  }
}

export async function writeEvidenceBundle(
  runsRoot: string,
  input: EvidenceBundleInput,
  dependencies: EvidenceDependencies = defaultDependencies,
): Promise<EvidenceBundle> {
  validateEvidence(input);

  const safeRunId = safePathSegment(input.run.runId);
  if (!safeRunId) {
    throw new EvidenceBundleError("Evidence requires a non-empty run ID.");
  }

  const root = resolve(runsRoot);
  const directory = resolve(root, safeRunId);
  if (relative(root, directory).startsWith("..")) {
    throw new EvidenceBundleError("Evidence directory must remain inside runs root.");
  }

  const capturesDirectory = resolve(directory, "captures");
  await dependencies.ensureDirectory(capturesDirectory);

  const manifestPath = resolve(directory, "manifest.json");
  const matrixPath = resolve(directory, "survival-matrix.md");
  const manifest = {
    schemaVersion: 1,
    run: input.run,
    releaseCommits: input.releaseCommits,
    captures: input.captures.map((capture) => ({
      sha256: capture.sha256,
      path: `captures/${capture.sha256}.json`,
    })),
  };

  await Promise.all([
    dependencies.writeText(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`),
    dependencies.writeText(matrixPath, renderMatrix(input)),
    ...input.captures.map((capture) =>
      dependencies.writeText(
        resolve(capturesDirectory, `${capture.sha256}.json`),
        `${JSON.stringify(capture, null, 2)}\n`,
      ),
    ),
  ]);

  return { directory, manifestPath, matrixPath };
}
