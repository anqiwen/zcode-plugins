param(
  [ValidateSet('protect', 'unprotect')]
  [string]$Op = 'protect'
)

# DPAPI helper for the OpenCode Go Usage plugin.
# The payload arrives on stdin as base64; the data is never passed on the
# command line, so it cannot leak through the process list or console history.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security

$inputText = [Console]::In.ReadToEnd()
if (-not $inputText) {
  [Console]::Error.Write('empty input')
  exit 2
}

$bytes = [Convert]::FromBase64String($inputText.Trim())
$entropy = [Text.Encoding]::UTF8.GetBytes('zcode-opencode-go-usage:v1')
$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser

if ($Op -eq 'protect') {
  $output = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, $scope)
} else {
  $output = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $entropy, $scope)
}

[Console]::Out.Write([Convert]::ToBase64String($output))
