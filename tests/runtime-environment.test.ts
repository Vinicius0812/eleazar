import { describe, expect, it } from "vitest";

import { operationalEnvironment } from "../src/adapters/runtime-environment.js";

describe("operationalEnvironment", () => {
  it("copies only defined allowlisted values without mutating source", () => {
  const source: NodeJS.ProcessEnv = {
    PATH: "synthetic-path",
    HOME: "synthetic-home",
    TEMP: "synthetic-temp",
    LANG: "synthetic-lang",
    API_KEY: "synthetic-credential",
    CLAUDE_CODE_OAUTH_TOKEN: "synthetic-token",
    UNRELATED: "synthetic-extra",
    TMP: undefined
  };
  const before = { ...source };

  const result = operationalEnvironment(source);

  expect(result).toEqual({
    PATH: "synthetic-path",
    HOME: "synthetic-home",
    TEMP: "synthetic-temp",
    LANG: "synthetic-lang"
  });
    expect(source).toEqual(before);
    expect(Object.hasOwn(result, "TMP")).toBe(false);
    expect(Object.hasOwn(result, "API_KEY")).toBe(false);
    expect(Object.hasOwn(result, "CLAUDE_CODE_OAUTH_TOKEN")).toBe(false);
    expect(Object.hasOwn(result, "UNRELATED")).toBe(false);
    expect(Object.values(result).some((value) => value === undefined)).toBe(false);
  });
});
