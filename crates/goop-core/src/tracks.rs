use crate::{ConvertRequest, GoopError, TargetFormat};
use serde::{de::Error as _, Deserialize, Deserializer, Serialize};
use std::collections::BTreeMap;
use ts_rs::TS;

pub const TRACK_INVENTORY_VERSION: u32 = 1;
pub const TRACK_SOURCE_BINDING_VERSION: u32 = 1;
pub const MAX_TRACK_STREAMS: usize = 128;
pub const MAX_TRACK_TEXT_BYTES: usize = 512;
pub const MAX_TRACK_SOURCE_BINDING_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum TrackTextFact {
    Missing,
    Value { value: String },
    Malformed,
}

impl<'de> Deserialize<'de> for TrackTextFact {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "snake_case", tag = "kind", deny_unknown_fields)]
        enum StrictTextFact {
            Missing {},
            Value { value: String },
            Malformed {},
        }

        let fact = match StrictTextFact::deserialize(deserializer)? {
            StrictTextFact::Missing {} => Self::Missing,
            StrictTextFact::Value { value } => Self::Value { value },
            StrictTextFact::Malformed {} => Self::Malformed,
        };
        validate_track_text_fact_inner(&fact).map_err(D::Error::custom)?;
        Ok(fact)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct TrackDispositionFacts {
    pub default: Option<bool>,
    pub forced: Option<bool>,
    pub attached_pic: Option<bool>,
    pub other: BTreeMap<String, bool>,
    pub malformed: bool,
}

impl<'de> Deserialize<'de> for TrackDispositionFacts {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct StrictDisposition {
            default: Option<bool>,
            forced: Option<bool>,
            attached_pic: Option<bool>,
            other: BTreeMap<String, bool>,
            malformed: bool,
        }

        let raw = StrictDisposition::deserialize(deserializer)?;
        let facts = Self {
            default: raw.default,
            forced: raw.forced,
            attached_pic: raw.attached_pic,
            other: raw.other,
            malformed: raw.malformed,
        };
        validate_track_disposition_inner(&facts).map_err(D::Error::custom)?;
        Ok(facts)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct TrackIdentity {
    pub index: u32,
    pub codec_type: String,
    pub codec_name: TrackTextFact,
    pub container_stream_id: TrackTextFact,
    pub language: TrackTextFact,
    pub title: TrackTextFact,
    pub disposition: TrackDispositionFacts,
}

impl<'de> Deserialize<'de> for TrackIdentity {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct StrictIdentity {
            index: u32,
            codec_type: String,
            codec_name: TrackTextFact,
            container_stream_id: TrackTextFact,
            language: TrackTextFact,
            title: TrackTextFact,
            disposition: TrackDispositionFacts,
        }

        let raw = StrictIdentity::deserialize(deserializer)?;
        let identity = Self {
            index: raw.index,
            codec_type: raw.codec_type,
            codec_name: raw.codec_name,
            container_stream_id: raw.container_stream_id,
            language: raw.language,
            title: raw.title,
            disposition: raw.disposition,
        };
        validate_track_identity_inner(&identity).map_err(D::Error::custom)?;
        Ok(identity)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct TrackInventory {
    pub version: u32,
    pub streams: Vec<TrackIdentity>,
}

impl<'de> Deserialize<'de> for TrackInventory {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct StrictInventory {
            version: u32,
            streams: Vec<TrackIdentity>,
        }

        let raw = StrictInventory::deserialize(deserializer)?;
        let inventory = Self {
            version: raw.version,
            streams: raw.streams,
        };
        validate_track_inventory_inner(&inventory).map_err(D::Error::custom)?;
        Ok(inventory)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
pub struct TrackSourceBinding {
    pub version: u32,
    pub canonical_path: String,
    pub size_bytes: String,
    pub modified_unix_ns: String,
    pub inventory: TrackInventory,
}

impl<'de> Deserialize<'de> for TrackSourceBinding {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct StrictBinding {
            version: u32,
            canonical_path: String,
            size_bytes: String,
            modified_unix_ns: String,
            inventory: TrackInventory,
        }

