# get.ps1: install a GHOST Protocol agent on this machine (Windows), with Docker Desktop.
#
#   & ([scriptblock]::Create((irm <release>/get.ps1))) -Name "<agent name>" -Relay <relay url> -Owner <owner public key> [-Updater yes|no]
#
# A thin wrapper, the same as get.sh: every step is a docker command, and all
# the logic is in the image. It pulls the image, runs its init in a new data
# volume (the agent's key is made there and never leaves it), starts the
# agent's container, and prints the agent's public key as one line,
# GP_AGENT_PUBKEY=<64 hex>. No env file, so no line-ending trouble.
# -Updater yes also starts the update helper, gp-<slug>.updater, as get.sh
# does; without it, it asks when it can, else keeps what an earlier install chose.
#   $env:GP_IMAGE    the image (the release fills it in)
#   $env:GP_NO_PULL  1: use the image already on this machine
param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Relay,
    [Parameter(Mandatory = $true)][string]$Owner,
    [ValidateSet('', 'yes', 'no')][string]$Updater = ''
)
$ErrorActionPreference = 'Stop'

$Image = if ($env:GP_IMAGE) { $env:GP_IMAGE } else { '@GP_IMAGE@' }
if ($Image -like '@*@') { Write-Error 'get.ps1: set $env:GP_IMAGE to the image to install (the release''s get.ps1 has it filled in)'; exit 2 }

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Write-Error 'get.ps1: docker is not installed; install Docker Desktop first'; exit 1 }
docker version --format '{{.Server.Version}}' *> $null
if ($LASTEXITCODE -ne 0) { Write-Error 'get.ps1: Docker is not running; start Docker Desktop and try again'; exit 1 }

if ($env:GP_NO_PULL -ne '1') { docker pull $Image | Write-Host; if ($LASTEXITCODE -ne 0) { exit 1 } }
$slug = (docker run --rm $Image gp slug $Name | Select-String '^GP_SLUG=(.*)$').Matches.Groups[1].Value
if (-not $slug) { Write-Error 'get.ps1: the name was refused'; exit 1 }
$out = docker run --rm -v "gp-$slug-data:/data" $Image init --name $Name --relay $Relay --owner $Owner
if ($LASTEXITCODE -ne 0) { $out | Write-Host; exit 1 }
docker rm -f "gp-$slug" *> $null
docker run -d --name "gp-$slug" --restart unless-stopped -v "gp-$slug-data:/data" $Image | Out-Null
if ($LASTEXITCODE -ne 0) { exit 1 }
Write-Host "get.ps1: the agent runs in container gp-$slug, its data in volume gp-$slug-data"
if (-not $Updater) {
    docker inspect "gp-$slug.updater" *> $null
    if ($LASTEXITCODE -eq 0) { $Updater = 'yes' }
    elseif ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected) {
        $answer = Read-Host 'Let GHOST Protocol update itself? It needs control of Docker to swap in new versions. You can say no and update by hand. [y/N]'
        $Updater = if ($answer -match '^[Yy]') { 'yes' } else { 'no' }
    }
    else { $Updater = 'no' }
}
docker rm -f "gp-$slug.updater" *> $null
if ($Updater -eq 'yes') {
    docker run -d --name "gp-$slug.updater" --restart unless-stopped -v /var/run/docker.sock:/var/run/docker.sock $Image updater --target "gp-$slug" | Out-Null
    if ($LASTEXITCODE -ne 0) { exit 1 }
    Write-Host "get.ps1: the update helper runs in container gp-$slug.updater"
}
else { Write-Host 'get.ps1: no update helper; the agent says when a new version is out, and the quick start says how to update by hand' }
$out | Select-String '^GP_AGENT_PUBKEY=' | ForEach-Object { $_.Line }
