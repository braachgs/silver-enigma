# CI check for DayBoardHelper.ps1 on Windows PowerShell: starts it, then checks
# the ping, CORS preflight, allowlist and a real relayed request.
$ErrorActionPreference = 'Stop'
$job = Start-Process powershell.exe -PassThru -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'DayBoardHelper.ps1'))
$fail = 0
function Check($ok, $what) { if ($ok) { Write-Host "ok: $what" } else { Write-Host "FAIL: $what"; $script:fail++ } }
function Get($url, $headers = @{}, $method = 'GET') {
  try { return Invoke-WebRequest -UseBasicParsing -Uri $url -Headers $headers -Method $method -TimeoutSec 40 }
  catch [Net.WebException] { return $_.Exception.Response }
}
try {
  $up = $false
  for ($i = 0; $i -lt 30 -and -not $up; $i++) { Start-Sleep -Milliseconds 500; try { $up = (Invoke-WebRequest -UseBasicParsing http://localhost:8577/ping).StatusCode -eq 200 } catch { } }
  Check $up 'helper answers /ping'
  $pre = Get 'http://localhost:8577/relay?url=x' @{ 'Origin' = 'null'; 'Access-Control-Request-Method' = 'GET'; 'Access-Control-Request-Headers' = 'x-auth-token' } 'OPTIONS'
  Check ([int]$pre.StatusCode -eq 204 -and $pre.Headers['Access-Control-Allow-Headers'] -match 'X-Auth-Token') 'CORS preflight allows X-Auth-Token'
  $bad = Get ('http://localhost:8577/relay?url=' + [Uri]::EscapeDataString('https://example.com/'))
  Check ([int]$bad.StatusCode -eq 403) 'other hosts are refused'
  $ics = Get ('http://localhost:8577/relay?url=' + [Uri]::EscapeDataString('https://calendar.google.com/calendar/ical/en.uk%23holiday%40group.v.calendar.google.com/public/basic.ics'))
  $body = if ($ics.Content) { [string]$ics.Content } else { '' }
  Check ([int]$ics.StatusCode -eq 200 -and $body.Contains('BEGIN:VCALENDAR') -and $ics.Headers['Access-Control-Allow-Origin'] -eq '*') 'relays a Google iCal feed with CORS'
  $fd = Get ('http://localhost:8577/relay?url=' + [Uri]::EscapeDataString('https://api.football-data.org/v4/competitions/PL/matches')) @{ 'X-Auth-Token' = 'not-a-real-key' }
  Check (@(400, 403) -contains [int]$fd.StatusCode) "passes football-data.org's answer through (HTTP $([int]$fd.StatusCode) for a bad key)"
} finally {
  Stop-Process -Id $job.Id -Force -ErrorAction SilentlyContinue
}
if ($fail) { exit 1 }
