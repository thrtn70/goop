use serde::{Deserialize, Serialize};
use ts_rs::TS;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case")]
pub enum Source {
    YouTube,
    SoundCloud,
    TikTok,
    Instagram,
    Twitter,
    Vimeo,
    Reddit,
    Generic,
}

pub fn classify(url: &str) -> Source {
    let url_lc = url.to_lowercase();
    if url_lc.contains("youtube.com") || url_lc.contains("youtu.be") {
        return Source::YouTube;
    }
    if url_lc.contains("soundcloud.com") {
        return Source::SoundCloud;
    }
    if url_lc.contains("tiktok.com") {
        return Source::TikTok;
    }
    if url_lc.contains("instagram.com") {
        return Source::Instagram;
    }
    if url_lc.contains("twitter.com") || url_lc.contains("x.com") {
        return Source::Twitter;
    }
    if url_lc.contains("vimeo.com") {
        return Source::Vimeo;
    }
    if url_lc.contains("reddit.com") {
        return Source::Reddit;
    }
    Source::Generic
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_common_platforms() {
        assert_eq!(
            classify("https://www.youtube.com/watch?v=x"),
            Source::YouTube
        );
        assert_eq!(classify("https://youtu.be/abc"), Source::YouTube);
        assert_eq!(
            classify("https://soundcloud.com/user/track"),
            Source::SoundCloud
        );
        assert_eq!(
            classify("https://www.tiktok.com/@u/video/1"),
            Source::TikTok
        );
        assert_eq!(
            classify("https://www.instagram.com/reel/xyz"),
            Source::Instagram
        );
        assert_eq!(classify("https://twitter.com/u/status/1"), Source::Twitter);
        assert_eq!(classify("https://x.com/u/status/1"), Source::Twitter);
        assert_eq!(classify("https://vimeo.com/12345"), Source::Vimeo);
        assert_eq!(classify("https://reddit.com/r/video"), Source::Reddit);
    }

    #[test]
    fn classifies_generic_for_unknown() {
        assert_eq!(classify("https://example.com/media.mp4"), Source::Generic);
    }

    #[test]
    fn case_insensitive() {
        assert_eq!(classify("HTTPS://YOUTUBE.COM/abc"), Source::YouTube);
    }
}
