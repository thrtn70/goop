# HEIC preview evidence fixtures

These deterministic HEIC files exercise the bounded associated-thumbnail sampler with
large primary metadata, the exact four-million-pixel thumbnail boundary, and a
project-generated Display P3 ICC profile. They were generated on macOS arm64 with
Little CMS through `lcms2` 6.2.0, ImageMagick 7.1.2-19,
and libheif/heif-enc 1.21.2.

## Equal-size 12 MP and 48 MP pair

The two inputs are exactly 11,717 bytes. Their 512 x 384 associated-thumbnail item
payloads are byte-identical even though their primary images are 4000 x 3000 and
8000 x 6000. The 12 MP file has one top-level ISO BMFF `free` box appended after its
media data to match the 48 MP container size without changing any item offset.

```sh
magick -size 4000x3000 xc:'#7a5d3f' -strip primary-12mp.png
magick -size 8000x6000 xc:'#7a5d3f' -strip primary-48mp.png
heif-enc --hevc -q 12 -t 512 --no-alpha --no-thumb-alpha \
  -o primary-12mp.heic primary-12mp.png
heif-enc --hevc -q 12 -t 512 --no-alpha --no-thumb-alpha \
  -o primary-48mp.heic primary-48mp.png
```

For these exact encoder outputs, `heif-info -d` reports the thumbnail payload at
`3568..3659` in the 12 MP file and `11626..11717` in the 48 MP file. The test asserts
those 91-byte ranges are identical. The appended `free` box is 8,058 bytes: a 32-bit
big-endian box size, the ASCII type `free`, and zero-filled payload.

## Exact four-million-pixel thumbnail

```sh
magick -size 3600x3600 xc:'#7a5d3f' -strip near-limit.png
heif-enc --hevc -q 12 -t 2000 --no-alpha --no-thumb-alpha \
  -o heic-memory-thumbnail-4mp.heic near-limit.png
```

The associated thumbnail is exactly 2000 x 2000 pixels and decodes to a 12,000,000-byte
packed RGB buffer, below the separate 16 MiB decoded-buffer limit.

## Display P3 ICC thumbnail

```sh
magick -size 192x144 gradient:'#234f3d-#d9b56d' \
  -profile generated-display-p3.icc display-p3.png
heif-enc --hevc -q 80 -t 64 --no-alpha --no-thumb-alpha \
  --enable-two-colr-boxes -o display-p3.heic display-p3.png
```

The 584-byte ICC profile is generated from the public Display P3 chromaticities
(D65 white; red 0.680/0.320, green 0.265/0.690, blue 0.150/0.060) and the standard
sRGB parametric transfer curve. Little CMS serializes it without third-party profile
bytes; the header timestamp is normalized to 2026-09-14 00:00:00 for deterministic
fixture identity.

heif-enc associates the raw ICC property with the primary and the NCLX property with
the thumbnail. The fixture post-processing adds the existing raw ICC property to the
thumbnail's `ipma` association list, increments the enclosing box sizes, and shifts
the two `iloc` media offsets by one byte. `heif-info -d` therefore reports both property
index 2 (`prof`) and property index 3 (`nclx`) on the standards-valid 64 x 48 associated
thumbnail. The regression test independently decodes with libheif's NCLX passthrough
option and requires the sampler to return those unconverted pixels for one later ICC
normalization. The NCLX property declares Display P3 primaries (12), the sRGB transfer
curve (13), ITU-R BT.601 matrix coefficients (6), and full range. With the pinned
libheif 1.23 ABI, the raw ICC profile takes precedence even when an NCLX output profile
is requested; the regression records that behavior and the explicit passthrough setting
keeps the intended single-normalization contract stable if the library behavior changes.

Generated profile SHA-256:

- `generated-display-p3.icc`: `656b9373a5a1af04c68300c3edabf9c9d1f83973d0348244ff0c9372edc5040e`

Fixture SHA-256 values:

- `heic-memory-primary-12mp-padded.heic`: `03c60b9cf6a91f79b90807c411b21f34ac4b44c8242b21e7247481b02171c1ef`
- `heic-memory-primary-48mp.heic`: `b2a1c163884edbe688353bc1d604828ac8b3e063f8aa7b3f0cdd87b4126e612e`
- `heic-memory-thumbnail-4mp.heic`: `ec1e5f418a2355f50c0978cc5b3e62c249a29317f53504e7c8c74e16d635178b`
- `heic-display-p3-thumbnail.heic`: `1e1cdd45830afdc2d64898bc8f6e4b7b94df571fedacf7bb7854a2a1fbb05bc1`

These fixtures demonstrate the sampler boundary only. They do not establish a
whole-application memory ceiling, camera color fidelity, Windows runtime behavior, or
desktop feature enablement.
