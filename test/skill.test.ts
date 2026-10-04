import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { createSkillMarkdown } from "../src/skill.js";

describe("skill", () => {
  it("matches the committed SKILL.md", () => {
    const path = fileURLToPath(new URL("../skills/orca-axi/SKILL.md", import.meta.url));
    expect(readFileSync(path, "utf8")).toBe(createSkillMarkdown());
  });
});
