# ClickZoom Recorder - global mouse monitor
#
# IMPORTANT: keep this file pure ASCII.
# PowerShell 5.1 reads BOM-less UTF-8 as ANSI, so any Chinese char here can corrupt the script.
#
# Output protocol (one line per event):
#   READY <source>   monitor is up ("dll" = loaded prebuilt helper, "compiled" = built on the fly)
#   CLICK <0|1> <x> <y>     0 = left button, 1 = right button
#   MOVE  <x> <y>
#   ERR <message>    fatal, monitor cannot work
# Coordinates are raw PHYSICAL pixels (Win32), matching desktopCapturer frames.

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'

# Defensive: Windows caps a process environment block at 65535 bytes.
# Add-Type spawns csc.exe, which inherits this block - if it is too big, compile fails.
# Drop any oversized variable before compiling.
$oversized = @()
foreach ($name in [System.Environment]::GetEnvironmentVariables().Keys) {
  $val = [System.Environment]::GetEnvironmentVariable($name)
  if ($val -ne $null -and $val.Length -gt 1024) { $oversized += $name }
}
foreach ($name in $oversized) {
  [System.Environment]::SetEnvironmentVariable($name, $null)
}
if ($oversized.Count -gt 0) { Write-Output ("TRIMMED " + $oversized.Count + " " + ($oversized -join ',')) }

try {
  Add-Type -AssemblyName System.Windows.Forms
} catch {
  Write-Output ("ERR cannot load Windows.Forms: " + $_.Exception.Message)
  exit 1
}

# Fast path: load the prebuilt helper assembly sitting next to this script.
# Fallback path: compile the C# source (slow the very first time, several seconds).
$dll = Join-Path $PSScriptRoot 'czr-native.dll'
$loaded = $false

if (Test-Path $dll) {
  try {
    Add-Type -Path $dll
    $null = [CzrNative]::GetAsyncKeyState(0)
    $loaded = $true
    Write-Output "READY dll"
  } catch {
    $loaded = $false
  }
}

if (-not $loaded) {
  $src = 'using System.Runtime.InteropServices; public class CzrNative { [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey); }'
  try {
    Add-Type -TypeDefinition $src -Language CSharp
    Write-Output "READY compiled"
  } catch {
    Write-Output ("ERR cannot compile helper: " + $_.Exception.Message)
    exit 1
  }
}

$VK_LBUTTON = 0x01
$VK_RBUTTON = 0x02

$prevL = $false
$prevR = $false
$lx = -1
$ly = -1
$tick = 0

while ($true) {
  $p = [System.Windows.Forms.Cursor]::Position

  $downL = (([CzrNative]::GetAsyncKeyState($VK_LBUTTON) -band 0x8000) -ne 0)
  $downR = (([CzrNative]::GetAsyncKeyState($VK_RBUTTON) -band 0x8000) -ne 0)

  if ($downL -and -not $prevL) { Write-Output ("CLICK 0 " + $p.X + " " + $p.Y) }
  if ($downR -and -not $prevR) { Write-Output ("CLICK 1 " + $p.X + " " + $p.Y) }

  $prevL = $downL
  $prevR = $downR

  # Report on movement, and also as a heartbeat while standing still -
  # otherwise a recorder that starts before the user moves the mouse has no
  # coordinates at all and draws the cursor in the top-left corner.
  $tick++
  if ($p.X -ne $lx -or $p.Y -ne $ly -or ($tick % 4) -eq 0) {
    Write-Output ("MOVE " + $p.X + " " + $p.Y)
    $lx = $p.X
    $ly = $p.Y
  }

  Start-Sleep -Milliseconds 8
}
