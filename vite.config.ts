import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { defineConfig } from "vite"

import { manifest } from "./manifest.config.js"

const outDir = "dist"

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
  build: {
    outDir,
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      input: {
        background: resolve("src/background/index.ts"),
        content: resolve("src/content/index.ts"),
        injected: resolve("src/injected/index.ts"),
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
      name: "build-chrome-extension-files",
      closeBundle() {
        ensureDir(resolve(outDir))
        writeManifest()
        copyIcons()
        normalizeHtmlOutputs()
      },
    },
  ],
})