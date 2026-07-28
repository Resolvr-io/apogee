import { describe, expect, it } from "vitest";
import { compareVersions, evaluateUpdate, parseTag } from "./version-check";

describe("parseTag", () => {
  it("strips a leading v", () => {
    expect(parseTag("v0.6.0")).toBe("0.6.0");
    expect(parseTag("0.6.0")).toBe("0.6.0");
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseTag("  v1.2.3\n")).toBe("1.2.3");
  });

  it("keeps only the version core, dropping any suffix", () => {
    expect(parseTag("v1.2.3-rc.1")).toBe("1.2.3");
    expect(parseTag("v2.0")).toBe("2.0");
  });

  it("returns null for a tag with no version, rather than defaulting to zero", () => {
    // A tag we can't read must not compare as 0.0.0 — that would make every
    // build look out of date (or up to date) on a malformed release name.
    expect(parseTag("latest")).toBeNull();
    expect(parseTag("")).toBeNull();
    expect(parseTag("release-candidate")).toBeNull();
  });
});

describe("compareVersions", () => {
  it("orders by numeric segment, not lexically", () => {
    // The case a string compare gets wrong: "0.10.0" < "0.9.0" as text.
    expect(compareVersions("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(compareVersions("0.9.0", "0.10.0")).toBeLessThan(0);
  });

  it("treats missing segments as zero", () => {
    expect(compareVersions("0.6", "0.6.0")).toBe(0);
    expect(compareVersions("1", "1.0.0")).toBe(0);
  });

  it("detects newer and older across each position", () => {
    expect(compareVersions("1.0.0", "0.9.9")).toBeGreaterThan(0);
    expect(compareVersions("0.7.0", "0.6.9")).toBeGreaterThan(0);
    expect(compareVersions("0.6.1", "0.6.0")).toBeGreaterThan(0);
    expect(compareVersions("0.6.0", "0.6.0")).toBe(0);
  });

  it("does not claim an ordering it can't determine", () => {
    expect(compareVersions("abc", "0.6.0")).toBe(0);
  });
});

describe("evaluateUpdate", () => {
  it("reports an available update", () => {
    expect(evaluateUpdate("v0.7.0", "0.6.0")).toEqual({ latest: "0.7.0", newer: true });
  });

  it("reports up to date on an equal version", () => {
    expect(evaluateUpdate("v0.6.0", "0.6.0")).toEqual({ latest: "0.6.0", newer: false });
  });

  it("does not report an update when the running build is ahead of the release", () => {
    // A local/dev build past the last tag must not be told to downgrade.
    expect(evaluateUpdate("v0.6.0", "0.7.0")).toEqual({ latest: "0.6.0", newer: false });
  });

  it("ignores the commit suffix on a dev version string", () => {
    // APP_VERSION_DISPLAY is "0.6.0 (abc1234)"; the bare version must win out.
    expect(evaluateUpdate("v0.6.0", "0.6.0 (abc1234)")).toEqual({
      latest: "0.6.0",
      newer: false,
    });
  });

  it("returns null when either side is unreadable", () => {
    expect(evaluateUpdate("latest", "0.6.0")).toBeNull();
    expect(evaluateUpdate("v0.6.0", "unknown")).toBeNull();
  });
});
