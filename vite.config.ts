import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { defineConfig } from "vite"

import { manifest as chromeManifest } from "./manifest.chrome.config.js"
import { manifest as firefoxManifest } from "./manifest.firefox.config.js"

const browserTarget = process.env.BROWSER_TARGET === "firefox" ? "firefox" : "chrome"
const outDir = resolve("dist", browserTarget)
const manifest = browserTarget === "firefox" ? firefoxManifest : chromeManifest

const ensureDir = (path: string): void => {
  mkdirSync(path, { recursive: true })
}

const copyFile = (from: string, to: string): void => {
  if (!existsSync(from)) {
    throw new Error(`Missing file: ${from}`)
  }

  ensureDir(dirname(to))
  copyFileSync(from, to)
}

const writeManifest = (): void => {
  writeFileSync(resolve(outDir, "manifest.json"), JSON.stringify(manifest, null, 2))
}

const copyIcons = (): void => {
  for (const size of [16, 48, 128]) {
    copyFile(
      resolve("public", "icons", `icon-${size}.png`),
      resolve(outDir, "icons", `icon-${size}.png`),
    )
  }
}

const normalizeHtmlOutputs = (): void => {
  const generatedPopupHtml = resolve(outDir, "src", "popup", "popup.html")
  const generatedAppHtml = resolve(outDir, "src", "app", "index.html")

  copyFile(generatedPopupHtml, resolve(outDir, "popup.html"))
  copyFile(generatedAppHtml, resolve(outDir, "app.html"))

  rmSync(resolve(outDir, "src"), {
    recursive: true,
    force: true,
  })
}

export default defineConfig({
  define: {
    __BROWSER_TARGET__: JSON.stringify(browserTarget),
    __SUPPORTS_DEEP_CAPTURE__: JSON.stringify(browserTarget === "chrome"),
  },
  build: {
    outDir,
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        background: resolve("src/background/index.ts"),
        content: resolve("src/content/index.ts"),
        popup: resolve("src/popup/popup.html"),
        app: resolve("src/app/index.html"),
      },
      output: {
        entryFileNames: "assets/[name].js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  plugins: [
    {
      name: "build-browser-extension-files",
      closeBundle() {
        ensureDir(outDir)
        writeManifest()
        copyIcons()
        normalizeHtmlOutputs()
      },
    },
  ],
})