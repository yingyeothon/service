# Installs the latest `yyt` release binary on Windows.
# Usage (PowerShell 5.1+ or pwsh):
#   irm https://raw.githubusercontent.com/yingyeothon/service/main/cli/install.ps1 | iex
# Environment: YYT_VERSION=v1.2.0 pins a release; YYT_BINDIR relocates the install
# directory (default %LOCALAPPDATA%\Programs\yyt, added to the user PATH).
# The body runs in its own scope so `iex` leaves no variables or preference
# changes behind in the caller's session.
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue' # PS 5.1 progress bars make downloads crawl
  $repo = 'yingyeothon/service'

  # A 32-bit PowerShell host on a 64-bit machine reports x86; the machine
  # architecture is then in PROCESSOR_ARCHITEW6432.
  $machine = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  $arch = switch ($machine) {
    'AMD64' { 'amd64' }
    'ARM64' { 'arm64' }
    default { throw "unsupported arch: $machine" }
  }

  # PowerShell 5.1 may negotiate TLS 1.0 by default, which GitHub refuses.
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $tag = $env:YYT_VERSION
  if (-not $tag) {
    # Newest published cli/v* release, skipping drafts and prereleases like
    # `yyt self update` does; the API lists newest first.
    $releases = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases?per_page=100" -Headers @{ 'User-Agent' = 'yyt-install' }
    $rel = $releases | Where-Object { $_.tag_name -like 'cli/v*' -and -not $_.draft -and -not $_.prerelease } | Select-Object -First 1
    if (-not $rel) { throw 'no cli/v* release found' }
    $tag = $rel.tag_name.Substring(4)
  }
  $ver = $tag.TrimStart('v')
  $asset = "yyt_${ver}_windows_${arch}.zip"
  $base = "https://github.com/$repo/releases/download/cli%2F$tag"

  $local = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { [Environment]::GetFolderPath('LocalApplicationData') }
  if (-not $env:YYT_BINDIR -and -not $local) { throw 'LOCALAPPDATA is not set; set YYT_BINDIR to the install directory' }
  $bindir = if ($env:YYT_BINDIR) { $env:YYT_BINDIR } else { Join-Path $local 'Programs\yyt' }
  if ($bindir -match ';') { throw 'YYT_BINDIR must not contain ";"' }
  $bindir = [IO.Path]::GetFullPath($bindir).TrimEnd('\') # never a relative entry on PATH
  $target = Join-Path $bindir 'yyt.exe'

  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("yyt-install-" + [IO.Path]::GetRandomFileName())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  try {
    Write-Host "downloading yyt $tag (windows/$arch)"
    Invoke-WebRequest -Uri "$base/$asset" -OutFile (Join-Path $tmp $asset) -UseBasicParsing
    Invoke-WebRequest -Uri "$base/checksums.txt" -OutFile (Join-Path $tmp 'checksums.txt') -UseBasicParsing

    $line = Get-Content (Join-Path $tmp 'checksums.txt') | Where-Object { $_ -match "^[0-9a-f]{64}\s+$([regex]::Escape($asset))$" } | Select-Object -First 1
    if (-not $line) { throw "no checksum for $asset" }
    $expected = ($line -split '\s+')[0]
    $actual = (Get-FileHash -Algorithm SHA256 (Join-Path $tmp $asset)).Hash.ToLowerInvariant()
    if ($expected -ne $actual) { throw 'checksum mismatch' }

    Expand-Archive -Path (Join-Path $tmp $asset) -DestinationPath (Join-Path $tmp 'x') -Force
    $exe = Join-Path $tmp 'x\yyt.exe'
    if (-not (Test-Path -LiteralPath $exe)) { throw 'yyt.exe not found in archive' }

    New-Item -ItemType Directory -Path $bindir -Force | Out-Null
    # A running yyt.exe cannot be overwritten: move it aside like `yyt self
    # update`, and move it back if the new file cannot land.
    $old = "$target.old"
    Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue
    if (Test-Path -LiteralPath $old) { throw "cannot remove $old (close other yyt processes and delete it)" }
    try {
      if (Test-Path -LiteralPath $target) { Move-Item -LiteralPath $target -Destination $old -Force }
      Move-Item -LiteralPath $exe -Destination $target -Force
    } catch {
      if (-not (Test-Path -LiteralPath $target) -and (Test-Path -LiteralPath $old)) { Move-Item -LiteralPath $old -Destination $target -Force }
      throw
    }
    Remove-Item -LiteralPath $old -Force -ErrorAction SilentlyContinue

    # Persist the user PATH through the registry so %VAR% entries stay
    # unexpanded and the value keeps its REG_EXPAND_SZ kind (the
    # [Environment] setter would flatten both).
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
    try {
      $userPath = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
      $onPath = @($userPath -split ';' | Where-Object { $_ } | ForEach-Object { [Environment]::ExpandEnvironmentVariables($_).TrimEnd('\') }) -contains $bindir
      if (-not $onPath) {
        $newPath = if ($userPath) { $userPath.TrimEnd(';') + ";$bindir" } else { $bindir }
        $key.SetValue('Path', $newPath, [Microsoft.Win32.RegistryValueKind]::ExpandString)
        Write-Host "added $bindir to your user PATH (open a new terminal to use it)"
      }
    } finally { $key.Close() }
    if (@($env:Path -split ';' | ForEach-Object { $_.TrimEnd('\') }) -notcontains $bindir) { $env:Path = "$bindir;$env:Path" }

    Write-Host "installed $target ($(& $target --version))"
  } finally {
    Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}
