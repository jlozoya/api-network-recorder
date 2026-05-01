import { patchFetch } from "./fetch-patch.js"
import { patchXhr } from "./xhr-patch.js"

const PATCH_FLAG = "__API_NETWORK_RECORDER_PATCHED__"

const windowWithFlag = window as Window & {
  [PATCH_FLAG]?: boolean
}

if (!windowWithFlag[PATCH_FLAG]) {
  windowWithFlag[PATCH_FLAG] = true

  patchFetch()
  patchXhr()
}