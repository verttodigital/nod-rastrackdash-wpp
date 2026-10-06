import { describe, expect, it } from "vitest";
import { parseProvisionArgs } from "../../src/scripts/provision-report-sync";

describe("report sync setup command", () => {
  it("defaults to a dry run and refuses accidental writes", () => {
    expect(parseProvisionArgs([])).toEqual({ apply: false });
    expect(() => parseProvisionArgs(["--apply"])).toThrow(
      "expected_rules_required",
    );
    expect(() =>
      parseProvisionArgs(["--apply", "--expected-rules", "3"]),
    ).toThrow("expected_rules_required");
  });
  it("requires the concrete six-rule apply scope", () => {
    expect(parseProvisionArgs(["--apply", "--expected-rules", "6"])).toEqual({
      apply: true,
      expectedRules: 6,
    });
  });
  it("rejects secrets and unknown arguments without echoing their values", () => {
    expect(() => parseProvisionArgs(["--token", "private-value"])).toThrow(
      "unknown_argument",
    );
    expect(() => parseProvisionArgs(["--workspace", "other"])).toThrow(
      "unknown_argument",
    );
  });
});
