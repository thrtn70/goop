/**
 * Makes a media element on its way out let go of its decoder and buffer now, not at garbage collection.
 * Called from ref callbacks, which React 18 clears only when the element really leaves the page.
 */
export function releaseMedia(media: HTMLMediaElement): void {
  media.pause();
  media.removeAttribute("src");
  // With no src left, load() resets the element and drops whatever it had fetched.
  media.load();
}