        let raw = StrictBinding::deserialize(deserializer)?;
        let binding = Self {
            version: raw.version,
            canonical_path: raw.canonical_path,
            size_bytes: raw.size_bytes,
            modified_unix_ns: raw.modified_unix_ns,
            inventory: raw.inventory,
        };
        validate_track_source_binding_inner(&binding).map_err(D::Error::custom)?;
        Ok(binding)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum TrackConvertOptions {
    Audio {
        source: TrackSourceBinding,
        stream_index: u32,
    },
}

impl<'de> Deserialize<'de> for TrackConvertOptions {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "snake_case", tag = "kind", deny_unknown_fields)]
        enum StrictOptions {
            Audio {
                source: TrackSourceBinding,
                stream_index: u32,
            },
        }

        let options = match StrictOptions::deserialize(deserializer)? {
            StrictOptions::Audio {
                source,
                stream_index,
            } => Self::Audio {
                source,
                stream_index,
            },
        };
        validate_track_options_inner(&options).map_err(D::Error::custom)?;
        Ok(options)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum TrackPresetSelection {
    ChoosePerFile,
}

impl<'de> Deserialize<'de> for TrackPresetSelection {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "snake_case", tag = "kind", deny_unknown_fields)]
        enum StrictSelection {
            ChoosePerFile {},
        }

