# HEIC preview evidence fixtures

These deterministic HEIC files exercise the bounded associated-thumbnail sampler with
large primary metadata, the exact four-million-pixel thumbnail boundary, and a real
Display P3 ICC profile. They were generated on macOS arm64 with ImageMagick 7.1.2-19
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
  -profile '/System/Library/ColorSync/Profiles/sRGB Profile.icc' \
  -profile '/System/Library/ColorSync/Profiles/Display P3.icc' display-p3.png
heif-enc --hevc -q 80 -t 64 --no-alpha --no-thumb-alpha \
  --enable-two-colr-boxes -o display-p3.heic display-p3.png
```

heif-enc associates the raw Display P3 ICC property with the primary and its NCLX
property with the thumbnail. In the exact generated file, byte `0x472` is changed from
property index `0x03` (NCLX) to `0x02` (the existing raw ICC property), producing a
standards-valid 64 x 48 associated thumbnail with the real 536-byte profile. The test
requires libheif to return the profile and verifies its ICC `acsp` signature.

Profile inputs:

- macOS sRGB Profile.icc SHA-256: `2b3aa1645779a9e634744faf9b01e9102b0c9b88fd6deced7934df86b949af7e`
- macOS Display P3.icc SHA-256: `0ff6958f98684c61f6bbdce1368ddeaf3873baf84545baba482e920d92a914c0`

Fixture SHA-256 values:

- `heic-memory-primary-12mp-padded.heic`: `03c60b9cf6a91f79b90807c411b21f34ac4b44c8242b21e7247481b02171c1ef`
- `heic-memory-primary-48mp.heic`: `b2a1c163884edbe688353bc1d604828ac8b3e063f8aa7b3f0cdd87b4126e612e`
- `heic-memory-thumbnail-4mp.heic`: `ec1e5f418a2355f50c0978cc5b3e62c249a29317f53504e7c8c74e16d635178b`
- `heic-display-p3-thumbnail.heic`: `20b4ae2a409883aded652c1d589ee7bb64b7e8a7269671a5305aa40b64cd222f`

These fixtures demonstrate the sampler boundary only. They do not establish a
whole-application memory ceiling, camera color fidelity, Windows runtime behavior, or
desktop feature enablement.
