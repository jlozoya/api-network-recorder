import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { createHash } from "node:crypto"
import skill from "../skills/api-network-recorder/SKILL.md" with { type: "text" }
import metadata from "../skills/api-network-recorder/agents/openai.yaml" with { type: "text" }
import client from "../skills/api-network-recorder/scripts/invoke-recorder.ps1" with { type: "text" }
import unixClient from "../skills/api-network-recorder/scripts/invoke-recorder.sh" with { type: "text" }

export const skillAssets: Record<string, string> = {
  "SKILL.md": skill,
  "agents/openai.yaml": metadata,
  "scripts/invoke-recorder.ps1": client,
  "scripts/invoke-recorder.sh": unixClient.replaceAll("\r\n", "\n"),
}
const MARKER = ".api-network-recorder-managed.json"
const digest = (content: string) => createHash("sha256").update(content).digest("hex")
const skillDirectory = (codexDirectory: string) =>
  join(codexDirectory, "skills", "api-network-recorder")
const readHashes = (directory: string): Record<string, string> => {
  const data = JSON.parse(readFileSync(join(directory, MARKER), "utf8"))
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error("Invalid skill installation marker")
  return data
}

export const installAgentSkill = (codexDirectory: string): void => {
  const directory = skillDirectory(codexDirectory)
  // Preserve a skill installed manually under the same name.
  if (existsSync(directory) && !existsSync(join(directory, MARKER))) return
  const hashes = existsSync(join(directory, MARKER)) ? readHashes(directory) : {}
  for (const [relative, content] of Object.entries(skillAssets)) {
    const path = join(directory, relative)
    if (existsSync(path)) {
      const current = readFileSync(path, "utf8")
      if (digest(current) !== hashes[relative] && current !== content) continue
    }
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content, "utf8")
    hashes[relative] = digest(content)
  }
  writeFileSync(join(directory, MARKER), JSON.stringify(hashes, null, 2), "utf8")
}

export const removeAgentSkill = (codexDirectory: string): void => {
  const directory = skillDirectory(codexDirectory)
  if (!existsSync(join(directory, MARKER))) return
  const hashes = readHashes(directory)
  // Only remove this installer's known, unchanged files; preserve user additions.
  for (const relative of Object.keys(skillAssets)) {
    const path = join(directory, relative)
    if (existsSync(path) && digest(readFileSync(path, "utf8")) === hashes[relative])
      unlinkSync(path)
  }
  unlinkSync(join(directory, MARKER))
  for (const folder of ["agents", "scripts", ""]) {
    try {
      rmdirSync(join(directory, folder))
    } catch {
      /* User files remain. */
    }
  }
}
