import { test, expect } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installAgentSkill, removeAgentSkill, skillAssets } from "../native/skill.ts"

test("skill installation includes the MCP client and removal preserves customized instructions", () => {
  const root = mkdtempSync(join(tmpdir(), "recorder-skill-test-"))
  const directory = join(root, "skills", "api-network-recorder")
  try {
    installAgentSkill(root)
    for (const [relative, content] of Object.entries(skillAssets)) {
      expect(readFileSync(join(directory, relative), "utf8")).toBe(content)
    }
    writeFileSync(join(directory, "SKILL.md"), "User customized instructions")
    writeFileSync(join(directory, "personal.md"), "User notes")
    installAgentSkill(root)
    expect(readFileSync(join(directory, "SKILL.md"), "utf8")).toBe("User customized instructions")
    removeAgentSkill(root)
    expect(readFileSync(join(directory, "SKILL.md"), "utf8")).toBe("User customized instructions")
    expect(readFileSync(join(directory, "personal.md"), "utf8")).toBe("User notes")
    expect(existsSync(join(directory, "scripts", "invoke-recorder.ps1"))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("skill installation and removal preserve an existing unmanaged skill", () => {
  const root = mkdtempSync(join(tmpdir(), "recorder-skill-unmanaged-"))
  const directory = join(root, "skills", "api-network-recorder")
  try {
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, "SKILL.md"), "Existing user skill")
    installAgentSkill(root)
    removeAgentSkill(root)
    expect(readFileSync(join(directory, "SKILL.md"), "utf8")).toBe("Existing user skill")
    expect(existsSync(join(directory, "scripts"))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
