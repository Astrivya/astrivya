# @astrivya/plugin-runtime

Lifecycle management for Astrivya plugins — sync, download, verify, and load
plugins at runtime.

## Install

```bash
npm install @astrivya/plugin-runtime
```

## Usage

The runtime discovers installed executable plugins, downloads and SHA-256
verifies tarballs from the configured manifest source, and loads their
commands and tools.

## Trust model

Plugin distribution is license-gated: the manifest is fetched with an
authenticated client and the download is integrity-verified against the
manifest's SHA-256. That check is **integrity, not DRM** — entitlement is
enforced server-side by Astrivya Cloud, and an installed plugin re-executes
without a license re-check on every load. This package contains no license
parsing or verification primitives; treat the authenticated manifest as the
only artifact trust anchor.

## License

Apache-2.0