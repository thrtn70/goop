use goop_sidecar::{BinaryResolver, ResolvedBinary};
use serde::Serialize;
use std::{collections::BTreeMap, path::PathBuf};

const REQUIRED_SIDECARS: [&str; 2] = ["ffmpeg", "ffprobe"];

#[derive(Clone, Debug, Serialize)]
pub(crate) struct SidecarEvidence {
    pub(crate) canonical_path: Option<PathBuf>,
    pub(crate) source_is_path: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<String>,
}

#[derive(Debug)]
pub(crate) struct RuntimeSidecarCheck {
    pub(crate) sidecars: BTreeMap<&'static str, SidecarEvidence>,
    pub(crate) error: Option<String>,
}

impl RuntimeSidecarCheck {
    pub(crate) fn into_parts(self) -> (BTreeMap<&'static str, SidecarEvidence>, Option<String>) {
        (self.sidecars, self.error)
    }
}

pub(crate) fn inspect(resolver: &BinaryResolver) -> RuntimeSidecarCheck {
    inspect_with(|name| resolver.resolve(name).map_err(|error| error.to_string()))
}

fn inspect_with(
    mut resolve: impl FnMut(&str) -> Result<ResolvedBinary, String>,
) -> RuntimeSidecarCheck {
    let mut sidecars = BTreeMap::new();
    let mut errors = Vec::new();
    for name in REQUIRED_SIDECARS {
        let evidence = match resolve(name) {
            Ok(resolved) => {
                let source_is_path = resolved.source_is_path;
                match resolved.path.canonicalize() {
                    Ok(canonical_path) => {
                        if source_is_path {
                            errors.push(format!(
                                "{name} resolved from PATH instead of the declared runtime sidecar directory: {}",
                                canonical_path.display()
                            ));
                        }
                        SidecarEvidence {
                            canonical_path: Some(canonical_path),
                            source_is_path: Some(source_is_path),
                            error: None,
                        }
                    }
                    Err(error) => {
                        let error = format!(
                            "could not canonicalize resolved {name} path {}: {error}",
                            resolved.path.display()
                        );
                        errors.push(error.clone());
                        SidecarEvidence {
                            canonical_path: None,
                            source_is_path: Some(source_is_path),
                            error: Some(error),
                        }
                    }
                }
            }
            Err(error) => {
                errors.push(error.clone());
                SidecarEvidence {
                    canonical_path: None,
                    source_is_path: None,
                    error: Some(error),
                }
            }
        };
        sidecars.insert(name, evidence);
    }
    RuntimeSidecarCheck {
        sidecars,
        error: (!errors.is_empty()).then(|| errors.join("; ")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    fn executable_name(stem: &str) -> String {
        if cfg!(windows) {
            format!("{stem}.exe")
        } else {
            stem.to_owned()
        }
    }

    #[test]
    fn reports_canonical_packaged_runtime_sidecars() {
        let dir = tempdir().unwrap();
        for name in REQUIRED_SIDECARS {
            std::fs::write(dir.path().join(executable_name(name)), b"fixture").unwrap();
        }
        let check = inspect(&BinaryResolver::new(dir.path().to_path_buf()));

        assert_eq!(check.error, None);
        for name in REQUIRED_SIDECARS {
            let evidence = &check.sidecars[name];
            assert_eq!(
                evidence.canonical_path.as_deref(),
                Some(
                    dir.path()
                        .join(executable_name(name))
                        .canonicalize()
                        .unwrap()
                        .as_path()
                )
            );
            assert_eq!(evidence.source_is_path, Some(false));
            assert_eq!(evidence.error, None);
        }
    }

    #[test]
    fn path_resolution_is_reported_and_rejected() {
        let dir = tempdir().unwrap();
        let executable = dir.path().join(executable_name("tool"));
        std::fs::write(&executable, b"fixture").unwrap();
        let check = inspect_with(|name| {
            Ok(ResolvedBinary {
                name: name.to_owned(),
                path: executable.clone(),
                source_is_path: true,
            })
        });

        assert!(check.error.as_deref().unwrap().contains("PATH"));
        for name in REQUIRED_SIDECARS {
            let evidence = &check.sidecars[name];
            assert_eq!(evidence.source_is_path, Some(true));
            assert_eq!(
                evidence.canonical_path.as_deref(),
                Some(executable.canonicalize().unwrap().as_path())
            );
        }
    }

    #[test]
    fn missing_resolution_keeps_an_explicit_schema_record() {
        let check = inspect_with(|name| Err(format!("{name} is missing")));

        assert!(check
            .error
            .as_deref()
            .unwrap()
            .contains("ffmpeg is missing"));
        assert_eq!(
            serde_json::to_value(&check.sidecars).unwrap(),
            json!({
                "ffmpeg": {
                    "canonical_path": null,
                    "source_is_path": null,
                    "error": "ffmpeg is missing"
                },
                "ffprobe": {
                    "canonical_path": null,
                    "source_is_path": null,
                    "error": "ffprobe is missing"
                }
            })
        );
    }

    #[test]
    fn canonicalization_failure_keeps_source_and_error_evidence() {
        let dir = tempdir().unwrap();
        let check = inspect_with(|name| {
            Ok(ResolvedBinary {
                name: name.to_owned(),
                path: dir.path().join(format!("missing-{name}")),
                source_is_path: false,
            })
        });

        assert!(check
            .error
            .as_deref()
            .unwrap()
            .contains("could not canonicalize resolved ffmpeg path"));
        for name in REQUIRED_SIDECARS {
            let evidence = &check.sidecars[name];
            assert_eq!(evidence.canonical_path, None);
            assert_eq!(evidence.source_is_path, Some(false));
            assert!(evidence
                .error
                .as_deref()
                .unwrap()
                .contains("could not canonicalize resolved"));
        }
    }
}
