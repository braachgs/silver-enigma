<#
.SYNOPSIS
  Day Board Helper: lets the Day Board and Match Board iCUE widgets reach
  their data when iCUE's browser refuses a direct request.

.DESCRIPTION
  A tiny web relay on http://localhost:8577 (this PC only). The widgets ask
  it for one of two kinds of address and it fetches them for them:
    - https://api.football-data.org/...   (your API key is passed through,
      never stored or logged)
    - https://calendar.google.com/...     (your calendars' iCal addresses)
  Anything else is refused. Needs no install and no admin rights: Windows
  PowerShell is built in.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File DayBoardHelper.ps1 -Install
    Starts it now and at every sign-in (adds a launcher to your Startup folder).
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File DayBoardHelper.ps1 -Uninstall
    Stops it and removes the launcher.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File DayBoardHelper.ps1
    Runs it in this window until you close it.
#>
param(
  [switch]$Install,
  [switch]$Uninstall,
  [int]$Port = 8577
)

$ErrorActionPreference = 'Stop'
$Allowed = @('api.football-data.org', 'calendar.google.com')
$Launcher = Join-Path ([Environment]::GetFolderPath('Startup')) 'Day Board Helper.vbs'

function Stop-Helper {
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
    Where-Object { $_.CommandLine -like '*DayBoardHelper.ps1*' -and $_.ProcessId -ne $PID } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
}

if ($Uninstall) {
  Remove-Item -LiteralPath $Launcher -ErrorAction SilentlyContinue
  Stop-Helper
  Write-Host 'Day Board Helper stopped and removed from start-up.'
  return
}

if ($Install) {
  $self = $PSCommandPath
  # A hidden window at every sign-in; wscript runs it without a console flashing up.
  $cmd = 'powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""' + $self + '""'
  Set-Content -LiteralPath $Launcher -Encoding ASCII -Value ('CreateObject("WScript.Shell").Run "' + $cmd + '", 0, False')
  Stop-Helper
  Start-Process -FilePath 'wscript.exe' -ArgumentList ('"' + $Launcher + '"')
  Write-Host "Day Board Helper is running on http://localhost:$Port and will start at every sign-in."
  Write-Host "Launcher: $Launcher"
  return
}

function Test-Allowed([Uri]$u) {
  if ($u.Scheme -ne 'https') { return $false }
  foreach ($h in $Allowed) {
    if ($u.Host -eq $h -or $u.Host.EndsWith('.' + $h)) { return $true }
  }
  return $false
}

function Send-Text($res, [int]$status, [string]$text) {
  $bytes = [Text.Encoding]::UTF8.GetBytes($text)
  $res.StatusCode = $status
  $res.ContentType = 'text/plain; charset=utf-8'
  $res.OutputStream.Write($bytes, 0, $bytes.Length)
}

[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
try {
  $listener.Start()
} catch {
  Write-Host "Couldn't listen on port $Port. Is the helper already running?"
  exit 1
}
Write-Host "Day Board Helper on http://localhost:$Port (Ctrl+C to stop)"

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $req = $ctx.Request
  $res = $ctx.Response
  try {
    $res.Headers.Add('Access-Control-Allow-Origin', '*')
    $res.Headers.Add('Access-Control-Allow-Methods', 'GET, OPTIONS')
    $res.Headers.Add('Access-Control-Allow-Headers', 'X-Auth-Token')
    $res.Headers.Add('Access-Control-Allow-Private-Network', 'true')
    $res.Headers.Add('Cache-Control', 'no-store')
    if ($req.HttpMethod -eq 'OPTIONS') {
      $res.StatusCode = 204
    } elseif ($req.Url.AbsolutePath -eq '/ping') {
      Send-Text $res 200 'Day Board Helper'
    } elseif ($req.Url.AbsolutePath -eq '/relay' -and $req.HttpMethod -eq 'GET') {
      $target = $req.QueryString['url']
      $uri = $null
      if (-not $target -or -not [Uri]::TryCreate($target, [UriKind]::Absolute, [ref]$uri) -or -not (Test-Allowed $uri)) {
        Send-Text $res 403 'Only football-data.org and Google Calendar iCal addresses are relayed.'
      } else {
        $up = [Net.HttpWebRequest]::Create($uri)
        $up.Method = 'GET'
        $up.Timeout = 30000
        $up.UserAgent = 'DayBoardHelper/1.0'
        $up.AutomaticDecompression = [Net.DecompressionMethods]::GZip -bor [Net.DecompressionMethods]::Deflate
        $token = $req.Headers['X-Auth-Token']
        if ($token) { $up.Headers.Add('X-Auth-Token', $token) }
        $answer = $null
        try {
          $answer = $up.GetResponse()
        } catch [Net.WebException] {
          $answer = $_.Exception.Response # 4xx/5xx still carry a body worth passing on
        }
        if ($null -eq $answer) {
          Send-Text $res 502 "Couldn't reach $($uri.Host)."
        } else {
          try {
            $res.StatusCode = [int]$answer.StatusCode
            if ($answer.ContentType) { $res.ContentType = $answer.ContentType }
            $answer.GetResponseStream().CopyTo($res.OutputStream)
          } finally {
            $answer.Close()
          }
        }
      }
    } else {
      Send-Text $res 404 'Not found'
    }
  } catch {
    try { Send-Text $res 500 'Helper error' } catch { }
  } finally {
    try { $res.Close() } catch { }
  }
}
