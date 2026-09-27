<#
.SYNOPSIS
  Launches TradingView Desktop with the Chrome DevTools Protocol enabled and
  guarantees a chart tab is open, which tradingview-mcp requires.

.DESCRIPTION
  tradingview-mcp only works when BOTH are true:
    1. TradingView is running with --remote-debugging-port=9222
    2. A chart tab is actually open (https://www.tradingview.com/chart/...)

  Condition 2 is the non-obvious one. On startup the app restores your last
  tab; if that saved layout has been deleted server-side it 404s and the app
  shows an error page instead of a chart. The MCP then attaches to the wrong
  renderer and every tool reports api_available: false.

.EXAMPLE
  .\launch-tv.ps1
  .\launch-tv.ps1 -Symbol AAPL
#>
[CmdletBinding()]
param(
  [string]$Symbol = "BTCUSD",
  [int]$Port = 9222,
  [switch]$Restart
)

$ErrorActionPreference = "Stop"

$Exe = Join-Path $env:LOCALAPPDATA "tradingview-mcp\TradingView\TradingView.exe"
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Test-Path -LiteralPath $Exe)) {
  throw "TradingView not found at $Exe. Install it with: npm i -g tradingview-mcp@1.0.1"
}

function Test-Cdp {
  param([int]$P)
  try {
    $r = Invoke-WebRequest -Uri "http://localhost:$P/json/version" -UseBasicParsing -TimeoutSec 3
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

$already = Test-Cdp -P $Port

if ($Restart -and $already) {
  Write-Host "Restart requested - killing TradingView..." -ForegroundColor Yellow
  Get-Process -Name "TradingView" -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 3
  $already = $false
}

if ($already) {
  Write-Host "CDP already listening on $Port - reusing running instance." -ForegroundColor DarkGray
} else {
  Write-Host "Launching TradingView with --remote-debugging-port=$Port ..." -ForegroundColor Cyan
  Start-Process -FilePath $Exe -ArgumentList "--remote-debugging-port=$Port" -WorkingDirectory (Split-Path $Exe) | Out-Null

  $ok = $false
  foreach ($i in 1..30) {
    Start-Sleep -Seconds 1
    if (Test-Cdp -P $Port) { $ok = $true; break }
  }
  if (-not $ok) { throw "TradingView did not open CDP port $Port within 30s." }
  Write-Host "CDP is up on $Port." -ForegroundColor Green
}

# The critical step: make sure a real chart tab exists.
Write-Host "Ensuring a chart tab is open (symbol: $Symbol) ..." -ForegroundColor Cyan
& node (Join-Path $Here "ensure-chart.mjs") $Symbol
if ($LASTEXITCODE -ne 0) { throw "Could not open a chart tab." }

Write-Host ""
Write-Host "Ready. Verify with:  tv status" -ForegroundColor Green
