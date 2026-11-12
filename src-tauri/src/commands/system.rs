use goop_core::IpcError;

#[cfg(target_os = "macos")]
const SYSTEM_VERSION_PLIST: &str = "/System/Library/CoreServices/SystemVersion.plist";

#[tauri::command]
pub async fn system_os_version() -> Result<String, IpcError> {
    tokio::task::spawn_blocking(os_label)
        .await
        .ok()
        .flatten()
        .ok_or_else(|| IpcError::Unknown("the OS version is unavailable".into()))
}

#[cfg(target_os = "macos")]
fn os_label() -> Option<String> {
    let value = plist::Value::from_file(SYSTEM_VERSION_PLIST).ok()?;
    let dict = value.as_dictionary()?;
    let text = |key: &str| dict.get(key).and_then(plist::Value::as_string);
    macos_label(text("ProductVersion"), text("ProductBuildVersion"))
}

#[cfg(not(target_os = "macos"))]
fn os_label() -> Option<String> {
    None
}

fn macos_label(version: Option<&str>, build: Option<&str>) -> Option<String> {
    let version = version.map(str::trim).filter(|v| is_dotted_version(v))?;
    Some(match build.map(str::trim).filter(|b| is_build(b)) {
        Some(build) => format!("macOS {version} ({build})"),
        None => format!("macOS {version}"),
    })
}

fn is_dotted_version(text: &str) -> bool {
    let parts: Vec<&str> = text.split('.').collect();
    (1..=3).contains(&parts.len())
        && parts
            .iter()
            .all(|part| (1..=4).contains(&part.len()) && part.bytes().all(|b| b.is_ascii_digit()))
}

fn is_build(text: &str) -> bool {
    (1..=16).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_alphanumeric())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels_a_version_with_its_build() {
        assert_eq!(
            macos_label(Some("26.1"), Some("25B78")),
            Some("macOS 26.1 (25B78)".into())
        );
        assert_eq!(
            macos_label(Some(" 15.7.1 "), Some(" 24G231 ")),
            Some("macOS 15.7.1 (24G231)".into())
        );
    }

    #[test]
    fn leaves_out_a_missing_or_malformed_build() {
        assert_eq!(macos_label(Some("27.0"), None), Some("macOS 27.0".into()));
        assert_eq!(
            macos_label(Some("27.0"), Some("")),
            Some("macOS 27.0".into())
        );
        assert_eq!(
            macos_label(Some("27.0"), Some("26A 428")),
            Some("macOS 27.0".into())
        );
        assert_eq!(
            macos_label(Some("27.0"), Some("<b>")),
            Some("macOS 27.0".into())
        );
    }

    #[test]
    fn refuses_a_missing_or_malformed_version() {
        for version in [
            None,
            Some(""),
            Some("27."),
            Some(".1"),
            Some("27.0.1.2"),
            Some("x"),
            Some("27.0 beta"),
            Some("12345.0"),
        ] {
            assert_eq!(macos_label(version, Some("26A428")), None, "{version:?}");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn matches_sw_vers_on_this_mac() {
        let sw_vers = |flag: &str| {
            let out = std::process::Command::new("/usr/bin/sw_vers")
                .arg(flag)
                .output()
                .unwrap();
            assert!(out.status.success());
            String::from_utf8(out.stdout).unwrap().trim().to_string()
        };
        let expected = format!(
            "macOS {} ({})",
            sw_vers("-productVersion"),
            sw_vers("-buildVersion")
        );
        assert_eq!(os_label(), Some(expected));
    }
}
