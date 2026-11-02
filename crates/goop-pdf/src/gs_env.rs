use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// Point a Ghostscript command at the bundled `<gs-resources>` tree.
///
/// `GS_LIB` is a search path, and gs does not look below its entries: given
/// only `<gs-resources>` it never finds `Resource/Init/gs_init.ps` and falls
/// back to the install prefix compiled into the binary. That prefix is the
/// Homebrew Cellar the sidecar was copied from, so a user without that exact
/// Homebrew version gets "Can't find initialization file gs_init.ps". List the
/// same directories gs searches under its own prefix, rooted in the bundle.
pub fn apply_gs_resources(
    cmd: &mut tokio::process::Command,
    gs_resource_dir: &Path,
) -> Result<(), std::env::JoinPathsError> {
    cmd.env("GS_LIB", gs_lib_search_path(gs_resource_dir)?);
    cmd.arg(gs_generic_resource_dir_arg(gs_resource_dir));
    Ok(())
}

fn gs_lib_search_path(gs_resource_dir: &Path) -> Result<OsString, std::env::JoinPathsError> {
    std::env::join_paths(gs_lib_dirs(gs_resource_dir))
}

fn gs_lib_dirs(gs_resource_dir: &Path) -> [PathBuf; 4] {
    [
        gs_resource_dir.join("Resource").join("Init"),
        gs_resource_dir.join("lib"),
        gs_resource_dir.join("Resource").join("Font"),
        gs_resource_dir.join("iccprofiles"),
    ]
}

/// Ghostscript's `GenericResourceDir` is where it looks for CMaps, fonts,
/// and ICC profiles. Without it gs warns that GenericResourceDir is invalid
/// and can miss resources for exotic PDFs (CJK CMaps, non-embedded fonts,
/// specific color spaces). gs appends category subdirs (`Init/`, `Font/`,
/// `CMap/`, …), so the value must end in a separator. We use `/` (not
/// `MAIN_SEPARATOR`): gs accepts forward slashes on every platform, and a
/// trailing `\` on Windows would be swallowed by `CreateProcess` arg-quoting
/// when the path contains spaces (the `\"` escapes the closing quote).
fn gs_generic_resource_dir_arg(gs_resource_dir: &Path) -> String {
    format!(
        "-sGenericResourceDir={}/",
        gs_resource_dir.join("Resource").display()
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn configured(dir: &Path) -> (Vec<(OsString, Option<OsString>)>, Vec<OsString>) {
        let mut cmd = tokio::process::Command::new("gs");
        apply_gs_resources(&mut cmd, dir).unwrap();
        let std_cmd = cmd.as_std();
        let envs = std_cmd
            .get_envs()
            .map(|(k, v)| (k.to_os_string(), v.map(|v| v.to_os_string())))
            .collect();
        let args = std_cmd.get_args().map(|a| a.to_os_string()).collect();
        (envs, args)
    }

    #[test]
    fn gs_lib_lists_the_bundled_init_lib_font_and_icc_dirs_in_search_order() {
        let dir = Path::new("/opt/app/gs-resources");
        let (envs, _) = configured(dir);
        let expected = std::env::join_paths([
            dir.join("Resource").join("Init"),
            dir.join("lib"),
            dir.join("Resource").join("Font"),
            dir.join("iccprofiles"),
        ])
        .unwrap();
        assert_eq!(envs, vec![(OsString::from("GS_LIB"), Some(expected))]);
    }

    #[cfg(unix)]
    #[test]
    fn gs_lib_is_a_colon_separated_search_path_on_unix() {
        let (envs, _) = configured(Path::new("/opt/app/gs-resources"));
        assert_eq!(
            envs[0].1.as_deref(),
            Some(std::ffi::OsStr::new(
                "/opt/app/gs-resources/Resource/Init:/opt/app/gs-resources/lib:\
                 /opt/app/gs-resources/Resource/Font:/opt/app/gs-resources/iccprofiles"
            ))
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_resource_dir_containing_the_path_separator_is_rejected() {
        let mut cmd = tokio::process::Command::new("gs");
        assert!(apply_gs_resources(&mut cmd, Path::new("/Volumes/a:b/gs-resources")).is_err());
        assert_eq!(cmd.as_std().get_envs().count(), 0);
        assert_eq!(cmd.as_std().get_args().count(), 0);
    }

    #[test]
    fn generic_resource_dir_arg_targets_resource_subdir_with_trailing_separator() {
        let (_, args) = configured(Path::new("/opt/app/gs-resources"));
        assert_eq!(args.len(), 1);
        let arg = args[0].to_string_lossy();
        assert!(arg.starts_with("-sGenericResourceDir="));
        assert!(arg.contains("gs-resources"));
        assert!(arg.contains("Resource"));
        assert!(arg.ends_with('/'));
    }
}
