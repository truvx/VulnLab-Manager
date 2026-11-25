# Security Policy

## Supported versions

Security fixes are intended for the latest release. Older releases may not receive patches.

## Reporting a vulnerability

Please do not publish exploit details for an unpatched issue in a public issue. Open a private security advisory through GitHub's **Security → Advisories** page once enabled, or contact the repository maintainer privately.

Include the affected version, host OS, reproduction steps, and impact. Do not include real credentials, private VM images, or sensitive data.

## Safe use

- Treat imported VM images and archives as untrusted.
- Keep vulnerable targets isolated from trusted networks.
- Do not run the optional network helper against an interface that carries your normal internet connection.
- The app should not require administrator privileges for normal operation.
- Keep QEMU and the host OS patched.
