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
  const status = await ready("captureStatus")
  assert.equal(status.data.deepCaptureSupported, true)
  assert.equal(await evaluate('Boolean(document.getElementById("localIntegration"))'), true)
  await evaluate('document.getElementById("startRecording").click()')
  await ready("captureStatus")
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
    "PASS: AI access installation panel, pause/resume, deep capture controls and capture error recovery.",
  )
}
