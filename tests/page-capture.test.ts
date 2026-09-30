import { expect, test } from "bun:test"
import { createContext, Script } from "node:vm"
import { resolve } from "node:path"

const bundle = Bun.build({
  entrypoints: [resolve("src/background/debugger/page-capture.ts")],
  target: "browser",
  format: "cjs",
})
const createRegistration = async () => {
  const scripts = new Map<string, any>()
  const registrations: any[] = []
  let finishRegistration: (() => void) | null = null
  let blockRegistration = false
  const exports = {}
  const context = createContext({
    exports,
    module: { exports },
    setTimeout,
    clearTimeout,
    chrome: {
      scripting: {
        getRegisteredContentScripts: async () => [...scripts.values()],
        registerContentScripts: async (items: any[]) => {
          registrations.push(...items)
          if (blockRegistration)
            await new Promise<void>((resolve) => {
              finishRegistration = resolve
            })
          for (const item of items) scripts.set(item.id, item)
        },
        unregisterContentScripts: async ({ ids }: { ids: string[] }) => {
          ids.forEach((id) => scripts.delete(id))
        },
      },
    },
  })
  const result = await bundle
  if (!result.success) throw new Error(String(result.logs))
  new Script(await result.outputs[0]!.text()).runInContext(context)
  return {
    sync: (context.module.exports as any).syncPageCapture,
    scripts,
    registrations,
    block: () => {
      blockRegistration = true
    },
    release: () => {
      finishRegistration?.()
    },
  }
}

test("early page capture is registered once at document_start and removed on stop", async () => {
  const state = await createRegistration()
  await Promise.all([state.sync(true), state.sync(true)])
  expect(state.registrations).toHaveLength(1)
  expect(state.registrations[0]).toMatchObject({
    js: ["assets/injected.js"],
    runAt: "document_start",
    world: "MAIN",
    allFrames: true,
    persistAcrossSessions: true,
  })
  await state.sync(false)
  expect(state.scripts.size).toBe(0)
})

test("stop waits for an in-progress registration before removing its hooks", async () => {
  const state = await createRegistration()
  state.block()
  const starting = state.sync(true)
  await new Promise((resolve) => setTimeout(resolve, 0))
  const stopping = state.sync(false)
  state.release()
  await Promise.all([starting, stopping])
  expect(state.scripts.size).toBe(0)
})
