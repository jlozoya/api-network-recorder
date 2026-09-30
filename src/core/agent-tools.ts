import { z } from "zod"

const profile = { profileId: z.string().uuid().optional() }
const session = { sessionId: z.string().min(1).max(200).optional() }
export const agentTools = {
  capture_status: {
    description: "Read recording settings and capture status for each tab.",
    schema: z.object(profile).strict(),
    readOnly: true,
  },
  search_requests: {
    description:
      "Search stored API calls by URL or body. Returns paginated metadata; use get_request for headers and bodies.",
    schema: z
      .object({
        ...profile,
        ...session,
        search: z.string().max(2000).optional(),
        method: z
          .enum(["ALL", "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
          .optional(),
        statusGroup: z
          .enum(["all", "success", "redirect", "client-error", "server-error", "error"])
          .optional(),
        source: z.enum(["all", "fetch", "xhr", "debugger", "web-request"]).optional(),
        host: z.string().max(500).optional(),
        apiOnly: z.boolean().default(true),
        offset: z.number().int().min(0).max(100000).default(0),
        pageSize: z.number().int().min(1).max(100).default(25),
      })
      .strict(),
    readOnly: true,
  },
  get_request: {
    description:
      "Read a stored request's full captured headers and bodies by ID. Missing/truncated bodies report capture availability.",
    schema: z.object({ ...profile, ...session, id: z.string().min(1).max(200) }).strict(),
    readOnly: true,
  },
  list_sessions: {
    description: "List saved capture sessions, including their IDs and counts.",
    schema: z.object(profile).strict(),
    readOnly: true,
  },
  start_recording: {
    description:
      "Resume storing live requests across eligible tabs. Requires capture-control permission granted at installation.",
    schema: z.object(profile).strict(),
    readOnly: false,
  },
  stop_recording: {
    description:
      "Pause storing live requests without deleting stored data. Requires capture-control permission.",
    schema: z.object(profile).strict(),
    readOnly: false,
  },
  start_deep_capture: {
    description:
      "Enable deep capture across eligible tabs. Chrome displays its debugger banner. Requires capture-control permission.",
    schema: z.object(profile).strict(),
    readOnly: false,
  },
  stop_deep_capture: {
    description:
      "Disable deep capture across tabs without deleting records. Requires capture-control permission.",
    schema: z.object(profile).strict(),
    readOnly: false,
  },
} as const

export type AgentToolName = keyof typeof agentTools
export const isAgentTool = (name: unknown): name is AgentToolName =>
  typeof name === "string" && Object.hasOwn(agentTools, name)
