# Reads an Otari key from the clipboard and writes it into .env.
# Run it once per user. It fills PURSE_KEY_ALICE, then PURSE_KEY_BOB.
# The key is never printed. If the clipboard holds anything that is not a key
# it refuses to write and tells you what it found instead.

param([switch]$Reset)

$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $root ".env"
$examplePath = Join-Path $root ".env.example"

if ($Reset) {
  if (Test-Path $envPath) { Remove-Item $envPath }
  Write-Host "Removed .env" -ForegroundColor Yellow
}

if (-not (Test-Path $envPath)) {
  Copy-Item $examplePath $envPath
  Write-Host "Created .env from .env.example" -ForegroundColor DarkGray
}

$key = (Get-Clipboard -Raw)
if ($null -eq $key) { $key = "" }
$key = $key.Trim()

if ($key -notmatch '^otk_v1_us_[A-Za-z0-9]{30,}$') {
  Write-Host "Clipboard does not hold an Otari key." -ForegroundColor Red
  Write-Host ("  expected: otk_v1_us_ followed by characters") -ForegroundColor DarkGray
  Write-Host ("  got " + $key.Length + " characters starting with '" + $key.Substring(0, [Math]::Min(12, $key.Length)) + "'") -ForegroundColor DarkGray
  Write-Host "Copy only the key on the Otari API Keys page, then run this again." -ForegroundColor DarkGray
  exit 1
}

$lines = New-Object System.Collections.Generic.List[string]
foreach ($line in (Get-Content $envPath)) { $lines.Add($line) }

function Get-EnvValue([string]$name) {
  foreach ($line in $lines) {
    if ($line -match ("^\s*" + [regex]::Escape($name) + "\s*=(.*)$")) {
      return $Matches[1].Trim()
    }
  }
  return ""
}

function Set-EnvValue([string]$name, [string]$value) {
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match ("^\s*" + [regex]::Escape($name) + "\s*=")) {
      $lines[$i] = "$name=$value"
      return
    }
  }
  $lines.Add("$name=$value")
}

if (-not (Get-EnvValue "PURSE_KEY_ALICE")) {
  Set-EnvValue "PURSE_KEY_ALICE" $key
  $slot = "alice"
} elseif (-not (Get-EnvValue "PURSE_KEY_BOB")) {
  Set-EnvValue "PURSE_KEY_BOB" $key
  $slot = "bob"
} else {
  Write-Host "Both key slots are already filled." -ForegroundColor Yellow
  Write-Host "Run with -Reset to start over." -ForegroundColor DarkGray
  exit 0
}

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllLines($envPath, $lines, $utf8NoBom)

Write-Host ("Saved a key for " + $slot + " (prefix " + $key.Substring(0, 10) + ", length " + $key.Length + ").") -ForegroundColor Green

$have = @()
if (Get-EnvValue "PURSE_KEY_ALICE") { $have += "alice" }
if (Get-EnvValue "PURSE_KEY_BOB") { $have += "bob" }
Write-Host ("Keys present: " + ($have -join ", ")) -ForegroundColor DarkGray
if ($have.Count -lt 2) {
  Write-Host "Copy the second user's key and run this once more." -ForegroundColor DarkGray
}
