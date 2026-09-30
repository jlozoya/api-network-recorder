import { spawn } from "node:child_process"
import { mkdirSync, existsSync, writeFileSync, readFileSync, copyFileSync } from "node:fs"
import { resolve, join } from "node:path"
import { createHash } from "node:crypto"

if (process.platform !== "win32") throw new Error("The installer must be packaged on Windows")
const binary = resolve("dist/native/api-network-recorder-bridge.exe")
if (!existsSync(binary)) throw new Error("Run bun run build:native first")
const release = resolve("release")
mkdirSync(release, { recursive: true })
const output = join(release, "api-network-recorder-windows-x64-setup.exe")
const sed = resolve("dist/native/installer.sed")
copyFileSync(resolve("THIRD_PARTY_NOTICES.txt"), resolve("dist/native/THIRD_PARTY_NOTICES.txt"))
const content = `[Version]
Class=IEXPRESS
SEDVersion=3
[Options]
PackagePurpose=InstallApp
ShowInstallProgramWindow=0
HideExtractAnimation=0
UseLongFileName=1
InsideCompressed=0
CAB_FixedSize=0
CAB_ResvCodeSigning=0
RebootMode=N
InstallPrompt=%InstallPrompt%
DisplayLicense=%DisplayLicense%
FinishMessage=%FinishMessage%
TargetName=%TargetName%
FriendlyName=%FriendlyName%
AppLaunched=%AppLaunched%
PostInstallCmd=%PostInstallCmd%
AdminQuietInstCmd=%AdminQuietInstCmd%
UserQuietInstCmd=%UserQuietInstCmd%
SourceFiles=SourceFiles
[Strings]
InstallPrompt=Install API Network Recorder AI Integration? This authorizes Codex to read stored API calls from the installed Chrome extension.
DisplayLicense=
FinishMessage=
TargetName=${output}
FriendlyName=API Network Recorder AI Integration
AppLaunched=api-network-recorder-bridge.exe --install
PostInstallCmd=<None>
AdminQuietInstCmd=
UserQuietInstCmd=
FILE0=api-network-recorder-bridge.exe
FILE1=THIRD_PARTY_NOTICES.txt
[SourceFiles]
SourceFiles0=${resolve("dist/native")}\\
[SourceFiles0]
%FILE0%=
%FILE1%=
`
writeFileSync(sed, content.replaceAll("\n", "\r\n"), "ascii")
const compiler = join(process.env.SystemRoot || "C:\\Windows", "System32", "iexpress.exe")
await new Promise<void>((resolveResult, reject) => {
  const process = spawn(compiler, ["/N", "/Q", sed], { windowsHide: true, stdio: "inherit" })
  process.on("error", reject)
  process.on("exit", (code) =>
    code === 0 ? resolveResult() : reject(new Error(`IExpress failed: ${code}`)),
  )
})
if (!existsSync(output)) throw new Error("IExpress did not create an installer")
const digest = createHash("sha256").update(readFileSync(output)).digest("hex")
writeFileSync(output + ".sha256", `${digest}  ${output.split(/[\\/]/).pop()}\n`)
console.log(`Created ${output}`)
