// Bundled only by the smoke test into its temporary extension build.
import * as repository from "../src/storage/network-record-repository.js"
import { getDb } from "../src/storage/db.js"
import { setCaptureSettings } from "../src/storage/capture-settings.js"
import type { NetworkRecord } from "../src/core/network-types.js"
export { repository }
const check = (value: unknown, message: string) => {
  if (!value) throw new Error(message)
}
const record = (id: string, offset = 0): NetworkRecord => ({
  id,
  source: "fetch",
  resourceType: "fetch",
  mimeType: "application/json",
  tabId: null,
  pageUrl: "https://page.test",
  origin: "https://page.test",
  method: "POST",
  url: "https://api.test/users/" + (offset + 1),
  requestHeaders: { "Content-Type": "application/json" },
  responseHeaders: { "Content-Type": "application/json" },
  requestBody: { kind: "json", value: { name: id }, sizeBytes: 20, truncated: false },
  responseBody: {
    kind: "json",
    value: { bodyOnlyNeedle: id, message: "<script>bad()</script>", number: offset },
    sizeBytes: 60,
    truncated: false,
  },
  status: 200,
  statusText: "OK",
  startedAt: new Date(Date.UTC(2026, 8, 10, 0, 0, offset)).toISOString(),
  completedAt: new Date(Date.UTC(2026, 8, 10, 0, 0, offset, 100)).toISOString(),
  durationMs: 100,
})
export const migrationAndRetention = async () => {
  const name = "api-recorder-migration-smoke"
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(name, 1)
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore("networkRecords", { keyPath: "id" })
      for (const field of ["startedAt", "url", "method", "status", "tabId"])
        store.createIndex("by-" + field, field)
      store.put(record("legacy"))
    }
    request.onsuccess = () => {
      request.result.close()
      resolve()
    }
    request.onerror = () => reject(request.error)
  })
  await setCaptureSettings({
    captureLimit: 50,
    capturePaused: false,
    captureActiveSince: null,
    ignoredDomains: [],
    ignoredTabIds: [],
  })
  // Complete the one-time backfill before exercising preview reads.
  await getDb()
  const previews = await repository.listNetworkRecordPreviews()
  check(
    previews.length === 1 &&
      previews[0]?.id === "legacy" &&
      previews[0].responseBody === null &&
      previews[0].hasResponseBody,
    "Migration failed to preserve metadata",
  )
  check(
    (await repository.getNetworkRecordsByIds(["legacy"]))[0]?.responseBody?.kind === "json",
    "Migration lost body",
  )
  const db = await getDb()
  check(db.version === 2, "Schema version was not upgraded")
  await repository.setNetworkRecordPinned("legacy", true)
  for (let i = 1; i <= 75; i++) await repository.saveNetworkRecord(record("new-" + i, i))
  await repository.trimNetworkRecords()
  check((await db.count("networkRecords")) === 51, "Trim did not retain 50 unpinned plus pinned")
  // Page assets have their own allowance: a shared one lets image/script noise
  // delete the API records the inspector is showing.
  for (let i = 1; i <= 60; i++)
    await repository.saveNetworkRecord({
      ...record("asset-" + i, 100 + i),
      url: "https://page.test/static/asset-" + i + ".png",
      resourceType: "image",
      mimeType: "image/png",
      requestBody: null,
      responseBody: null,
    })
  await repository.trimNetworkRecords()
  check((await db.count("networkRecords")) === 101, "Asset traffic shares the API allowance")
  const apiPreviews = await repository.listNetworkRecordPreviews({ apiOnly: true })
  check(
    apiPreviews.length === 51 && apiPreviews.every((item) => !item.url.includes("/static/")),
    "Asset traffic evicted the API records on screen",
  )
  const current = await repository.listNetworkRecordPreviews()
  check(
    current.some((item) => item.id === "legacy" && item.pinned),
    "Pin disappeared from list",
  )
  const session = await repository.saveSession("Before cleanup", ["legacy", "new-75"])
  await repository.clearNetworkRecords()
  check((await db.count("networkRecords")) === 1, "Clear did not preserve pinned record")
  check(
    (await repository.getNetworkRecordsByIds(["new-75"], session.id))[0]?.responseBody?.kind ===
      "json",
    "Saved body lost during clear",
  )
  check(
    (await repository.listNetworkRecordPreviews({}, session.id)).length === 2,
    "Session list incorrect",
  )
  check(
    (await repository.listNetworkRecordPreviews({ search: "bodyonlyneedle" }, session.id))
      .length === 2,
    "Body search stopped working",
  )
  const before = await db.count("sessions")
  try {
    await repository.saveSession("Must roll back", ["legacy", "missing"])
    throw new Error("Expected rejection")
  } catch (error) {
    check(String(error).includes("expired"), "Unexpected snapshot failure")
  }
  check((await db.count("sessions")) === before, "Failed snapshot committed metadata")
  check((await db.count("sessionRecords")) === 2, "Failed snapshot left orphan records")
  const otherSession = await repository.saveSession("Independent copy", ["legacy"])
  await repository.deleteNetworkRecord("legacy", session.id)
  check(!(await db.get("sessionRecords", [session.id, "legacy"])), "Session body was not deleted")
  check(!(await db.get("sessionPreviews", [session.id, "legacy"])), "Session preview was not deleted")
  check((await db.get("sessions", session.id))?.count === 1, "Session count was not updated")
  await repository.deleteNetworkRecord("legacy", session.id)
  check((await db.get("sessions", session.id))?.count === 1, "Repeated deletion changed the count")
  check(await db.get("networkRecords", "legacy"), "Session deletion removed the live record")
  check(await db.get("sessionRecords", [otherSession.id, "legacy"]), "Another snapshot was modified")
  await repository.deleteNetworkRecord("legacy")
  check(!(await db.get("networkRecords", "legacy")), "Pinned body was not deleted")
  check(!(await db.get("recordPreviews", "legacy")), "Pinned preview was not deleted")
  check(await db.get("sessionRecords", [otherSession.id, "legacy"]), "Live deletion removed a snapshot")
  await repository.deleteNetworkRecord("legacy", otherSession.id)
  check((await db.get("sessions", otherSession.id))?.count === 0, "Last deletion did not empty the session")
  await repository.deleteSavedSession(otherSession.id)
  await repository.deleteSavedSession(session.id)
  check(
    (await db.count("sessionRecords")) === 0 && (await db.count("sessionPreviews")) === 0,
    "Deleting a session left data",
  )
  db.close()
  return { migrated: true, retained: 51, snapshots: true, bodySearch: true, rollback: true }
}
export const seedInspector = async () => {
  await setCaptureSettings({
    captureLimit: 50,
    capturePaused: false,
    captureActiveSince: null,
    ignoredDomains: [],
    ignoredTabIds: [],
  })
  await repository.clearNetworkRecords()
  await repository.saveNetworkRecord(record("ui-a", 1))
  await repository.saveNetworkRecord(record("ui-b", 2))
  await repository.saveNetworkRecord({
    ...record("ui-c", 3),
    url: "https://second-api.test/users/1",
  })
  ;(await getDb()).close()
}

