import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addAllowlistEntry,
  ensureExecApprovals,
  matchAllowlist,
  type ExecAllowlistEntry,
  type ExecApprovalsFile,
} from "./exec-approvals.js";

const tempDirs: string[] = [];
const originalHome = process.env.HOME;

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exec-approvals-test-"));
  tempDirs.push(dir);
  return dir;
}

beforeEach(() => {});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createHomeDir(): string {
  const dir = makeTempDir();
  process.env.HOME = dir;
  return dir;
}

function approvalsFilePath(homeDir: string): string {
  return path.join(homeDir, ".openclaw", "exec-approvals.json");
}

function readApprovalsFile(homeDir: string): ExecApprovalsFile {
  return JSON.parse(fs.readFileSync(approvalsFilePath(homeDir), "utf8")) as ExecApprovalsFile;
}

describe("exact-match allowlist entries", () => {
  const baseResolution = {
    rawExecutable: "python3",
    resolvedPath: "/usr/bin/python3",
    executableName: "python3",
  };

  it("exact-match entry matches only when path AND args match", () => {
    const entry: ExecAllowlistEntry = {
      pattern: "/usr/bin/python3",
      args: ["safe.py"],
      matchMode: "exact",
    };
    const match = matchAllowlist([entry], baseResolution, ["python3", "safe.py"]);
    expect(match).toBe(entry);
  });

  it("exact-match entry rejects when args differ", () => {
    const entry: ExecAllowlistEntry = {
      pattern: "/usr/bin/python3",
      args: ["safe.py"],
      matchMode: "exact",
    };
    const match = matchAllowlist([entry], baseResolution, ["python3", "evil.py"]);
    expect(match).toBeNull();
  });

  it("exact-match entry rejects when arg count differs", () => {
    const entry: ExecAllowlistEntry = {
      pattern: "/usr/bin/python3",
      args: ["safe.py"],
      matchMode: "exact",
    };
    // Extra args
    const match1 = matchAllowlist([entry], baseResolution, ["python3", "safe.py", "--verbose"]);
    expect(match1).toBeNull();
    // No args
    const match2 = matchAllowlist([entry], baseResolution, ["python3"]);
    expect(match2).toBeNull();
  });

  it("path-only entries (no matchMode) match any args for backward compat", () => {
    const entry: ExecAllowlistEntry = {
      pattern: "/usr/bin/python3",
    };
    expect(matchAllowlist([entry], baseResolution, ["python3", "safe.py"])).toBe(entry);
    expect(matchAllowlist([entry], baseResolution, ["python3", "evil.py"])).toBe(entry);
    expect(matchAllowlist([entry], baseResolution, ["python3"])).toBe(entry);
  });

  it("exact-match entry with null args matches any args (like path-only)", () => {
    const entry: ExecAllowlistEntry = {
      pattern: "/usr/bin/python3",
      args: null,
      matchMode: "exact",
    };
    expect(matchAllowlist([entry], baseResolution, ["python3", "safe.py"])).toBe(entry);
    expect(matchAllowlist([entry], baseResolution, ["python3", "evil.py"])).toBe(entry);
  });

  it("exact-match entry with empty args matches only bare binary invocation", () => {
    const entry: ExecAllowlistEntry = {
      pattern: "/usr/bin/python3",
      args: [],
      matchMode: "exact",
    };
    expect(matchAllowlist([entry], baseResolution, ["python3"])).toBe(entry);
    expect(matchAllowlist([entry], baseResolution, ["python3", "safe.py"])).toBeNull();
  });

  it("exact-match respects order and content of all args", () => {
    const entry: ExecAllowlistEntry = {
      pattern: "/usr/bin/python3",
      args: ["-m", "pytest", "tests/"],
      matchMode: "exact",
    };
    expect(matchAllowlist([entry], baseResolution, ["python3", "-m", "pytest", "tests/"])).toBe(
      entry,
    );
    expect(
      matchAllowlist([entry], baseResolution, ["python3", "pytest", "-m", "tests/"]),
    ).toBeNull();
  });
});

describe("dedup on pattern+args combo", () => {
  it("deduplicates entries with same pattern and args", () => {
    const dir = createHomeDir();
    vi.spyOn(Date, "now").mockReturnValue(100_000);

    const approvals = ensureExecApprovals();
    addAllowlistEntry(approvals, "worker", "/usr/bin/python3", ["safe.py"]);
    addAllowlistEntry(approvals, "worker", "/usr/bin/python3", ["safe.py"]);

    const file = readApprovalsFile(dir);
    expect(file.agents?.worker?.allowlist).toHaveLength(1);
    expect(file.agents?.worker?.allowlist?.[0]).toEqual(
      expect.objectContaining({
        pattern: "/usr/bin/python3",
        args: ["safe.py"],
        matchMode: "exact",
      }),
    );
  });

  it("allows separate entries for same binary with different args", () => {
    const dir = createHomeDir();
    vi.spyOn(Date, "now").mockReturnValue(100_000);

    const approvals = ensureExecApprovals();
    addAllowlistEntry(approvals, "worker", "/usr/bin/python3", ["safe.py"]);
    addAllowlistEntry(approvals, "worker", "/usr/bin/python3", ["other.py"]);

    const file = readApprovalsFile(dir);
    expect(file.agents?.worker?.allowlist).toHaveLength(2);
    expect(file.agents?.worker?.allowlist?.[0]?.args).toEqual(["safe.py"]);
    expect(file.agents?.worker?.allowlist?.[1]?.args).toEqual(["other.py"]);
  });

  it("allows bare and arg-specific exact-match entries for same binary", () => {
    const dir = createHomeDir();
    vi.spyOn(Date, "now").mockReturnValue(100_000);

    const approvals = ensureExecApprovals();
    addAllowlistEntry(approvals, "worker", "/usr/bin/python3");
    addAllowlistEntry(approvals, "worker", "/usr/bin/python3", ["safe.py"]);

    const file = readApprovalsFile(dir);
    expect(file.agents?.worker?.allowlist).toHaveLength(2);
    // Both entries are exact-match; bare command gets args: []
    expect(file.agents?.worker?.allowlist?.[0]?.matchMode).toBe("exact");
    expect(file.agents?.worker?.allowlist?.[0]?.args).toEqual([]);
    expect(file.agents?.worker?.allowlist?.[1]?.matchMode).toBe("exact");
    expect(file.agents?.worker?.allowlist?.[1]?.args).toEqual(["safe.py"]);
  });
});
