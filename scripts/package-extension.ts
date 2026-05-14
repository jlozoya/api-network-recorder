import AdmZip from "adm-zip"
import fs from "node:fs"
import path from "node:path"
import process from "node:process"

type BrowserTarget = "chrome" | "firefox"

interface PackageJson {
  name?: string
  version?: string
}

interface ExtensionManifest {
  version?: string
  [key: string]: unknown
}

const rootDir = process.cwd()
const distRootDir = path.join(rootDir, "dist")
const outputDir = path.join(rootDir, "release")
const packageJsonPath = path.join(rootDir, "package.json")

const browserTargets: BrowserTarget[] = ["chrome", "firefox"]

const readJsonFile = <T>(filePath: string): T => {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T
}

const ensureFileExists = (filePath: string, message: string): void => {
  if (!fs.existsSync(filePath)) {
    throw new Error(message)
  }
}

const ensureDirectoryExists = (directoryPath: string, message: string): void => {
  if (!fs.existsSync(directoryPath) || !fs.statSync(directoryPath).isDirectory()) {
    throw new Error(message)
  }
}

const getRequestedTargets = (): BrowserTarget[] => {
  const rawTarget = process.env.BROWSER_TARGET

  if (!rawTarget || rawTarget === "all") {
    return browserTargets
  }

  if (rawTarget === "chrome" || rawTarget === "firefox") {
    return [rawTarget]
  }

  throw new Error(`Invalid BROWSER_TARGET "${rawTarget}". Use "chrome", "firefox", or "all".`)
}

const updateManifestVersion = (manifestPath: string, version: string): void => {
  const manifest = readJsonFile<ExtensionManifest>(manifestPath)

  manifest.version = version

  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

const getAllFiles = (directoryPath: string): string[] => {
  const entries = fs.readdirSync(directoryPath, {
    withFileTypes: true,
  })

  return entries.flatMap((entry) => {
    const entryPath = path.join(directoryPath, entry.name)

    if (entry.isDirectory()) {
      return getAllFiles(entryPath)
    }

    if (entry.isFile()) {
      return [entryPath]
    }

    return []
  })
}

const createZip = (sourceDir: string, zipPath: string): number => {
  if (fs.existsSync(zipPath)) {
    fs.rmSync(zipPath)
  }

  const zip = new AdmZip()
  const files = getAllFiles(sourceDir)

  for (const filePath of files) {
    const relativePath = path.relative(sourceDir, filePath).replaceAll(path.sep, "/")
    const zipDirectory = path.dirname(relativePath)

    zip.addLocalFile(filePath, zipDirectory === "." ? undefined : zipDirectory)
  }

  zip.writeZip(zipPath)

  return fs.statSync(zipPath).size
}

const packageTarget = (
  target: BrowserTarget,
  packageName: string,
  packageVersion: string,
): void => {
  const targetDistDir = path.join(distRootDir, target)
  const manifestPath = path.join(targetDistDir, "manifest.json")

  ensureDirectoryExists(
    targetDistDir,
    `dist/${target} folder not found. Run bun run build:${target} first.`,
  )

  ensureFileExists(
    manifestPath,
    `dist/${target}/manifest.json not found. Run bun run build:${target} first.`,
  )

  updateManifestVersion(manifestPath, packageVersion)

  fs.mkdirSync(outputDir, {
    recursive: true,
  })

  const zipName = `${packageName}-${target}-${packageVersion}.zip`
  const zipPath = path.join(outputDir, zipName)
  const sizeBytes = createZip(targetDistDir, zipPath)

  console.log(`Updated dist/${target}/manifest.json version to ${packageVersion}`)
  console.log(`Created ${path.relative(rootDir, zipPath)}`)
  console.log(`Size: ${(sizeBytes / 1024).toFixed(1)} KB`)
}

ensureFileExists(packageJsonPath, "package.json not found")
ensureDirectoryExists(
  distRootDir,
  "dist folder not found. Run bun run build:chrome or bun run build:firefox first.",
)

const packageJson = readJsonFile<PackageJson>(packageJsonPath)
const packageName = packageJson.name ?? "browser-extension"
const packageVersion = packageJson.version ?? "0.0.0"
const requestedTargets = getRequestedTargets()

for (const target of requestedTargets) {
  packageTarget(target, packageName, packageVersion)
}