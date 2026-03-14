import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildConfigDocBaseline,
  normalizeConfigDocBaselineHelpPath,
  renderConfigDocBaselineStatefile,
  writeConfigDocBaselineStatefile,
} from "./doc-baseline.js";

describe("config doc baseline", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempRoots.splice(0).map(async (tempRoot) => {
        await fs.rm(tempRoot, { recursive: true, force: true });
      }),
    );
  });

  it("is deterministic across repeated runs", async () => {
    const first = await renderConfigDocBaselineStatefile();
    const second = await renderConfigDocBaselineStatefile();

    expect(second.json).toBe(first.json);
    expect(second.jsonl).toBe(first.jsonl);
  });

  it("normalizes array and record paths to wildcard form", async () => {
    const baseline = await buildConfigDocBaseline();
    const paths = new Set(baseline.entries.map((entry) => entry.path));

    expect(paths.has("session.sendPolicy.rules.*.match.keyPrefix")).toBe(true);
    expect(paths.has("env.*")).toBe(true);
    expect(normalizeConfigDocBaselineHelpPath("agents.list[].skills")).toBe("agents.list.*.skills");
  });

  it("includes core, channel, and plugin config metadata", async () => {
    const baseline = await buildConfigDocBaseline();
    const byPath = new Map(baseline.entries.map((entry) => [entry.path, entry]));

    expect(byPath.get("gateway.auth.token")).toMatchObject({
      kind: "core",
      sensitive: true,
    });
    expect(byPath.get("channels.telegram.botToken")).toMatchObject({
      kind: "channel",
      sensitive: true,
    });
    expect(byPath.get("plugins.entries.voice-call.config.twilio.authToken")).toMatchObject({
      kind: "plugin",
      sensitive: true,
    });
  });

  it("preserves help text and tags from merged schema hints", async () => {
    const baseline = await buildConfigDocBaseline();
    const byPath = new Map(baseline.entries.map((entry) => [entry.path, entry]));
    const tokenEntry = byPath.get("gateway.auth.token");

    expect(tokenEntry?.help).toContain("gateway access");
    expect(tokenEntry?.tags).toContain("auth");
    expect(tokenEntry?.tags).toContain("security");
  });

  it("supports check mode for stale generated artifacts", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-config-doc-baseline-"));
    tempRoots.push(tempRoot);

    const initial = await writeConfigDocBaselineStatefile({
      repoRoot: tempRoot,
      jsonPath: "docs/.generated/config-baseline.json",
      statefilePath: "docs/.generated/config-baseline.jsonl",
    });
    expect(initial.wrote).toBe(true);

    const current = await writeConfigDocBaselineStatefile({
      repoRoot: tempRoot,
      jsonPath: "docs/.generated/config-baseline.json",
      statefilePath: "docs/.generated/config-baseline.jsonl",
      check: true,
    });
    expect(current.changed).toBe(false);

    await fs.writeFile(
      path.join(tempRoot, "docs/.generated/config-baseline.json"),
      '{"generatedBy":"broken","entries":[]}\n',
      "utf8",
    );
    await fs.writeFile(
      path.join(tempRoot, "docs/.generated/config-baseline.jsonl"),
      '{"recordType":"meta","generatedBy":"broken","totalPaths":0}\n',
      "utf8",
    );

    const stale = await writeConfigDocBaselineStatefile({
      repoRoot: tempRoot,
      jsonPath: "docs/.generated/config-baseline.json",
      statefilePath: "docs/.generated/config-baseline.jsonl",
      check: true,
    });
    expect(stale.changed).toBe(true);
    expect(stale.wrote).toBe(false);
  });
});
