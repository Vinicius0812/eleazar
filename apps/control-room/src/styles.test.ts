import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("Control Room typography", () => {
  it("does not declare font sizes below 12px", async () => {
    const stylesheet = await readFile(resolve(process.cwd(), "src", "styles.css"), "utf8");
    const sizes = [...stylesheet.matchAll(/font-size:\s*(\d+)px/g), ...stylesheet.matchAll(/font:\s*(\d+)px/g)].map((match) => Number(match[1]));
    expect(sizes.length).toBeGreaterThan(0);
    expect(sizes.every((size) => size >= 12)).toBe(true);
  });

  it("defines semantic themes for the complete interface", async () => {
    const stylesheet = await readFile(resolve(process.cwd(), "src", "styles.css"), "utf8");
    expect(stylesheet).toContain("--surface:");
    expect(stylesheet).toContain(":root[data-theme=\"dark\"]");
    expect(stylesheet).toContain(".markdown-output pre");
    expect(stylesheet).not.toContain("var(--muted)");
    expect(stylesheet).toContain(":root[data-theme=\"dark\"] tr:hover td");
    expect(stylesheet).toContain(":root[data-theme=\"dark\"] .execution-meta");
  });
});
