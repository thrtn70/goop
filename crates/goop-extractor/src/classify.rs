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

/// Which extractor backend handles this URL by default.
///
/// `YtDlp` is the default for video/audio sites yt-dlp covers natively.
/// `GalleryDl` is preferred for image hosts and for Twitter/X (gallery-dl
/// handles both image+video tweet media via its native extractor; yt-dlp
/// covers single-video edge cases via the dispatcher's fallback).
///
/// `dispatch::run()` reads this and falls back to the other backend if
/// the chosen one returns a "no matching extractor" error — both
/// directions of fallback are supported.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../shared/types/")]
#[serde(rename_all = "snake_case")]
pub enum ExtractorChoice {
    YtDlp,
    GalleryDl,
}

/// Domains routed to gallery-dl by default. Substring match against the
/// lowercase URL — order doesn't matter; first match wins. Keep entries
/// minimal and grow this list as users surface real URLs that yt-dlp's
/// fallback can't handle.
const GALLERY_DL_DOMAINS: &[&str] = &[
    // Bunkr (mirrors / TLD churn)
    "bunkr.cr",
    "bunkr.fi",
    "bunkr.is",
    "bunkr.la",
    "bunkr.ph",
    "bunkr.ru",
    "bunkr.si",
    "bunkr.sk",
    // Anonymous file hosts
    "gofile.io",
    "pixeldrain.com",
    "pixeldrain.net",
    // Patreon-alternative aggregators
    "kemono.party",
    "kemono.su",
    "kemono.cr",
    "coomer.party",
    "coomer.su",
    // Cyberdrop / Saint family
    "cyberdrop.me",
    "cyberdrop.to",
    "cyberdrop.ru",
    "saint.to",
    "saint.pk",
    "saint2.su",
    // Image hosts (gallery-dl covers Imgur galleries / albums / user
    // profiles / subreddits / single image+video items; yt-dlp's imgur
    // extractor only handles single videos — gallery-dl is broader)
    "imagebam.com",
    "imgbox.com",
    "imgur.com",
    "i.imgur.com",
    "redgifs.com",
    // Twitter / X — gallery-dl handles both image+video tweet media
    // via its native extractor; yt-dlp covers single-video edge cases
    // via the dispatcher's fallback.
    "twitter.com",
    "x.com",
];

pub fn classify_extractor(url: &str) -> ExtractorChoice {
    let lc = url.to_lowercase();
    if GALLERY_DL_DOMAINS.iter().any(|d| lc.contains(d)) {
        ExtractorChoice::GalleryDl
    } else {
        ExtractorChoice::YtDlp
    }
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

    #[test]
    fn extractor_choice_routes_image_hosts_to_gallery_dl() {
        for url in [
            "https://bunkr.cr/a/abc",
            "https://bunkr.fi/v/foo.mp4",
            "https://gofile.io/d/xyz",
            "https://pixeldrain.com/u/abcd",
            "https://kemono.party/patreon/user/123",
            "https://coomer.su/onlyfans/user/xyz",
            "https://cyberdrop.me/a/abc",
            "https://saint.to/embed/abc",
            "https://imgur.com/gallery/abc",
            "https://i.imgur.com/abc.png",
            "https://redgifs.com/watch/abc",
            "https://imagebam.com/view/MEABCDE",
            "https://imgbox.com/g/abcde",
        ] {
            assert_eq!(
                classify_extractor(url),
                ExtractorChoice::GalleryDl,
                "expected GalleryDl for {url}"
            );
        }
    }

    #[test]
    fn extractor_choice_routes_twitter_x_to_gallery_dl() {
        assert_eq!(
            classify_extractor("https://twitter.com/u/status/1"),
            ExtractorChoice::GalleryDl
        );
        assert_eq!(
            classify_extractor("https://x.com/u/status/1"),
            ExtractorChoice::GalleryDl
        );
    }

    #[test]
    fn extractor_choice_routes_video_sites_to_yt_dlp() {
        for url in [
            "https://www.youtube.com/watch?v=abc",
            "https://youtu.be/abc",
            "https://soundcloud.com/user/track",
            "https://www.tiktok.com/@u/video/1",
            "https://vimeo.com/123",
        ] {
            assert_eq!(
                classify_extractor(url),
                ExtractorChoice::YtDlp,
                "expected YtDlp for {url}"
            );
        }
    }

    #[test]
    fn extractor_choice_defaults_unknown_to_yt_dlp() {
        // Unknown sites default to YtDlp; the dispatcher will fall back
        // to gallery-dl on a no-matching-extractor error if needed.
        assert_eq!(
            classify_extractor("https://example.com/foo"),
            ExtractorChoice::YtDlp
        );
    }

    #[test]
    fn extractor_choice_case_insensitive() {
        assert_eq!(
            classify_extractor("HTTPS://BUNKR.CR/A/ABC"),
            ExtractorChoice::GalleryDl
        );
    }

    #[test]
    fn bunkr_tld_variations_all_route_to_gallery_dl() {
        for tld in ["cr", "fi", "is", "la", "ph", "ru", "si", "sk"] {
            let url = format!("https://bunkr.{tld}/a/abc");
            assert_eq!(
                classify_extractor(&url),
                ExtractorChoice::GalleryDl,
                "bunkr.{tld} should route to gallery-dl"
            );
        }
    }
}
