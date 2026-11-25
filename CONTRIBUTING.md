# Contributing

Thanks for considering a contribution.

## Before opening a pull request

1. Open an issue describing the problem or proposed change.
2. Keep changes focused and preserve the target-only lifecycle: attacker VMs must remain manually managed.
3. Do not add automatic guest-side script transfer or execution.
4. Do not weaken archive traversal checks or the disposable base-disk overlay behavior.

## Development

```bash
npm ci
npm run dev
```

Before submitting:

```bash
npm run build
```

For platform packaging, use the corresponding native runner or local host:

```bash
npm run package:mac:arm64
npm run package:win:arm64
```

## Pull request checklist

- [ ] Explain the behavior change and affected platform(s).
- [ ] Add or update documentation.
- [ ] `npm run build` passes.
- [ ] Do not commit installer artifacts, VM images, credentials, or private signing material.
