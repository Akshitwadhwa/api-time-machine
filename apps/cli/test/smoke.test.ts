import { describe, expect, it } from "vitest";

import { runScaffoldSmoke } from "../src/smoke.js";

describe("breaking vertical smoke", () => {
  it("proves the real backend response breaks the strict release 1.0 parser", async () => {
    const run = await runScaffoldSmoke();

    expect(run.status).toBe("incompatible");
    expect(run.blastRadius).toBe(0.18);
    expect(run.clients).toHaveLength(1);
    expect(run.clients[0]?.responseSha256).toMatch(/^[a-f0-9]{64}$/);
    console.log(JSON.stringify(run, null, 2));
  });
});
