# Checksum-signature fixtures

Fixtures for `src/signature.rs` and the two updaters' signature tests.

## Real upstream releases

Verified against the pinned production keys in `keys/`:

| File | Source |
|---|---|
| `yt-dlp-2026.10.21.SHA2-256SUMS` (+ `.sig`) | `https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.21/` |
| `gallery-dl-v1.32.17.SHA256SUMS` (+ `.sig`) | `https://codeberg.org/mikf/gallery-dl/releases/download/v1.32.17/` |

## Test keys

`test-key.asc`, `other-key.asc` and `ed25519-key.asc` are public halves of
throwaway keys that exist only for these tests. The secret halves were
discarded after signing, so these fixtures cannot be re-signed. To add a case,
generate a new key and keep its fixtures separate from these.

| Key | Fingerprint | Role |
|---|---|---|
| `test-key.asc` (RSA-2048) | `3AF4A28098BEFD0F20E9B3EDD6517E82BCCC23B0` | the key tests trust |
| `other-key.asc` (RSA-2048) | `EF2EC86A12818C439D478384AC9690709C7073E4` | a valid key nobody trusts |
| `ed25519-key.asc` | `21AA5F28B9FA512C2096C2D242A0977C1C4DD25A` | an algorithm the verifier refuses |

The keys were created with GnuPG 2.4.9 under `--faked-system-time
20190101T000000!`, for example:

```sh
gpg --batch --pinentry-mode loopback --passphrase '' \
  --quick-gen-key "Goop test signing key <test@goop.invalid>" rsa2048 sign never
```

## Signatures

Every signature is a binary detached signature (`--detach-sign`) made under
`--faked-system-time 20260101T000000!` with `--digest-algo SHA512`, by the test
key unless noted.

| File | Made with |
|---|---|
| `*.sums.sig`, `message.txt.sig` | defaults above |
| `*.sums.other.sig`, `message.txt.other.sig` | `-u` the other key |
| `message.txt.sha256.sig` | `--digest-algo SHA256` |
| `message.txt.sha1.sig` | `--digest-algo SHA1` |
| `message.txt.text.sig` | `--textmode` (signature type 0x01) |
| `message.txt.notation.sig` | `--sig-notation 'note@goop.invalid=1'` |
| `message.txt.critical-notation.sig` | `--sig-notation '!critical@goop.invalid=1'` |
| `message.txt.expires-later.sig` | `--default-sig-expire 10y` |
| `message.txt.expired.sig` | `--default-sig-expire 1d` under `--faked-system-time 20200101T000000!` |
| `message.txt.asc` | `--armor` |
| `message.txt.ed25519.sig` | `-u` the ed25519 key |

## Checksum manifests

Each `*.sums` file is one line, `<sha256>  <asset>`, naming a payload that a
test serves:

| File | Payload |
|---|---|
| `yt-dlp-newer.sums` | `#!/bin/sh\necho 2026.07.04\n` |
| `yt-dlp-older.sums` | `#!/bin/sh\necho 2026.01.01\n` |
| `yt-dlp-broken.sums` | the four bytes `00 01 02 03` |
| `gallery-dl-newer.sums` | `#!/bin/sh\necho 9.99.0\n` |
| `gallery-dl-older.sums` | `#!/bin/sh\necho 1.5.0\n` |
