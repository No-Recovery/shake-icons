param(
  [Parameter(Mandatory = $true)][string]$Root,
  [int]$Port = 8770,
  [Parameter(Mandatory = $true)][string]$OutFile,
  [int]$MaxSeconds = 180
)

# Раздаёт файлы проекта и принимает результат теста на POST /__result.
# Нужен вместо python -m http.server: виртуальное время Chrome не доводит
# транзакции IndexedDB до конца, и проверки врут.

$ErrorActionPreference = 'Stop'
$rootFull = (Resolve-Path -LiteralPath $Root).Path

if (Test-Path -LiteralPath $OutFile) { Remove-Item -LiteralPath $OutFile -Force }

$types = @{
  '.html' = 'text/html; charset=utf-8'
  '.js'   = 'application/javascript; charset=utf-8'
  '.css'  = 'text/css; charset=utf-8'
  '.json' = 'application/json; charset=utf-8'
  '.png'  = 'image/png'
  '.svg'  = 'image/svg+xml'
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$listener.Start()

# Сервер живёт между всеми страницами: результат может прийти несколько раз,
# по одному на прогон, поэтому после POST не выходим.
$deadline = (Get-Date).AddSeconds($MaxSeconds)

while ((Get-Date) -lt $deadline) {
  $ctx = $listener.GetContext()
  $req = $ctx.Request
  $res = $ctx.Response

  try {
    $path = $req.Url.AbsolutePath

    if ($req.HttpMethod -eq 'POST' -and $path -eq '/__result') {
      $reader = New-Object System.IO.StreamReader($req.InputStream, [System.Text.Encoding]::UTF8)
      $body = $reader.ReadToEnd()
      $reader.Close()
      [System.IO.File]::WriteAllText($OutFile, $body, (New-Object System.Text.UTF8Encoding($false)))
      $res.StatusCode = 200
      $bytes = [System.Text.Encoding]::UTF8.GetBytes('ok')
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    }
    else {
      $rel = $path.TrimStart('/')
      if ($rel -eq '') { $rel = 'index.html' }
      $rel = [System.Uri]::UnescapeDataString($rel)
      $full = Join-Path $rootFull $rel

      if ((Test-Path -LiteralPath $full) -and -not (Get-Item -LiteralPath $full).PSIsContainer) {
        $ext = [System.IO.Path]::GetExtension($full).ToLowerInvariant()
        if ($types.ContainsKey($ext)) { $res.ContentType = $types[$ext] }
        $res.StatusCode = 200
        $fs = [System.IO.File]::OpenRead($full)
        $fs.CopyTo($res.OutputStream)
        $fs.Close()
      }
      else {
        $res.StatusCode = 404
        $bytes = [System.Text.Encoding]::UTF8.GetBytes('not found')
        $res.OutputStream.Write($bytes, 0, $bytes.Length)
      }
    }
  }
  catch {
    try { $res.StatusCode = 500 } catch { }
  }

  $res.Close()
}

$listener.Stop()
$listener.Close()