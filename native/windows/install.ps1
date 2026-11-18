param([switch]$CompileOnly)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../..')).Path
$compiler = Join-Path $env:WINDIR 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
$nativeOut = Join-Path $env:LOCALAPPDATA 'NanobrowserWorkspace/NativeHost'
New-Item -Path $nativeOut -ItemType Directory -Force | Out-Null
$hostPath = Join-Path $nativeOut 'WorkspaceHost.exe'
& $compiler /nologo /target:exe /optimize+ /reference:System.Web.Extensions.dll "/out:$hostPath" (Join-Path $PSScriptRoot 'WorkspaceHost.cs')
if ($LASTEXITCODE -ne 0) { throw 'No se pudo compilar el componente de Windows.' }
if ($CompileOnly) { Write-Output $hostPath; return }

$publicKey = Get-Content -LiteralPath (Join-Path $repo 'native/extension-public-key.txt') -Raw
$sha = [System.Security.Cryptography.SHA256]::Create()
try { $hash = $sha.ComputeHash([Convert]::FromBase64String($publicKey.Trim())) }
finally { $sha.Dispose() }
$alphabet = 'abcdefghijklmnop'
$extensionId = -join ($hash[0..15] | ForEach-Object { [string]$alphabet[$_ -shr 4] + $alphabet[$_ -band 15] })

$name = 'local.nanobrowser.workspace'
$manifestPath = Join-Path $nativeOut "$name.json"
$manifest = @{ name = $name; description = 'Nanobrowser Workspace Windows companion'; path = $hostPath; type = 'stdio'; allowed_origins = @("chrome-extension://$extensionId/") }
[System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json), (New-Object System.Text.UTF8Encoding($false)))
foreach ($browserKey in @('Google/Chrome','Microsoft/Edge')) {
    $target = 'HKCU:/Software/' + $browserKey + '/NativeMessagingHosts/' + $name
    New-Item -Path $target -Force | Out-Null
    Set-Item -LiteralPath $target -Value $manifestPath
}
Write-Output "Componente registrado para la extensión $extensionId en Chrome y Edge."
