import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs"
import { resolve, join } from "node:path"

// Include the production dependency tree conservatively; bundling can remove code.
const visited = new Set<string>()
const sections: string[] = [
  "API Network Recorder - third-party notices\n\nRuntime: Bun 1.3.14.\nApplication source and rebuild instructions: https://github.com/jlozoya/api-network-recorder\nBun source: https://github.com/oven-sh/bun/tree/bun-v1.3.14\nWebKit source and relinking instructions: https://bun.sh/docs/project/license\nTo replace the runtime, build Bun from source and use --compile-executable-path with scripts/build-native.ts.\n",
]
const collect = (name: string) => {
  if (visited.has(name)) return
  visited.add(name)
  const folder = resolve("node_modules", name)
  if (!existsSync(folder)) return
  const pkg = JSON.parse(readFileSync(join(folder, "package.json"), "utf8"))
  const files = readdirSync(folder).filter((file) =>
    /^(licen[cs]e|copying|notice)(\.|$)/i.test(file),
  )
  sections.push(
    `${pkg.name}@${pkg.version} (${pkg.license || "See upstream license"})\n${files.map((file) => readFileSync(join(folder, file), "utf8")).join("\n") || pkg.homepage || "See the package source for licensing details."}`,
  )
  for (const dependency of Object.keys(pkg.dependencies || {})) collect(dependency)
}
for (const dependency of Object.keys(JSON.parse(readFileSync("package.json", "utf8")).dependencies))
  collect(dependency)
for (const file of ["LICENSE.md"]) {
  const response = await fetch(`https://raw.githubusercontent.com/oven-sh/bun/bun-v1.3.14/${file}`)
  if (!response.ok) throw new Error(`Could not read Bun ${file}`)
  sections.push(`Bun 1.3.14 ${file}\n${await response.text()}`)
}
writeFileSync(
  "THIRD_PARTY_NOTICES.txt",
  sections
    .join("\n\n============================================================\n\n")
    .replaceAll("\r\n", "\n")
    .replace(/[ \t]+$/gm, ""),
)
console.log(`Included notices for ${visited.size} production dependencies and Bun`)
