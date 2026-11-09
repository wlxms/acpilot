.SYNOPSIS
Launch VS Code Insiders with ACPilot proposed API access.
#>
$ErrorActionPreference = 'Stop'
$Cli = Join-Path $env:ProgramFiles 'Microsoft VS Code Insiders\bin\code-insiders.cmd'
if (-not (Test-Path -LiteralPath $Cli)) {
  throw "VS Code Insiders CLI not found: $Cli"
}
& $Cli --enable-proposed-api wlxms.acpilot @args
