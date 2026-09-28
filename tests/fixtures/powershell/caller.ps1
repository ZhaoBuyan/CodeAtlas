# 引用方：命令名跨文件调用（`Get-Widget` / `Format-Widget` 定义在 widget.ps1）。

Import-Module -Name Pester

function Show-All {
    param([int]$Count = 2)
    $w = Get-Widget -Name "demo" -Size $Count
    Format-Widget -Widget $w
}

Show-All
