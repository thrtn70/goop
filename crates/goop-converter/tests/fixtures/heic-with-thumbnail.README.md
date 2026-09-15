# HEIC thumbnail fixture

`heic-with-thumbnail.heic` is a deterministic 96 x 72 HEIC with one 32 x 24
associated thumbnail. It was generated on macOS with libheif 1.21.2:

```sh
magick -size 96x72 gradient:'#234f3d-#d9b56d' -strip source.png
heif-enc --hevc -q 80 -t 32 --no-alpha --no-thumb-alpha \
  -o heic-with-thumbnail.heic source.png
```

SHA-256: `e2057d3957b4879e66e71b56484f4b56aae529ad44fdf9d144779fcdab075851`

This first sampler fixture proves the positive associated-thumbnail path only.
Capability enablement remains gated on later fixtures and evidence for rotated
thumbnail transforms, malformed and oversized thumbnail payloads, 12 MP and 48 MP
primaries sharing the same thumbnail bytes, a near-4-million-pixel thumbnail, and
the documented macOS arm64 and Windows x64 peak-memory protocol.
