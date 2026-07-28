$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$nativeRoot = Join-Path $projectRoot 'native'
$frameworkRoot = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
if (-not (Test-Path -LiteralPath $frameworkRoot)) {
    $frameworkRoot = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319'
}

$csc = Join-Path $frameworkRoot 'csc.exe'
$wpfRoot = Join-Path $frameworkRoot 'WPF'
if (-not (Test-Path -LiteralPath $csc)) {
    throw '未找到 .NET Framework C# 编译器。请启用 Windows 的 .NET Framework 4.x 功能。'
}

& $csc /nologo /target:winexe /platform:anycpu /optimize+ `
    "/reference:$wpfRoot\WindowsBase.dll" `
    "/reference:$wpfRoot\PresentationCore.dll" `
    "/reference:$wpfRoot\PresentationFramework.dll" `
    "/reference:$frameworkRoot\System.Xaml.dll" `
    "/reference:$frameworkRoot\System.Runtime.Serialization.dll" `
    "/out:$nativeRoot\WallpaperEngine.exe" `
    "$nativeRoot\WallpaperEngine.cs"
if ($LASTEXITCODE -ne 0) { throw 'WallpaperEngine 编译失败。' }

& $csc /nologo /target:exe /platform:anycpu /optimize+ `
    "/reference:$frameworkRoot\System.Runtime.WindowsRuntime.dll" `
    "/out:$nativeRoot\LockScreenHelper.exe" `
    "$nativeRoot\LockScreenHelper.cs"
if ($LASTEXITCODE -ne 0) { throw 'LockScreenHelper 编译失败。' }

Write-Host '原生辅助程序编译完成。' -ForegroundColor Green
