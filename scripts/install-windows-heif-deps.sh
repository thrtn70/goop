#!/usr/bin/env bash
# Install the reviewed Windows HEIC decode stack from an immutable vcpkg tree.
set -euo pipefail

VCPKG_DIRECTORY="C:/vcpkg"
VCPKG_COMMIT="0635f447edcc25f50645afade4e91a229a35fcdc"

git -C "$VCPKG_DIRECTORY" fetch --depth 1 origin "$VCPKG_COMMIT"
git -C "$VCPKG_DIRECTORY" checkout --detach "$VCPKG_COMMIT"
"$VCPKG_DIRECTORY/bootstrap-vcpkg.bat" -disableMetrics

# [core] suppresses the default x265 encoder while retaining libde265 decode.
"$VCPKG_DIRECTORY/vcpkg.exe" install "libheif[core]:x64-windows-static"
