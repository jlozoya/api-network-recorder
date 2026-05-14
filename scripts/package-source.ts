import AdmZip from "adm-zip"
import fs from "node:fs"
import path from "node:path"
import process from "node:process"

const rootDir = process.cwd()
const outputDir = path.join(rootDir, "release")
const packageJsonPath = path.join(rootDir, "package.json")

const excludedDirectories = new Set([
  ".git",
  ".vscode",
  "node_modules",
  "dist",
  "release",
])

const excludedFiles = new Set([
  ".DS_Store",
])

const includedRootFiles = new Set([
  ".gitignore",
  ".prettierignore",
  ".prettierrc.json",
  "bun.lock",
  "package.json",
  "tsconfig.json",
  "vite.config.ts",
  "manifest.chrome.config.ts",
  "manifest.firefox.config.ts",
  "README.md",
  "PRIVACY.md",
])

const includedRootDirectories = new Set([
  "src",
  "public",
  "scripts",
])

interface PackageJson {
  name?: string
  version?: string
}

const readJsonFile = <T>(filePath: string): T => {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T
}

const shouldInclude = (absolutePath: string): boolean => {
  const relativePath = path.relative(rootDir, absolutePath)
  const parts = relativePath.split(path.sep)
  const rootPart = parts[0]

  if (!rootPart) {
    return false
  }

  if (excludedDirectories.has(rootPart)) {
    return false
  }

  if (excludedFiles.has(path.basename(absolutePath))) {
    return false
  }

  if (includedRootDirectories.has(rootPart)) {
    return true
  }

  return parts.length === 1 && includedRootFiles.has(rootPart)
}

const addDirectory = (zip: AdmZip, directoryPath: string): void => {
  const entries = fs.readdirSync(directoryPath, {
    withFileTypes: true,
  })

  for (const entry of entries) {
    const absolutePath = path.join(directoryPath, entry.name)

    if (!shouldInclude(absolutePath)) {
      continue
    }

    if (entry.isDirectory()) {
      addDirectory(zip, absolutePath)
      continue
    }

    if (!entry.isFile()) {
      continue
    }

    const relativePath = path.relative(rootDir, absolutePath).replaceAll(path.sep, "/")
    const zipDirectory = path.dirname(relativePath)

    zip.addLocalFile(absolutePath, zipDirectory === "." ? undefined : zipDirectory)
  }
}

if (!fs.existsSync(packageJsonPath)) {
  throw new Error("package.json not found")
}

const packageJson = readJsonFile<PackageJson>(packageJsonPath)
const packageName = packageJson.name ?? "browser-extension"
const packageVersion = packageJson.version ?? "0.0.0"

fs.mkdirSync(outputDir, {
  recursive: true,
})

const zipName = `${packageName}-source-${packageVersion}.zip`
const zipPath = path.join(outputDir, zipName)

if (fs.existsSync(zipPath)) {
  fs.rmSync(zipPath)
}

const zip = new AdmZip()

addDirectory(zip, rootDir)

zip.addFile(
  "BUILD_INSTRUCTIONS.md",
  Buffer.from(
    `# Build Instructions

## Requirements

- Bun
- Node.js-compatible environment

## Install dependencies

\`\`\`bash
bun install
\`\`\`

## Build Firefox extension

\`\`\`bash
bun run build:firefox
\`\`\`

## Package Firefox extension

\`\`\`bash
bun run package:firefox
\`\`\`

## Expected output

\`\`\`text
release/${packageName}-firefox-${packageVersion}.zip
\`\`\`

The Firefox build output is generated in:

\`\`\`text
dist/firefox
\`\`\`

The submitted extension package should match the generated Firefox ZIP.
`,
    "utf8",
  ),
)

zip.writeZip(zipPath)

const sizeBytes = fs.statSync(zipPath).size

console.log(`Created ${path.relative(rootDir, zipPath)}`)
console.log(`Size: ${(sizeBytes / 1024).toFixed(1)} KB`)