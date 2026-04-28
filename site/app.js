(() => {
  'use strict';

  const FALLBACK = Object.freeze({
    version: 'v0.1.9',
    mac: 'https://github.com/thrtn70/goop/releases/latest/download/Goop_0.1.9_aarch64.dmg',
    windows: 'https://github.com/thrtn70/goop/releases/latest/download/Goop_0.1.9_x64_en-US.msi',
  });

  const REPO = 'thrtn70/goop';
  const RELEASE_LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`;
  const RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=12`;
  const ARCHIVE_LIMIT = 10;

  /* ----------------------------------------------------------------
   * Hero version + download URLs
   * ---------------------------------------------------------------- */

  function setVersion(version) {
    const cleaned = typeof version === 'string' && version.length > 0 ? version : FALLBACK.version;
    const formatted = cleaned.startsWith('v') ? cleaned : `v${cleaned}`;
    document.querySelectorAll('[data-latest-version]').forEach((el) => {
      el.textContent = formatted;
    });
  }

  function setDownloadURLs(macURL, winURL) {
    document.querySelectorAll('[data-mac-url]').forEach((el) => {
      el.setAttribute('href', macURL);
    });
    document.querySelectorAll('[data-win-url]').forEach((el) => {
      el.setAttribute('href', winURL);
    });
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
      const res = await fetch(RELEASE_LATEST_API, {
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (!res.ok) return null;
      const data = await res.json();
      return {
        version: typeof data.tag_name === 'string' ? data.tag_name : FALLBACK.version,
        mac: pickAsset(data.assets, '.dmg') || FALLBACK.mac,
        windows: pickAsset(data.assets, '.msi') || FALLBACK.windows,
      };
    } catch {
      return null;
    }
  }

  /* ----------------------------------------------------------------
   * Ticker (supported sites) — duplicate list for seamless loop
   * ---------------------------------------------------------------- */

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

  /* ----------------------------------------------------------------
   * Archive — list of recent releases
   * ---------------------------------------------------------------- */

  function formatReleaseDate(iso) {
    if (typeof iso !== 'string') return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  }

  function looksUnstable(release) {
    const tag = (release?.tag_name || '').toLowerCase();
    const name = (release?.name || '').toLowerCase();
    if (release?.prerelease === true || release?.draft === true) return true;
    if (/broken|do not use|unstable|use\s+v/.test(name)) return true;
    if (/-rc|-beta|-alpha|-pre/.test(tag)) return true;
    return false;
  }

  function renderArchive(releases) {
    const list = document.querySelector('[data-archive-list]');
    if (!list || !Array.isArray(releases) || releases.length === 0) return;

    const items = releases.slice(0, ARCHIVE_LIMIT).map((r, i) => renderArchiveItem(r, i));
    list.replaceChildren(...items);
  }

  function renderArchiveItem(release, index) {
    const li = document.createElement('li');
    li.className = 'archive__row';

    const numeral = document.createElement('span');
    numeral.className = 'archive__numeral';
    numeral.setAttribute('aria-hidden', 'true');
    numeral.textContent = String(index + 1).padStart(2, '0');

    const meta = document.createElement('div');
    meta.className = 'archive__meta';

    const tag = document.createElement('span');
    tag.className = 'archive__tag';
    tag.textContent = release.tag_name || '';

    const date = document.createElement('time');
    date.className = 'archive__date';
    date.dateTime = release.published_at || '';
    date.textContent = formatReleaseDate(release.published_at);

    meta.appendChild(tag);
    if (date.textContent) meta.appendChild(date);

    if (looksUnstable(release)) {
      const flag = document.createElement('span');
      flag.className = 'archive__flag';
      flag.textContent = release.prerelease ? 'pre-release' : 'flagged';
      meta.appendChild(flag);
    }

    const title = document.createElement('p');
    title.className = 'archive__title';
    title.textContent = release.name && release.name !== release.tag_name
      ? release.name
      : 'Goop release';

    const links = document.createElement('div');
    links.className = 'archive__links';

    const macURL = pickAsset(release.assets, '.dmg');
    const winURL = pickAsset(release.assets, '.msi');
    const notesURL = typeof release.html_url === 'string' && isHTTPS(release.html_url)
      ? release.html_url
      : null;

    if (macURL) links.appendChild(makeLink(macURL, 'macOS'));
    if (winURL) links.appendChild(makeLink(winURL, 'Windows'));
    if (notesURL) links.appendChild(makeLink(notesURL, 'Notes'));

    const body = document.createElement('div');
    body.className = 'archive__body';
    body.appendChild(title);
    if (links.children.length > 0) body.appendChild(links);

    li.appendChild(numeral);
    li.appendChild(meta);
    li.appendChild(body);
    return li;
  }

  function makeLink(href, label) {
    const a = document.createElement('a');
    a.href = href;
    a.className = 'archive__link';
    a.rel = 'noopener';
    a.textContent = label;
    return a;
  }

  function archiveFallback() {
    const list = document.querySelector('[data-archive-list]');
    if (!list) return;
    const li = document.createElement('li');
    li.className = 'archive__fallback-row';
    const text = document.createElement('p');
    text.className = 'archive__fallback';
    const a = document.createElement('a');
    a.href = `https://github.com/${REPO}/releases`;
    a.rel = 'noopener';
    a.textContent = 'all releases on GitHub';
    text.appendChild(document.createTextNode('Could not load the archive right now. See '));
    text.appendChild(a);
    text.appendChild(document.createTextNode('.'));
    li.appendChild(text);
    list.replaceChildren(li);
  }

  async function fetchReleases() {
    try {
      const res = await fetch(RELEASES_API, {
        headers: { Accept: 'application/vnd.github+json' },
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (!Array.isArray(data)) return null;
      return data;
    } catch {
      return null;
    }
  }

  async function initArchive() {
    const list = document.querySelector('[data-archive-list]');
    if (!list) return;
    const releases = await fetchReleases();
    if (!releases) {
      archiveFallback();
      return;
    }
    renderArchive(releases);
  }

  /* ----------------------------------------------------------------
   * Cursor-driven typographic response (overdrive)
   *
   * Each character in the hero headline shifts variable-font weight
   * based on its distance from the cursor. A faint paragraph-mark
   * trails the cursor through the page. Both effects are gated on
   * pointer:fine devices with prefers-reduced-motion: no-preference.
   * ---------------------------------------------------------------- */

  const HERO_WEIGHT_MIN = 380;
  const HERO_WEIGHT_MAX = 800;
  const HERO_REST = 600;
  const HERO_RADIUS = 360;
  const WEIGHT_LERP = 0.18;
  const TRAIL_LERP = 0.10;
  const IDLE_FADE_MS = 900;
  const REST_FADE_MS = 1600;

  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  function splitHeadlineChars(headline) {
    if (!headline || headline.dataset.charsSplit === '1') return [];

    const fullText = headline.textContent.replace(/\s+/g, ' ').trim();
    headline.setAttribute('aria-label', fullText);

    const chars = [];
    const lines = headline.querySelectorAll('.hero__headline-line');
    lines.forEach((line) => {
      const text = line.textContent;
      line.textContent = '';
      line.setAttribute('aria-hidden', 'true');
      for (const ch of text) {
        if (ch === ' ' || ch === ' ') {
          line.appendChild(document.createTextNode(ch));
          continue;
        }
        const span = document.createElement('span');
        span.className = 'hero__char';
        span.textContent = ch;
        line.appendChild(span);
        chars.push(span);
      }
    });
    headline.dataset.charsSplit = '1';
    return chars;
  }

  function createTrailMark() {
    const el = document.createElement('div');
    el.className = 'cursor-trail';
    el.setAttribute('aria-hidden', 'true');
    return el;
  }

  function initCursorChoreography() {
    const supportsHover = window.matchMedia?.('(hover: hover) and (pointer: fine)').matches;
    if (!supportsHover) return;
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reducedMotion) return;

    const headline = document.querySelector('.hero__headline');
    if (!headline) return;

    const chars = splitHeadlineChars(headline);
    if (chars.length === 0) return;

    const trail = createTrailMark();
    document.body.appendChild(trail);

    const state = {
      mouseX: window.innerWidth / 2,
      mouseY: -1000,
      trailX: window.innerWidth / 2,
      trailY: -1000,
      lastMove: 0,
      heroVisible: true,
      ticking: false,
      charWeights: new WeakMap(),
    };

    chars.forEach((c) => {
      state.charWeights.set(c, HERO_REST);
      c.style.fontVariationSettings = `"wght" ${HERO_REST}`;
    });

    const heroSection = document.querySelector('.hero');
    if (heroSection && 'IntersectionObserver' in window) {
      const io = new IntersectionObserver(
        ([entry]) => {
          state.heroVisible = entry.isIntersecting;
        },
        { threshold: 0 },
      );
      io.observe(heroSection);
    }

    function loop(now) {
      // Trail position (always lerp toward mouse)
      state.trailX = lerp(state.trailX, state.mouseX, TRAIL_LERP);
      state.trailY = lerp(state.trailY, state.mouseY, TRAIL_LERP);
      trail.style.transform = `translate3d(${state.trailX.toFixed(1)}px, ${state.trailY.toFixed(1)}px, 0)`;

      // Hero char weights — read all rects first, then write all weights.
      // Batching avoids per-char layout thrash from interleaved reads/writes.
      // While the cursor is active (recently moved) chars near the cursor
      // surge toward MAX; far chars drop toward MIN. After the cursor goes
      // idle, every char returns to a comfortable REST weight.
      if (state.heroVisible) {
        const idleFor = now - state.lastMove;
        const isIdle = idleFor > IDLE_FADE_MS;
        const targets = new Array(chars.length);

        if (isIdle) {
          for (let i = 0; i < chars.length; i++) targets[i] = HERO_REST;
        } else {
          for (let i = 0; i < chars.length; i++) {
            const rect = chars[i].getBoundingClientRect();
            if (rect.width === 0) {
              targets[i] = null;
              continue;
            }
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            const dist = Math.hypot(state.mouseX - cx, state.mouseY - cy);
            if (dist >= HERO_RADIUS) {
              targets[i] = HERO_WEIGHT_MIN;
            } else {
              const t = 1 - dist / HERO_RADIUS;
              targets[i] = HERO_WEIGHT_MIN + (HERO_WEIGHT_MAX - HERO_WEIGHT_MIN) * (t * t);
            }
          }
        }

        for (let i = 0; i < chars.length; i++) {
          if (targets[i] === null) continue;
          const c = chars[i];
          const current = state.charWeights.get(c) ?? HERO_REST;
          const next = lerp(current, targets[i], WEIGHT_LERP);
          state.charWeights.set(c, next);
          c.style.fontVariationSettings = `"wght" ${Math.round(next)}`;
        }
      }

      const idleSince = now - state.lastMove;
      if (idleSince > IDLE_FADE_MS) {
        trail.classList.remove('cursor-trail--visible');
      }

      // Keep the loop alive while there is recent activity OR while chars
      // are still lerping back to their resting weight.
      const stillSettling = chars.some((c) => {
        const w = state.charWeights.get(c) ?? HERO_REST;
        return Math.abs(w - HERO_REST) > 0.6;
      });

      if (idleSince < IDLE_FADE_MS + REST_FADE_MS || stillSettling) {
        requestAnimationFrame(loop);
      } else {
        state.ticking = false;
      }
    }

    function onMove(e) {
      state.mouseX = e.clientX;
      state.mouseY = e.clientY;
      state.lastMove = performance.now();
      trail.classList.add('cursor-trail--visible');
      if (!state.ticking) {
        state.ticking = true;
        requestAnimationFrame(loop);
      }
    }

    document.addEventListener('mousemove', onMove, { passive: true });
    document.addEventListener('mouseleave', () => {
      trail.classList.remove('cursor-trail--visible');
    });
  }

  /* ----------------------------------------------------------------
   * Boot
   * ---------------------------------------------------------------- */

  async function init() {
    setVersion(FALLBACK.version);
    setDownloadURLs(FALLBACK.mac, FALLBACK.windows);
    initTicker();
    initCursorChoreography();

    const [latest] = await Promise.all([
      fetchLatestRelease(),
      initArchive(),
    ]);

    if (latest) {
      setVersion(latest.version);
      setDownloadURLs(latest.mac, latest.windows);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
