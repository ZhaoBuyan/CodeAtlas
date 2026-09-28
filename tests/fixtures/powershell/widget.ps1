# 回归夹具（2026-09-25，新加语言 PowerShell）：class / function / 参数 / 跨文件命令调用。
# 由 caller.ps1 调用本文件里的函数（PowerShell 的跨文件依赖主要靠**命令名**）。

class Widget {
    [string]$Name
    [int]$Size

    Widget([string]$name) {
        $this.Name = $name
    }

    [string] Describe() {
        return "$($this.Name):$($this.Size)"
    }
}

function Get-Widget {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [int]$Size = 3
    )
    $w = [Widget]::new($Name)
    if ($Size -gt 0) { $w.Size = $Size }
    return $w
}

function Format-Widget {
    param([Widget]$Widget)
    return $Widget.Describe()
}
