import assert from "node:assert/strict"

type Evaluate = (expression: string) => Promise<any>
type WaitFor = (
  read: () => Promise<any>,
  accepts: (value: any) => boolean,
  label: string,
) => Promise<any>

export const runAgentSmoke = async (evaluate: Evaluate, waitFor: WaitFor): Promise<void> => {
  const json = (id: string) =>
    evaluate(`JSON.parse(document.getElementById(${JSON.stringify(id)}).textContent)`)
  const ready = (id: string) =>
    waitFor(
      () => json(id),
      (value) => value?.ok,
      id,
    )
  const submit = async (fields: Record<string, string>) => {
    await evaluate(`(() => {
      const fields = ${JSON.stringify(fields)};
      for (const [id, value] of Object.entries(fields)) document.getElementById(id).value = value;
      document.getElementById("searchForm").requestSubmit();
    })()`)
    return ready("requestsJson")
  }
  const request = async (id: string) => {
    await evaluate(
      `document.getElementById("requestId").value = ${JSON.stringify(id)}; document.getElementById("requestForm").requestSubmit()`,
    )
    return ready("requestJson")
  }
  const sessionId = await evaluate(
    '(async () => { const fixture = await import("./assets/inspector-smoke.js?agent"); return fixture.seedAgent() })()',
  )
  await evaluate("location.reload()")
  await waitFor(
    () => evaluate('document.getElementById("session")?.options.length'),
    (count) => count > 1,
    "Agent sessions",
  )
  const status = await ready("captureStatus")
  assert.equal(status.data.deepCaptureSupported, true)
  assert.equal(
    await evaluate('document.getElementById("agentUrl").value'),
    await evaluate("location.href"),
  )
  const page = await submit({
    pageSize: "10",
    search: "/users/",
    method: "ALL",
    statusGroup: "all",
    host: "api.test",
  })
  assert.equal(page.total, 32)
  assert.equal(page.records.length, 10)
  assert.equal(page.records[0].id, "agent-truncated")
  assert.equal(page.hasMore, true)
  assert(page.records.every((record: any) => !("responseBody" in record)))
  await evaluate('document.getElementById("nextPage").click()')
  assert.equal((await json("requestsJson")).offset, 10)
  await evaluate('document.getElementById("previousPage").click()')
  assert.equal((await json("requestsJson")).offset, 0)
  const errors = await submit({ method: "GET", statusGroup: "server-error" })
  assert.equal(errors.total, 10)
  assert(errors.records.every((record: any) => record.method === "GET" && record.status === 500))
  const bodySearch = await submit({ search: "bodyOnlyNeedle", method: "ALL", statusGroup: "all" })
  assert.equal(bodySearch.total, 30)
  await evaluate('document.querySelector("[data-request-id=agent-30]").click()')
  const detail = await ready("requestJson")
  assert.equal(detail.data.responseBody.value.bodyOnlyNeedle, "agent-30")
  assert.equal(
    await evaluate('document.getElementById("requestJson").querySelector("script")'),
    null,
  )
  assert(
    (await evaluate('document.getElementById("requestJson").textContent')).includes(
      "<script>bad()</script>",
    ),
  )
  const truncated = await request("agent-truncated")
  assert.equal(truncated.data.responseBody.truncated, true)
  const unavailable = await request("agent-0")
  assert.equal(unavailable.data.responseBody.kind, "unavailable")
  const saved = await submit({ session: sessionId, search: "", host: "" })
  assert.equal(saved.total, 2)
  const savedDetail = await request("agent-0")
  assert.equal(savedDetail.sessionId, sessionId)
  assert.equal(savedDetail.data.responseBody.kind, "json")
  const empty = await submit({ search: "does-not-exist" })
  assert.equal(empty.total, 0)
  assert.equal(await json("requestJson"), null)
  assert.equal(await evaluate('document.getElementById("nextPage").disabled'), true)
  await evaluate(
    'document.getElementById("requestId").value = "expired-request"; document.getElementById("requestForm").requestSubmit()',
  )
  const missing = await waitFor(
    () => json("requestJson"),
    (result) => result?.ok === false,
    "Expired request error",
  )
  assert(missing.error.includes("expired"))
  await submit({ session: "", search: "", pageSize: "10" })
  await evaluate('document.getElementById("stopRecording").click()')
  await waitFor(
    () => json("captureStatus"),
    (result) => result?.data?.settings.capturePaused === true,
    "Agent stops recording",
  )
  await evaluate('document.getElementById("startRecording").click()')
  const started = await waitFor(
    () => json("captureStatus"),
    (result) => result?.data?.settings.capturePaused === false,
    "Agent resumes recording",
  )
  assert(started.data.settings.captureActiveSince)
  const startedAt = started.data.settings.captureActiveSince
  await evaluate('document.getElementById("startRecording").click()')
  assert.equal((await ready("captureStatus")).data.settings.captureActiveSince, startedAt)
  await evaluate('document.getElementById("startDeepCapture").click()')
  await waitFor(
    () => json("captureStatus"),
    (result) => result?.data?.settings.deepCaptureEnabled === true,
    "Agent starts deep capture",
  )
  await evaluate('document.getElementById("stopDeepCapture").click()')
  await waitFor(
    () => json("captureStatus"),
    (result) => result?.data?.settings.deepCaptureEnabled === false,
    "Agent stops deep capture",
  )
  await evaluate(`
    globalThis.agentOriginalSendMessage = chrome.runtime.sendMessage;
    chrome.runtime.sendMessage = function(message, ...args) {
      if (message.type === "START_DEBUGGER_CAPTURE_ALL") return Promise.resolve({ ok: false, error: "Capture denied for test" });
      return globalThis.agentOriginalSendMessage.call(chrome.runtime, message, ...args);
    };
    document.getElementById("startDeepCapture").click();
  `)
  const denied = await waitFor(
    () => json("captureStatus"),
    (result) => result?.ok === false,
    "Agent capture error",
  )
  assert.equal(denied.error, "Capture denied for test")
  assert.equal(await evaluate('document.getElementById("startDeepCapture").disabled'), false)
  await evaluate(
    'chrome.runtime.sendMessage = globalThis.agentOriginalSendMessage; document.getElementById("refreshStatus").click()',
  )
  await ready("captureStatus")
  console.log(
    "PASS: AI access page filters, pagination, body search, JSON details, safe text rendering, saved sessions, missing/truncated bodies, empty/error states, pause/resume and deep capture controls.",
  )
}
