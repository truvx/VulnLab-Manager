# Building from source

## Toolchain

- Node.js 22 or newer (CI uses Node 24)
- npm
- QEMU installed on the host for running imported targets
- Windows ARM64 or macOS Apple Silicon for native local package builds

## macOS Apple Silicon

```bash
npm ci
npm run package:mac:arm64
```

The output contains a DMG installer and ZIP archive under `release/`.

## Windows ARM64

```powershell
npm ci
npm run package:win:arm64
```

The output contains an NSIS `.exe` installer under `release/`.

You can also run `Build-Windows-ARM64.ps1` from PowerShell.

## CI and releases

`.github/workflows/ci.yml` runs a source validation build. `.github/workflows/release.yml` builds the Apple Silicon DMG/ZIP on a macOS ARM64 runner and the Windows ARM64 NSIS installer on a Windows ARM64 runner. It attaches all assets and a SHA-256 manifest to a GitHub Release when a `v*` tag is pushed or the workflow is manually dispatched.

GitHub's standard hosted ARM64 macOS and Windows runners are available for public repositories; private repositories require eligible larger or self-hosted runners. See [GitHub-hosted runner documentation](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

## Signing and notarization

Signing is intentionally not configured by default. A maintainer can add Apple Developer ID signing/notarization credentials and a Windows code-signing certificate using repository secrets, then configure electron-builder's signing options. Never commit certificates, private keys, or signing passwords.
