import { mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { z } from "zod"
import { appDirectory, loadConfig, replayOriginSchema } from "./config.js"
import { callExtension } from "./client.js"
import type { NetworkRecord } from "../src/core/network-types.js"
import {
  replayInputSchema,
  buildReplayPlan,
  previewReplay,
  sendReplay,
  type ReplayResult,
} from "./replay.js"

export const replayTools = {
  prepare_replay: {
    description:
      "Preview one captured HTTP request with explicit authentication, optional edits and a requestHash. Sends no HTTP. Credential header values are redacted. Bodies and URLs may contain sensitive data. Use the same input and hash with replay_request.",
    schema: replayInputSchema,
    readOnly: true,
    destructive: false,
    openWorld: false,
  },
  replay_request: {
    description:
      "Send exactly one previously previewed HTTP request. Requires independent replay permission and an allowed origin, explicit authentication and the prepare_replay requestHash. Captured credential snapshots are used, never current browser cookies. Redirects are not followed. Can modify server data, including with GET. Saves a local response and comparison.",
    schema: replayInputSchema.extend({ expectedRequestHash: z.string().regex(/^[a-f0-9]{64}$/) }),
    readOnly: false,
    destructive: true,
    openWorld: true,
  },
  get_replay: {
    description:
      "Read a saved replay response and comparison by replay ID. Does not send HTTP. Credential header values are redacted; bodies and URLs can still contain sensitive data.",
    schema: z.object({ id: z.string().uuid() }).strict(),
    readOnly: true,
    destructive: false,
    openWorld: false,
  },
  list_replays: {
    description:
      "List local replay history metadata (newest first). At most 50 results are retained, independent of Chrome's rolling capture history.",
    schema: z.object({ limit: z.number().int().min(1).max(50).default(20) }).strict(),
    readOnly: true,
    destructive: false,
    openWorld: false,
  },
} as const
export const isReplayTool = (name: string): name is keyof typeof replayTools =>
  Object.hasOwn(replayTools, name)

const historyDirectory = () => join(appDirectory(), "replays")
const summary = ({ id, profileId, record, source }: ReplayResult) => ({
  id,
  profileId,
  source,
  method: record.method,
  url: record.url,
  status: record.status,
  error: record.error ?? null,
  startedAt: record.startedAt,
  durationMs: record.durationMs,
})
const history = (): ReturnType<typeof summary>[] => {
  try {
    return readdirSync(historyDirectory())
      .filter((name) => /^[a-f0-9-]{36}\.meta\.json$/.test(name))
      .flatMap((name) => {
        try {
          const result = JSON.parse(
            readFileSync(join(historyDirectory(), name), "utf8"),
          ) as ReturnType<typeof summary>
          if (
            !z.string().uuid().safeParse(result.id).success ||
            name !== result.id + ".meta.json" ||
            typeof result.startedAt !== "string"
          )
            return []
          return [result]
        } catch {
          return []
        }
      })
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
  } catch {
    return []
  }
}
const save = (result: ReplayResult) => {
  mkdirSync(historyDirectory(), { recursive: true, mode: 0o700 })
  writeFileSync(join(historyDirectory(), result.id + ".json"), JSON.stringify(result), {
    mode: 0o600,
    flag: "wx",
  })
  // List and trim metadata without loading potentially large bodies for every result.
  writeFileSync(
    join(historyDirectory(), result.id + ".meta.json"),
    JSON.stringify(summary(result)),
    {
      mode: 0o600,
      flag: "wx",
    },
  )
  for (const previous of history().slice(50)) {
    unlinkSync(join(historyDirectory(), previous.id + ".json"))
    unlinkSync(join(historyDirectory(), previous.id + ".meta.json"))
  }
}
const readCapture = async (
  profileId: string,
  reference: { id: string; sessionId?: string | undefined },
): Promise<NetworkRecord> => {
  const result = (await callExtension("get_request", { profileId, ...reference })) as
    | NetworkRecord
    | undefined
  if (
    !result ||
    result.id !== reference.id ||
    typeof result.url !== "string" ||
    typeof result.method !== "string" ||
    !result.requestHeaders ||
    !result.responseHeaders ||
    typeof result.startedAt !== "string"
  )
    throw new Error("Captured request was not found. Pin or save captures before previewing.")
  return result
}
const permitted = (origin: string) => {
  const config = loadConfig()
  return config.allowReplay && config.replayOrigins.includes(origin)
}
export const executeReplayTool = async (name: keyof typeof replayTools, input: unknown) => {
  // Existing MCP processes must respect uninstall and permission revocation on every call.
  const initialConfig = loadConfig()
  if (name === "list_replays") {
    const { limit } = replayTools.list_replays.schema.parse(input)
    return { replays: history().slice(0, limit) }
  }
  if (name === "get_replay") {
    const { id } = replayTools.get_replay.schema.parse(input)
    try {
      const result = JSON.parse(
        readFileSync(join(historyDirectory(), id + ".json"), "utf8"),
      ) as ReplayResult
      if (result.id !== id) throw new Error("Mismatched replay result")
      return result
    } catch {
      throw new Error("Replay result was not found")
    }
  }
  const parsed =
    name === "replay_request"
      ? replayTools.replay_request.schema.parse(input)
      : replayInputSchema.parse(input)
  // Discard the approval hash from the plan input so prepare and send hashes match.
  const { expectedRequestHash, ...rawPlan } = parsed as typeof parsed & {
    expectedRequestHash?: string
  }
  const planInput = replayInputSchema.parse(rawPlan)
  if (name === "replay_request" && !initialConfig.allowReplay)
    throw new Error(
      "Replay permission is disabled. Configure replay separately from capture controls.",
    )
  const original = await readCapture(planInput.profileId, planInput.request)
  const auth =
    planInput.authentication.mode === "captured"
      ? await readCapture(planInput.profileId, planInput.authentication.request)
      : undefined
  const plan = buildReplayPlan(planInput, original, auth)
  if (name === "prepare_replay") return previewReplay(plan, permitted(new URL(plan.url).origin))
  const config = loadConfig()
  if (
    config.token !== initialConfig.token ||
    !config.allowReplay ||
    !config.replayOrigins.includes(new URL(plan.url).origin)
  )
    throw new Error("Replay destination is not authorized, or replay access was revoked")
  if (plan.requestHash !== expectedRequestHash)
    throw new Error("Request changed since preview. Call prepare_replay again before sending.")
  const result = await sendReplay(plan)
  result.historySaved = true
  try {
    save(result)
  } catch {
    // An HTTP mutation may already have succeeded. Return its result even if local storage fails.
    result.historySaved = false
    result.historyWarning =
      "Replay completed, but local history could not be saved. Do not resend automatically."
  }
  return result
}

// Independent, explicit origin-scoped permission; never implied by capture-control installation.
export const configureReplay = (allowReplay: boolean, origins: string[]) => {
  const config = loadConfig()
  const replayOrigins = z.array(replayOriginSchema).max(50).parse(origins)
  if (allowReplay && !replayOrigins.length) throw new Error("Replay requires at least one --origin")
  writeFileSync(
    join(appDirectory(), "bridge.json"),
    JSON.stringify(
      {
        ...config,
        allowReplay,
        replayOrigins: allowReplay ? [...new Set(replayOrigins)] : [],
      },
      null,
      2,
    ),
    { mode: 0o600 },
  )
}
