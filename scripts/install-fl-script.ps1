# Windows: link the MK3 Bridge script into FL Studio's hardware-script folder, so edits apply on reload.
# A directory junction, which needs no administrator rights. It never overwrites anything.
$ErrorActionPreference = 'Stop'

$source = Join-Path (Split-Path -Parent $PSScriptRoot) 'fl-script\MK3Bridge'
$documents = [Environment]::GetFolderPath('MyDocuments')
$hardware = Join-Path $documents 'Image-Line\FL Studio\Settings\Hardware'
$target = Join-Path $hardware 'MK3Bridge'

if (-not (Test-Path $hardware)) {
  Write-Error "FL Studio's hardware folder was not found: $hardware. Start FL Studio once so it creates its settings folders, then rerun."
}

$item = Get-Item $target -ErrorAction SilentlyContinue
if ($item) {
  if ($item.LinkType -eq 'Junction' -and "$($item.Target)" -eq $source) {
    Write-Output "Already installed: $target -> $source"
    exit 0
  }
  Write-Error "$target already exists and is not a link to here; leaving it alone."
}

New-Item -ItemType Junction -Path $target -Target $source | Out-Null
Write-Output "Installed: $target -> $source"
Write-Output 'In FL Studio: Options > MIDI Settings, see docs/windows.md.'
