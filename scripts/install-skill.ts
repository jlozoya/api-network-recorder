import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { installAgentSkill } from "../native/skill.js"

const codexDirectory = resolve(process.env.CODEX_HOME || join(homedir(), ".codex"))
installAgentSkill(codexDirectory)
console.log(`Skill available at ${join(codexDirectory, "skills", "api-network-recorder")}`)
