#!/usr/bin/env bash
# scripts/macos-dylib-bundle.sh
#
# Sourceable helper that defines bundle_macos_dylibs(). Called by
# scripts/fetch-sidecars.sh (for sidecar binaries) and
# .github/workflows/release.yml (for the post-tauri-build .app bundle,
# specifically for libheif's dylib graph added in v0.2.6).
#
# Bundle Mach-O dylib dependencies into the binary's directory and
# rewrite the binary's load commands to resolve them via @loader_path.
# This lets users without Homebrew installed at /opt/homebrew run the
# binary — every non-system dylib it depends on is co-located.
#
# BFS over the binary's non-system dylib deps:
#   - copy each into the binary's directory (preserving basename)
#   - install_name_tool -id @loader_path/<basename> on the copy
#   - install_name_tool -change <orig> @loader_path/<basename> on the
#     binary/dylib that depends on it
#   - recurse into the copied dylib's own deps
# System paths (/usr/lib, /System) are universally available and skipped.
bundle_macos_dylibs() {
    local target_bin="$1"
    local out_dir
    out_dir="$(dirname "$target_bin")"
    # Visited set keyed by absolute path string ; bash 3 has no
    # associative arrays, so we serialise.
    local visited=""
    local queue=("$target_bin")
    while [ "${#queue[@]}" -gt 0 ]; do
        local current="${queue[0]}"
        queue=("${queue[@]:1}")
        case "$visited" in
            *":$current:"*) continue ;;
        esac
        visited="${visited}:${current}:"

        # Build the rpath search list for `current` so we can resolve any
        # @rpath/<name> references (Homebrew libs use these heavily; e.g.
        # libwebp depends on @rpath/libsharpyuv.0.dylib which only
        # resolves against the binary's LC_RPATH entries).
        local rpaths=()
        while IFS= read -r rp; do
            [ -n "$rp" ] && rpaths+=("$rp")
        done < <(otool -l "$current" \
            | awk '/LC_RPATH/{found=1; next} found && /path /{print $2; found=0}')

        # otool first line is the binary itself; skip it. Each remaining
        # line is "\tpath (compatibility ...)" — extract the path.
        while IFS= read -r line; do
            local dep_path
            dep_path="$(printf '%s' "$line" | awk '{print $1}')"
            case "$dep_path" in
                ""|/usr/lib/*|/System/*) continue ;;
            esac

            # Resolve @rpath/<name> against the binary's LC_RPATH entries.
            local resolved_path="$dep_path"
            case "$dep_path" in
                @rpath/*)
                    local rel="${dep_path#@rpath/}"
                    resolved_path=""
                    for rp in "${rpaths[@]}"; do
                        if [ -f "$rp/$rel" ]; then
                            resolved_path="$rp/$rel"
                            break
                        fi
                    done
                    if [ -z "$resolved_path" ]; then
                        # Last-resort fallback: scan Homebrew lib dirs. The
                        # dylibs we care about all live somewhere under
                        # /opt/homebrew/{lib,opt/*/lib}.
                        resolved_path="$(find /opt/homebrew/opt -name "$rel" -type f 2>/dev/null | head -1)"
                    fi
                    [ -z "$resolved_path" ] && {
                        echo "warning: could not resolve $dep_path for $current" >&2
                        continue
                    }
                    ;;
                @loader_path/*)
                    # Already bundled — nothing to do, the rewrite happened
                    # on an earlier pass over this `current`.
                    continue
                    ;;
            esac

            local dep_base
            dep_base="$(basename "$resolved_path")"
            local local_copy="$out_dir/$dep_base"

            # Skip self-references (libleptonica.6.dylib lists itself as
            # first dep in some Homebrew builds).
            if [ "$dep_base" = "$(basename "$current")" ]; then
                # Make sure the binary's own LC_ID_DYLIB points at the
                # @loader_path form, not the original Homebrew path.
                install_name_tool -id "@loader_path/$dep_base" "$current" 2>/dev/null || true
                continue
            fi

            if [ ! -f "$local_copy" ]; then
                cp "$resolved_path" "$local_copy"
                chmod +w "$local_copy"
                install_name_tool -id "@loader_path/$dep_base" "$local_copy"
                queue+=("$local_copy")
            fi
            install_name_tool -change "$dep_path" "@loader_path/$dep_base" "$current" 2>/dev/null || true
        done < <(otool -L "$current" | tail -n +2)
    done
}
