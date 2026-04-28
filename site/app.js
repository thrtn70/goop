(() => {
  'use strict';

  const FALLBACK = Object.freeze({
    version: 'v0.1.9',
    mac: 'https://github.com/thrtn70/goop/releases/latest/download/Goop_0.1.9_aarch64.dmg',
    windows: 'https://github.com/thrtn70/goop/releases/latest/download/Goop_0.1.9_x64_en-US.msi',
  });

  const RELEASE_API = 'https://api.github.com/repos/thrtn70/goop/releases/latest';

  function detectOS() {
    const platform = navigator.userAgentData?.platform || '';
    if (platform === 'macOS') return 'mac';
    if (platform === 'Windows') return 'win';

    const ua = navigator.userAgent || '';
    if (/iPhone|iPad|iPod|Android/i.test(ua)) return 'unknown';
    if (/Macintosh|Mac OS X/i.test(ua)) return 'mac';
    if (/Windows/i.test(ua)) return 'win';
    return 'unknown';
  }

  function applyOSCTAs(os) {
    const macBtn = document.querySelector('[data-cta="mac"]');
    const winBtn = document.querySelector('[data-cta="win"]');
    const alt = document.querySelector('[data-cta-alt]');
    const altText = document.querySelector('[data-cta-alt-text]');
    const altLink = document.querySelector('[data-cta-alt-link]');

    if (!macBtn || !winBtn || !alt || !altText || !altLink) return;

    if (os === 'mac') {
      winBtn.hidden = true;
      altText.textContent = 'On Windows? ';
      altLink.textContent = 'Download for Windows';
      altLink.setAttribute('href', winBtn.getAttribute('href'));
      alt.hidden = false;
    } else if (os === 'win') {
      macBtn.hidden = true;
      altText.textContent = 'On macOS? ';
      altLink.textContent = 'Download for macOS (Apple Silicon)';
      altLink.setAttribute('href', macBtn.getAttribute('href'));
      alt.hidden = false;
    }
  }

  function syncAltLink() {
    const alt = document.querySelector('[data-cta-alt]');
    const altLink = document.querySelector('[data-cta-alt-link]');
    if (!alt || alt.hidden || !altLink) return;
    const macBtn = document.querySelector('[data-cta="mac"]');
    const winBtn = document.querySelector('[data-cta="win"]');
    if (!macBtn || !winBtn) return;
    const hiddenBtn = macBtn.hidden ? macBtn : winBtn.hidden ? winBtn : null;
    const href = hiddenBtn?.getAttribute('href');
    if (href) altLink.setAttribute('href', href);
  }

  function setVersion(version) {
    const cleaned = typeof version === 'string' && version.length > 0 ? version : FALLBACK.version;
    document.querySelectorAll('[data-latest-version]').forEach((el) => {
      el.textContent = cleaned.startsWith('v') ? cleaned : `v${cleaned}`;
    });
  }

  function setDownloadURLs(macURL, winURL) {
    document.querySelectorAll('[data-mac-url]').forEach((el) => {
      el.setAttribute('href', macURL);
    });
    document.querySelectorAll('[data-win-url]').forEach((el) => {
      el.setAttribute('href', winURL);
    });
    syncAltLink();
  }

  function isHTTPS(url) {
    try {
      return new URL(url).protocol === 'https:';
    } catch {
      return false;
    }
  }

  function pickAsset(assets, suffix) {
    if (!Array.isArray(assets)) return null;
    const match = assets.find(
      (a) => typeof a?.name === 'string' && a.name.toLowerCase().endsWith(suffix),
    );
    const url = match?.browser_download_url;
    return typeof url === 'string' && isHTTPS(url) ? url : null;
  }

  async function fetchLatestRelease() {
    try {
      const res = await fetch(RELEASE_API, {
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (!res.ok) return null;
      const data = await res.json();
      const macURL = pickAsset(data.assets, '.dmg') || FALLBACK.mac;
      const winURL = pickAsset(data.assets, '.msi') || FALLBACK.windows;
      return {
        version: typeof data.tag_name === 'string' ? data.tag_name : FALLBACK.version,
        mac: macURL,
        windows: winURL,
      };
    } catch {
      return null;
    }
  }

  /**
   * Duplicate ticker contents so the CSS infinite-scroll animation
   * (translateX -50%) loops seamlessly. The clone is aria-hidden so screen
   * readers don't double-read the site list.
   */
  function initTicker() {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    const list = document.querySelector('[data-ticker-list]');
    if (!list || list.dataset.tickerInit === '1') return;

    const clone = list.cloneNode(true);
    clone.setAttribute('aria-hidden', 'true');
    clone.removeAttribute('data-ticker-list');
    list.dataset.tickerInit = '1';
    list.parentElement?.appendChild(clone);
  }

  async function init() {
    setVersion(FALLBACK.version);
    setDownloadURLs(FALLBACK.mac, FALLBACK.windows);
    applyOSCTAs(detectOS());
    initTicker();

    const latest = await fetchLatestRelease();
    if (!latest) return;
    setVersion(latest.version);
    setDownloadURLs(latest.mac, latest.windows);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
