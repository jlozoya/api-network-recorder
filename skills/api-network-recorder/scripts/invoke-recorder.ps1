param(
  [ValidateSet('list_profiles', 'capture_status', 'search_requests', 'get_request', 'list_sessions', 'start_recording', 'stop_recording', 'start_deep_capture', 'stop_deep_capture', 'prepare_replay', 'replay_request', 'get_replay', 'list_replays')]
  [string]$Tool = 'list_profiles',
  [string]$ArgumentsJson = '{}',
  [string]$BridgePath = (Join-Path $env:LOCALAPPDATA 'ApiNetworkRecorder/api-network-recorder-bridge.exe')
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$recorderProcess = $null
try {
  if (-not (Test-Path -LiteralPath $BridgePath -PathType Leaf)) {
    throw 'API Network Recorder integration is not installed. Run its Windows installer first.'
  }
  $recorderArguments = ConvertFrom-Json -InputObject $ArgumentsJson
  if ($recorderArguments -isnot [System.Management.Automation.PSCustomObject]) {
    throw 'ArgumentsJson must be a JSON object.'
  }
  $recorderStart = New-Object System.Diagnostics.ProcessStartInfo
  $recorderStart.FileName = [System.IO.Path]::GetFullPath($BridgePath)
  $recorderStart.Arguments = '--mcp'
  $recorderStart.UseShellExecute = $false
  $recorderStart.CreateNoWindow = $true
  $recorderStart.RedirectStandardInput = $true
  $recorderStart.RedirectStandardOutput = $true
  $recorderStart.RedirectStandardError = $true
  $recorderStart.StandardOutputEncoding = [System.Text.UTF8Encoding]::new($false)
  $recorderStart.StandardErrorEncoding = [System.Text.UTF8Encoding]::new($false)
  $recorderProcess = [System.Diagnostics.Process]::Start($recorderStart)
  $recorderErrors = $recorderProcess.StandardError.ReadToEndAsync()

  function Send-RecorderMessage($Message) {
    $recorderBytes = [System.Text.Encoding]::UTF8.GetBytes(($Message | ConvertTo-Json -Depth 100 -Compress) + "`n")
    $recorderProcess.StandardInput.BaseStream.Write($recorderBytes, 0, $recorderBytes.Length)
    $recorderProcess.StandardInput.BaseStream.Flush()
  }
  function Read-RecorderResponse([int]$Id) {
    $recorderDeadline = [DateTime]::UtcNow.AddSeconds(40)
    while ([DateTime]::UtcNow -lt $recorderDeadline) {
      $recorderRead = $recorderProcess.StandardOutput.ReadLineAsync()
      $recorderRemaining = [Math]::Max(1, [int]($recorderDeadline - [DateTime]::UtcNow).TotalMilliseconds)
      if (-not $recorderRead.Wait($recorderRemaining)) { throw 'The local MCP request timed out.' }
      $recorderLine = $recorderRead.Result
      if ($null -eq $recorderLine) { throw 'The local MCP closed before responding.' }
      $recorderResponse = ConvertFrom-Json -InputObject $recorderLine
      if ($recorderResponse.id -ne $Id) { continue }
      if ($null -ne $recorderResponse.error) { throw $recorderResponse.error.message }
      return $recorderResponse.result
    }
    throw 'The local MCP request timed out.'
  }

  Send-RecorderMessage @{
    jsonrpc = '2.0'; id = 1; method = 'initialize'
    params = @{ protocolVersion = '2025-11-25'; capabilities = @{}; clientInfo = @{ name = 'api-network-recorder-skill'; version = '1.0.0' } }
  }
  $null = Read-RecorderResponse 1
  Send-RecorderMessage @{ jsonrpc = '2.0'; method = 'notifications/initialized' }
  Send-RecorderMessage @{ jsonrpc = '2.0'; id = 2; method = 'tools/call'; params = @{ name = $Tool; arguments = $recorderArguments } }
  $recorderResult = Read-RecorderResponse 2
  foreach ($recorderContent in $recorderResult.content) {
    if ($recorderContent.type -eq 'text') { Write-Output $recorderContent.text }
  }
  if ($recorderResult.isError) { exit 1 }
} catch {
  Write-Output (@{ error = $_.Exception.Message } | ConvertTo-Json -Compress)
  exit 1
} finally {
  if ($null -ne $recorderProcess) {
    $recorderProcess.StandardInput.Close()
    if (-not $recorderProcess.WaitForExit(2000)) {
      $recorderProcess.Kill()
      $recorderProcess.WaitForExit()
    }
    $recorderProcess.Dispose()
  }
}
