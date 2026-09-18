# Query one window's rectangle by hwnd.
# Usage: powershell -File window-rect.ps1 -hwnd 394084
# Output: "left top right bottom" in physical pixels, or "FAIL"
# ASCII only - PowerShell 5.1 reads BOM-less UTF-8 as ANSI.
param([string]$hwnd)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

# Defensive: Windows caps a process environment block at 65535 bytes
foreach ($name in [System.Environment]::GetEnvironmentVariables().Keys) {
  $val = [System.Environment]::GetEnvironmentVariable($name)
  if ($val -ne $null -and $val.Length -gt 1024) { [System.Environment]::SetEnvironmentVariable($name, $null) }
}

$dll = Join-Path $PSScriptRoot 'czr-native.dll'
if (-not (Test-Path $dll)) { Write-Output "FAIL"; exit 1 }

try {
  Add-Type -Path $dll
} catch {
  Write-Output "FAIL"
  exit 1
}

$parsed = [Int64]0
if (-not [Int64]::TryParse($hwnd, [ref]$parsed)) { Write-Output "FAIL"; exit 1 }

$rect = [CzrNative]::RectOf([IntPtr]$parsed)
if ($rect -eq "FAIL" -or [string]::IsNullOrWhiteSpace($rect)) { Write-Output "FAIL"; exit 1 }

Write-Output $rect