        Ok(match StrictSelection::deserialize(deserializer)? {
            StrictSelection::ChoosePerFile {} => Self::ChoosePerFile,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case", tag = "kind")]
pub enum TrackPresetPolicy {
    Audio { selection: TrackPresetSelection },
}

impl<'de> Deserialize<'de> for TrackPresetPolicy {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(rename_all = "snake_case", tag = "kind", deny_unknown_fields)]
        enum StrictPolicy {
            Audio { selection: TrackPresetSelection },
        }

        Ok(match StrictPolicy::deserialize(deserializer)? {
            StrictPolicy::Audio { selection } => Self::Audio { selection },
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(deny_unknown_fields)]
pub struct TrackExecutionSummary {
    pub requested: TrackConvertOptions,
    pub selected: TrackIdentity,
    pub dropped_audio: Vec<TrackIdentity>,
    pub dropped_other: Vec<TrackIdentity>,
    pub output_stream_index: u32,
    pub notices: Vec<String>,
}

pub fn validate_track_text_fact(fact: &TrackTextFact) -> Result<(), GoopError> {
    validate_track_text_fact_inner(fact).map_err(GoopError::InvalidRequest)
}

pub fn validate_track_disposition(facts: &TrackDispositionFacts) -> Result<(), GoopError> {
    validate_track_disposition_inner(facts).map_err(GoopError::InvalidRequest)
}

pub fn validate_track_identity(identity: &TrackIdentity) -> Result<(), GoopError> {
    validate_track_identity_inner(identity).map_err(GoopError::InvalidRequest)
}

pub fn validate_track_inventory(inventory: &TrackInventory) -> Result<(), GoopError> {
    validate_track_inventory_inner(inventory).map_err(GoopError::InvalidRequest)
}

pub fn validate_track_source_binding(source: &TrackSourceBinding) -> Result<(), GoopError> {
    validate_track_source_binding_inner(source).map_err(GoopError::InvalidRequest)
}

pub fn validate_track_options(options: &TrackConvertOptions) -> Result<(), GoopError> {
    validate_track_options_inner(options).map_err(GoopError::InvalidRequest)
}

pub fn validate_track_request(request: &ConvertRequest) -> Result<(), GoopError> {
    let Some(options) = &request.track_options else {
        return Ok(());
    };

    validate_track_options(options)?;
    if !matches!(
        request.target,
        TargetFormat::Mp3
            | TargetFormat::M4a
            | TargetFormat::Aac
            | TargetFormat::Wav
            | TargetFormat::Flac
    ) {
        return Err(GoopError::InvalidRequest(
            "Audio track selection requires MP3, M4A, AAC, WAV or FLAC output".into(),
        ));
    }
    if request.audio_options.is_none() {
        return Err(GoopError::InvalidRequest(
            "Audio track selection requires Copy audio or Custom encode".into(),
        ));
    }

    crate::validate_audio_request(request)
}

fn validate_track_text_fact_inner(fact: &TrackTextFact) -> Result<(), String> {
    if let TrackTextFact::Value { value } = fact {
        validate_text_bytes("Track text fact", value)?;
    }
    Ok(())
}

fn validate_track_disposition_inner(facts: &TrackDispositionFacts) -> Result<(), String> {
    for name in facts.other.keys() {
        validate_text_bytes("Track disposition name", name)?;
    }
    Ok(())
}

fn validate_track_identity_inner(identity: &TrackIdentity) -> Result<(), String> {
    validate_text_bytes("Track codec type", &identity.codec_type)?;
    validate_track_text_fact_inner(&identity.codec_name)?;
    validate_track_text_fact_inner(&identity.container_stream_id)?;
    validate_track_text_fact_inner(&identity.language)?;
    validate_track_text_fact_inner(&identity.title)?;
    validate_track_disposition_inner(&identity.disposition)
}

fn validate_track_inventory_inner(inventory: &TrackInventory) -> Result<(), String> {
    if inventory.version != TRACK_INVENTORY_VERSION {
        return Err(format!(
            "Unsupported track inventory version {}; expected {TRACK_INVENTORY_VERSION}",
            inventory.version
        ));
    }
    if inventory.streams.len() > MAX_TRACK_STREAMS {
        return Err(format!(
            "Track inventory contains more than {MAX_TRACK_STREAMS} streams"
        ));
    }

    let mut previous_index = None;
    for stream in &inventory.streams {
        validate_track_identity_inner(stream)?;
        if previous_index == Some(stream.index) {
            return Err(format!(
                "Track inventory contains duplicate stream index {}",
                stream.index
            ));
        }
        if previous_index.is_some_and(|previous| previous > stream.index) {
            return Err("Track inventory streams must be ordered by absolute index".into());
        }
        previous_index = Some(stream.index);
    }
    Ok(())
}

fn validate_track_source_binding_inner(source: &TrackSourceBinding) -> Result<(), String> {
    if source.version != TRACK_SOURCE_BINDING_VERSION {
        return Err(format!(
            "Unsupported track source binding version {}; expected {TRACK_SOURCE_BINDING_VERSION}",
            source.version
        ));
    }
    validate_canonical_u64("Track source size", &source.size_bytes)?;
    validate_canonical_u64("Track source modification time", &source.modified_unix_ns)?;
    validate_track_inventory_inner(&source.inventory)?;

    let bytes = serde_json::to_vec(source)
        .map_err(|error| format!("Could not measure track source binding: {error}"))?;
    if bytes.len() > MAX_TRACK_SOURCE_BINDING_BYTES {
        return Err(format!(
            "Track source binding exceeds {MAX_TRACK_SOURCE_BINDING_BYTES} bytes"
        ));
    }
    Ok(())
}

fn validate_track_options_inner(options: &TrackConvertOptions) -> Result<(), String> {
    match options {
        TrackConvertOptions::Audio {
            source,
            stream_index,
        } => {
            validate_track_source_binding_inner(source)?;
            let selected = source
                .inventory
                .streams
                .iter()
                .find(|stream| stream.index == *stream_index)
                .ok_or_else(|| {
                    format!("Selected audio stream index {stream_index} is not in the source")
                })?;
            if selected.codec_type != "audio" {
                return Err(format!(
                    "Selected stream index {stream_index} is not an audio stream"
                ));
            }
        }
    }
    Ok(())
}

fn validate_text_bytes(label: &str, value: &str) -> Result<(), String> {
    if value.len() > MAX_TRACK_TEXT_BYTES {
        return Err(format!(
            "{label} exceeds {MAX_TRACK_TEXT_BYTES} UTF-8 bytes"
        ));
    }
    Ok(())
}

fn validate_canonical_u64(label: &str, value: &str) -> Result<u64, String> {
    if value.is_empty()
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(format!(
            "{label} must be a canonical unsigned decimal string"
        ));
    }
    value
        .parse::<u64>()
        .map_err(|_| format!("{label} is outside the unsigned 64-bit range"))
}