export const addInspectorRecords = async (prefix: string, count: number, startOffset: number) => {
  for (let index = 0; index < count; index++) {
    await repository.saveNetworkRecord(record(`${prefix}-${index}`, startOffset + index))
  }
}

export const trimInspectorRecords = () => repository.trimNetworkRecords()

export const seedAgent = async () => {
  await setCaptureSettings({ capturePaused: false, captureActiveSince: null })
  // This fixture shares only the test profile with the preceding pin-retention checks.
  for (const preview of await repository.listNetworkRecordPreviews()) {
    if (preview.pinned) await repository.setNetworkRecordPinned(preview.id, false)
  }
  await repository.clearNetworkRecords()
  for (let index = 0; index < 31; index++) {
    await repository.saveNetworkRecord({
      ...record(`agent-${index}`, index),
      method: index === 0 ? "POST" : "GET",
      status: index % 3 === 0 ? 500 : 200,
    })
  }
  const session = await repository.saveSession("Agent snapshot", ["agent-0", "agent-1"])
  await repository.saveNetworkRecord({
    ...record("agent-0"),
    responseBody: { kind: "unavailable", reason: "Response body not captured" },
  })
  await repository.saveNetworkRecord({
    ...record("agent-truncated", 40),
    requestBody: null,
    responseBody: { kind: "text", value: "partial", truncated: true, sizeBytes: 500 },
  })
  return session.id
}
