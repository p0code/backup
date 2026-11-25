import { describe, expect, it } from "vitest";

import { backupName, parseBackupName, selectForDeletion } from "./backups.ts";

const at = (iso: string) => Date.parse(iso);

describe("backup names", () => {
  it("round-trips the environment and time", () => {
    const name = backupName("env-1a2b", at("2026-11-25T08:09:10.123Z"));
    expect(name).toBe("p0code-env-1a2b-20261125T080910Z.p0bak");
    expect(parseBackupName(name)).toEqual({
      environmentId: "env-1a2b",
      createdAt: at("2026-11-25T08:09:10Z"),
    });
  });

  it("ignores names it did not make", () => {
    for (const name of ["notes.txt", "p0code-x-2026.p0bak", "p0code--20261125T080910Z.p0bak"]) {
      expect(parseBackupName(name)).toBeNull();
    }
  });
});

describe("retention", () => {
  const mine = (iso: string) => backupName("env-a", at(iso));
  const names = [
    mine("2026-11-20T00:00:00Z"),
    mine("2026-11-23T00:00:00Z"),
    mine("2026-11-21T00:00:00Z"),
    mine("2026-11-22T00:00:00Z"),
    backupName("env-a-old", at("2026-01-01T00:00:00Z")),
    backupName("env-b", at("2026-01-01T00:00:00Z")),
    "unrelated.bin",
  ];

  it("keeps the newest N of this environment's backups", () => {
    expect(selectForDeletion(names, "env-a", 2)).toEqual([
      mine("2026-11-21T00:00:00Z"),
      mine("2026-11-20T00:00:00Z"),
    ]);
  });

  it("never touches other environments or files it did not name", () => {
    const deleted = selectForDeletion(names, "env-a", 1);
    expect(deleted).toHaveLength(3);
    expect(deleted.every((name) => parseBackupName(name)?.environmentId === "env-a")).toBe(true);
  });

  it("always keeps at least one", () => {
    expect(selectForDeletion(names, "env-a", 0)).toHaveLength(3);
    expect(selectForDeletion(names, "env-a", 10)).toEqual([]);
  });
});
