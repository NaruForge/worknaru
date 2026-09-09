<# WorkNaru --hub adapter. Uses the existing Hub workflows; never edits Serve or owns the shared Hub. #>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Prepare', 'Attach', 'Detach')][string]$Mode,
    [ValidateRange(1, 65535)][int]$Port = 15173,
    [ValidateRange(1, 65535)][int]$DaemonPort = 4310,
    [string]$Id
)
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $OutputEncoding
$hubRoot = 'C:\Projects\TailscaleOps'
$hubScripts = Join-Path $hubRoot 'scripts\artifact-preview'
if ($Mode -ne 'Prepare' -and $Id -notmatch '^[a-f0-9]{16}$') { throw 'Invalid Preview ID.' }
if ($Mode -eq 'Prepare') {
    $reservations = (Get-Content -LiteralPath (Join-Path $hubRoot 'config\port-reservations.json') -Raw | ConvertFrom-Json).reservations
    if ($Port -in $reservations.port -or $DaemonPort -in $reservations.port) { throw 'A requested port is reserved by TailscaleOps.' }
    $ts = Get-Command tailscale -ErrorAction Stop
    $status = & $ts.Source status --json | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $status.BackendState -ne 'Running') { throw 'Tailscale must be connected.' }
    $dns = ([string]$status.Self.DNSName).TrimEnd('.')
    if ($dns -ne 'bsw-home.tailec99c3.ts.net') { throw 'This option uses the existing bsw-home Preview Hub only.' }
    $serve = & $ts.Source serve status --json | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $serve.Web."${dns}:9191".Handlers.'/'.Proxy -ne 'http://127.0.0.1:9191' -or $serve.AllowFunnel."${dns}:9191") {
        throw 'The protected Tailnet-only 9191 Serve mapping is unavailable. No network settings were changed.'
    }
    $listener = @(Get-NetTCPConnection -State Listen -LocalPort 9191 -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -in @('127.0.0.1', '0.0.0.0', '::1', '::') })
    $running = $listener.Count -gt 0
    if ($running) {
        $health = Invoke-RestMethod -Uri 'http://127.0.0.1:9191/health' -TimeoutSec 3
        if ($health.service -ne 'artifact-preview-hub' -or $health.status -ne 'ok' -or $health.mode -ne 'preview-gateway') { throw 'Port 9191 is not the expected Preview Hub.' }
    }
    $route = & (Join-Path $hubScripts 'New-ArtifactDevServerPreviewId.ps1')
    [pscustomobject]@{ Id = $route.Id; BasePath = $route.BasePath; TailnetOrigin = "https://${dns}:9191"; HubRunning = $running } | ConvertTo-Json -Compress
} elseif ($Mode -eq 'Attach') {
    $result = & (Join-Path $hubScripts 'Attach-ArtifactDevServer.ps1') -Id $Id -Port $Port -Name 'WorkNaru development' -PathMode preserve 6>$null
    $result | ConvertTo-Json -Compress
} else {
    $manifest = Join-Path $hubRoot "state\artifact-preview-hub\attachments\$Id.json"
    if (Test-Path -LiteralPath $manifest) {
        $record = & (Join-Path $hubScripts 'Get-ArtifactPreview.ps1') -Id $Id
        if ($record.Kind -ne 'attached-dev-server' -or $record.TargetPort -ne $Port) { throw 'The Preview no longer belongs to this development server.' }
        & (Join-Path $hubScripts 'Detach-ArtifactDevServer.ps1') -Id $Id -Confirm:$false 6>$null | ConvertTo-Json -Compress
    } else {
        [pscustomobject]@{ Id = $Id; Detached = $true; AlreadyAbsent = $true; ProcessStopped = $false } | ConvertTo-Json -Compress
    }
}
