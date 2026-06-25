#!/usr/bin/env bash
# scripts/macos-dylib-bundle.sh
#
# Sourceable helper that defines bundle_macos_dylibs(). Called by
# scripts/fetch-sidecars.sh (for sidecar binaries — primarily tesseract
# since v0.2.4). Originally factored out for an in-flight libheif
# bundle step that v0.2.6 deferred; the helper itself stays useful for
# any future Homebrew-installed dylib graph we need to bundle into the
# .app.
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
                        #
                        # -L is load-bearing: /opt/homebrew/opt/<formula> are
                        # symlinks into ../Cellar, and plain `find` will not
                        # descend through a symlink. Without it the scan never
                        # reaches the real lib dirs, so @rpath deps that live in
                        # a sibling formula (e.g. libwebp's
                        # @rpath/libsharpyuv.0.dylib under opt/webp/lib) silently
                        # go unresolved — they never get copied and their load
                        # commands are left pointing at a path absent from the
                        # bundle.
                        # -maxdepth bounds the walk (opt/<formula>/lib/<file>
                        # is 3 levels) so a pathological formula symlink can't
                        # send `find -L` on a long chase.
                        #
                        # `head -1` assumes the basename is unique under
                        # /opt/homebrew/opt. It is for the current gs+tesseract
                        # closure; if a future formula bump introduces a
                        # same-basename collision the wrong (still arm64) copy
                        # could win. The whole scheme is basename-keyed, so a
                        # collision is worth a deliberate look — the load-command
                        # sweep in fetch-sidecars.sh is the runtime backstop.
                        resolved_path="$(find -L /opt/homebrew/opt -maxdepth 6 -name "$rel" -type f 2>/dev/null | head -1)"
                    fi
                    [ -z "$resolved_path" ] && {
                        # Unresolvable @rpath dep: we cannot co-locate it, so the
                        # parent's load command would dangle on a clean Mac. Fail
                        # the build loudly rather than ship a dyld-fault — the
                        # basename drift guard can't see a dep that was never
                        # copied. (Sourced under `set -euo pipefail`; `return 1`
                        # aborts the caller.)
                        echo "::error::cannot resolve $dep_path for $current — not bundleable as a sibling" >&2
                        return 1
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

    # Two hardening passes over everything we just bundled.
    #
    # 1. Add @loader_path to each Mach-O's rpath list. The rewrites above
    #    turn every dep we resolved into @loader_path/<name>, but a file
    #    can still carry an @rpath/<name> reference we failed to resolve
    #    at copy time. With the whole dependency closure now sitting in
    #    one directory, an @loader_path rpath makes any such lookup fall
    #    back to the co-located sibling instead of a missing Homebrew
    #    path. (-add_rpath errors if the entry already exists; ignore it.)
    #
    # 2. install_name_tool invalidates each file's ad-hoc code signature,
    #    and a *stale* signature is fatal under the hardened runtime — the
    #    kernel SIGKILLs the sidecar before it runs. Re-sign ad-hoc so the
    #    signatures are valid again. Tauri re-signs the sidecar binary with
    #    the app entitlements during bundling; the sibling dylibs keep this
    #    ad-hoc signature, which the disable-library-validation entitlement
    #    on the binary permits it to load.
    local f
    for f in "$target_bin" "$out_dir"/*.dylib; do
        [ -f "$f" ] || continue
        install_name_tool -add_rpath @loader_path "$f" 2>/dev/null || true
        codesign --force --sign - "$f"
    done
}
