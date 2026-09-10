(() => {
  'use strict';

  const PRODUCTS_URL = 'products.json';
  const PRICE_URL = 'https://mempool.space/api/v1/prices';
  const PLACEHOLDER_IMAGE = 'placeholder.svg';
  const SATS_PER_BTC = 100000000;
  const DEFAULT_SECONDS = 8;
  const FETCH_TIMEOUT_MS = 6000;
  const IDLE_MS = 3000;
  const DRAG_START_PX = 10;
  const SWIPE_FRACTION = 0.18;
  const SWIPE_VELOCITY = 0.5; // px per ms
  const WHEEL_THRESHOLD = 40;
  const WHEEL_QUIET_MS = 250;
  const WHEEL_MIN_LOCK_MS = 300;
  const WHEEL_GROWTH = 1.3;
  const MIN_TEXT_SCALE = 0.5;
  const TEXT_SCALE_STEP = 0.05;

  const deck = document.getElementById('deck');
  const slidesEl = document.getElementById('slides');
  const progressFill = document.getElementById('progress-fill');
  const rateEl = document.getElementById('rate');
  const counterEl = document.getElementById('counter');
  const messageEl = document.getElementById('message');
  const toggleFlash = document.getElementById('toggle-flash');
  const toggleFlashIcon = document.getElementById('toggle-flash-icon');

  const PAUSE_ICON = 'M7 5h3.5v14H7zM13.5 5H17v14h-3.5z';
  const PLAY_ICON = 'M8 5l11 7-11 7z';

  let slides = [];
  let durations = [];
  let current = 0;
  let progressAnim = null;
  let paused = false;

  // ---------- Loading ----------

  async function fetchJson(url, options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  // Fetched once per page load; refresh the page to get a new rate.
  async function loadBtcUsd() {
    try {
      const data = await fetchJson(PRICE_URL, { cache: 'no-store' });
      const usd = Number(data.USD);
      return usd > 0 ? usd : null;
    } catch (err) {
      console.warn('BTC price unavailable:', err);
      return null;
    }
  }

  // ---------- Pricing ----------

  function toNumber(value) {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  const ROUNDERS = { up: Math.ceil, down: Math.floor, nearest: Math.round };

  // Reads a rounding entry like { "direction": "up", "digits": 2 }.
  // false / null / missing means no extra rounding (just cents or whole sats).
  // `where` names the entry in warnings.
  function roundingRule(raw, where) {
    const rule = raw && typeof raw === 'object' ? raw : {};
    const digits = toNumber(rule.digits);
    if (rule.direction && !ROUNDERS[rule.direction]) {
      console.warn(`${where}.direction should be "up", "down" or "nearest"; using "nearest".`);
    }
    return {
      round: ROUNDERS[rule.direction] || Math.round,
      digits: digits >= 1 ? Math.floor(digits) : null,
    };
  }

  // Scale by 10^exp, round, and scale back. toPrecision trims float noise
  // like 16.2 * 100 = 1620.0000000000002 so ceil/floor don't overshoot.
  function roundAt(value, exp, round) {
    const scaled = exp >= 0 ? value / 10 ** exp : value * 10 ** -exp;
    const rounded = round(Number(scaled.toPrecision(12)));
    return exp >= 0 ? rounded * 10 ** exp : rounded / 10 ** -exp;
  }

  // Round a calculated price to `digits` significant digits, then to the
  // smallest unit (unitExp -2 = cents, 0 = whole sats), in the same direction.
  function roundCalculated(value, rule, unitExp) {
    if (!(value > 0)) return value;
    let result = value;
    if (rule.digits) {
      const magnitude = Math.floor(Math.log10(result));
      result = roundAt(result, magnitude - rule.digits + 1, rule.round);
    }
    result = roundAt(result, unitExp, rule.round);
    return result > 0 ? result : 10 ** unitExp;
  }

  // Reads a discount entry: "10%" is a percentage off, a plain number
  // (5, "5", "1,000") is a fixed amount off in that currency.
  // Returns a function that applies the discount, or null for no discount
  // (including false / 0 / null, which is how a product opts out of a catalog discount).
  function discountRule(raw, where) {
    if (raw === undefined || raw === null || raw === '' || raw === false) return null;
    const text = String(raw).replace(/[$,\s]/g, '');
    const percent = text.endsWith('%');
    const amount = toNumber(percent ? text.slice(0, -1) : text);
    if (amount === null || (percent && amount > 100)) {
      console.warn(`${where} should look like "10%" or 5; got "${raw}", so no discount is applied.`);
      return null;
    }
    if (amount === 0) return null;
    if (percent) return (price) => price * (1 - amount / 100);
    return (price) => Math.max(0, price - amount);
  }

  function hasEntry(section, key) {
    return !!section && typeof section === 'object' && Object.prototype.hasOwnProperty.call(section, key);
  }

  // Rounding and discount rules for one product: the catalog-wide rules, with
  // any currency the product sets in its own "rounding" / "discount" taking priority.
  // "discount": false or "rounding": false on a product turns that off for both currencies.
  function pricingRules(catalog, product) {
    const rounding = { ...catalog.rounding };
    const discounts = { ...catalog.discounts };
    const label = product.name ? `"${product.name}"` : 'product';
    for (const key of ['usd', 'sats']) {
      if (product.rounding === false || hasEntry(product.rounding, key)) {
        rounding[key] = roundingRule(product.rounding && product.rounding[key], `${label} rounding.${key}`);
      }
      if (product.discount === false || hasEntry(product.discount, key)) {
        discounts[key] = discountRule(product.discount && product.discount[key], `${label} discount.${key}`);
      }
    }
    return { rounding, discounts };
  }

  // Discount first, then round. A price is shown exactly as entered only
  // when it was entered and has no discount; anything else gets rounded.
  function finalPrice(price, entered, discount, rule, unitExp) {
    if (price === null) return null;
    if (entered !== null && !discount) return entered;
    return roundCalculated(discount ? discount(price) : price, rule, unitExp);
  }

  // Whichever price is given is used as-is; the other is calculated from it
  // (before any discount). If both are given, neither is calculated.
  function resolvePrices(product, btcUsd, { rounding, discounts }) {
    const enteredUsd = toNumber(product.usd);
    const enteredSats = toNumber(product.sats);
    let usd = enteredUsd;
    let sats = enteredSats;
    if (btcUsd) {
      if (usd === null && sats !== null) usd = (sats / SATS_PER_BTC) * btcUsd;
      else if (sats === null && usd !== null) sats = (usd / btcUsd) * SATS_PER_BTC;
    }
    return {
      usd: finalPrice(usd, enteredUsd, discounts.usd, rounding.usd, -2),
      sats: finalPrice(sats, enteredSats, discounts.sats, rounding.sats, 0),
    };
  }

  function formatUsd(usd) {
    const whole = Math.abs(usd - Math.round(usd)) < 0.005;
    const digits = whole ? 0 : 2;
    return usd.toLocaleString('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
  }

  function formatSats(sats) {
    return `${Math.round(sats).toLocaleString('en-US')} sats`;
  }

  // ---------- Rendering ----------

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function buildSlide(product, prices) {
    const slide = el('section', 'slide');
    slide.setAttribute('aria-hidden', 'true');

    const photo = el('div', 'photo');
    const img = document.createElement('img');
    img.alt = product.name || '';
    img.decoding = 'async';
    img.addEventListener('error', () => {
      if (img.dataset.fallback) return;
      img.dataset.fallback = 'true';
      img.src = PLACEHOLDER_IMAGE;
    });
    const imageUrl = typeof product.image === 'string' ? product.image.trim() : '';
    img.src = imageUrl || PLACEHOLDER_IMAGE;
    photo.appendChild(img);

    const info = el('div', 'info');
    if (product.name) info.appendChild(el('h2', 'name', product.name));
    if (product.description) info.appendChild(el('p', 'description', product.description));

    const priceRow = el('div', 'prices');
    if (prices.sats !== null) priceRow.appendChild(el('div', 'price sats', formatSats(prices.sats)));
    if (prices.usd !== null && prices.sats !== null) priceRow.appendChild(el('div', 'price-divider'));
    if (prices.usd !== null) priceRow.appendChild(el('div', 'price usd', formatUsd(prices.usd)));
    if (priceRow.childElementCount) info.appendChild(priceRow);

    slide.append(photo, info);
    return slide;
  }

  // If a product's text doesn't fit its panel, shrink the name and
  // description (never the prices) a step at a time until it does.
  function fitText() {
    for (const info of slidesEl.querySelectorAll('.info')) {
      let scale = 1;
      info.style.setProperty('--textScale', scale);
      while (info.scrollHeight > info.clientHeight + 1 && scale > MIN_TEXT_SCALE) {
        scale = Number((scale - TEXT_SCALE_STEP).toFixed(2));
        info.style.setProperty('--textScale', scale);
      }
    }
  }

  // Re-fit whenever the slide area changes size: rotating the iPad, Safari's
  // toolbar showing or hiding, or resizing a laptop window.
  function setupTextFitting() {
    fitText();
    if ('ResizeObserver' in window) {
      new ResizeObserver(fitText).observe(slidesEl);
    } else {
      window.addEventListener('resize', fitText);
    }
  }

  function showMessage(text) {
    messageEl.textContent = text;
    messageEl.hidden = false;
  }

  // ---------- Slide movement ----------

  function mod(i) {
    return ((i % slides.length) + slides.length) % slides.length;
  }

  // Position a slide at `percent` of the deck width plus `px` (for finger drags).
  function place(slide, percent, px, animate) {
    slide.style.transition = animate ? '' : 'none';
    slide.style.transform = `translateX(calc(${percent}% + ${px}px))`;
    slide.style.visibility = 'visible';
  }

  function hideAllExcept(...keep) {
    slides.forEach((slide, i) => {
      if (keep.includes(i)) return;
      slide.style.transition = 'none';
      slide.style.visibility = 'hidden';
    });
  }

  function setActive(index) {
    current = index;
    slides.forEach((slide, i) => slide.setAttribute('aria-hidden', String(i !== index)));
    counterEl.textContent = `${index + 1} / ${slides.length}`;
    startProgress();
  }

  // Slide to `to`, entering from the right when dir is 1 and from the left when dir is -1.
  // `staged` means the incoming slide is already on screen from a drag.
  function goTo(to, dir, staged) {
    const from = current;
    if (to === from) {
      startProgress();
      return;
    }
    hideAllExcept(from, to);
    if (!staged) {
      place(slides[to], dir * 100, 0, false);
      slides[to].getBoundingClientRect(); // flush so the move below animates
    }
    place(slides[from], -dir * 100, 0, true);
    place(slides[to], 0, 0, true);
    setActive(to);
  }

  function step(dir) {
    if (slides.length < 2) return;
    goTo(mod(current + dir), dir, false);
  }

  function startProgress() {
    if (progressAnim) progressAnim.cancel();
    progressAnim = null;
    if (slides.length < 2) return;
    progressAnim = progressFill.animate(
      [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }],
      { duration: durations[current] * 1000, easing: 'linear', fill: 'forwards' }
    );
    progressAnim.onfinish = () => step(1);
    if (paused) progressAnim.pause();
  }

  // Tap / click / Space: stop or resume cycling. The bar freezes where it is.
  function togglePause() {
    if (slides.length < 2) return;
    paused = !paused;
    document.body.classList.toggle('paused', paused);
    if (progressAnim) {
      if (paused) progressAnim.pause();
      else progressAnim.play();
    }
    toggleFlashIcon.setAttribute('d', paused ? PAUSE_ICON : PLAY_ICON);
    toggleFlash.animate(
      [{ opacity: 0.85, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(1.3)' }],
      { duration: 700, easing: 'ease-out' }
    );
  }

  // ---------- Input ----------

  function setupButtons() {
    document.getElementById('prev').addEventListener('click', () => step(-1));
    document.getElementById('next').addEventListener('click', () => step(1));
  }

  function setupKeyboard() {
    document.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      switch (e.key) {
        case 'ArrowRight':
        case 'ArrowDown':
        case 'PageDown':
          step(1);
          break;
        case ' ':
          togglePause();
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
        case 'PageUp':
          step(-1);
          break;
        case 'Home':
          if (slides.length > 1) goTo(0, -1, false);
          break;
        case 'f':
        case 'F':
          toggleFullscreen();
          break;
        default:
          return;
      }
      e.preventDefault();
    });
  }

  // Finger / mouse drag: the slide follows the pointer, then snaps.
  // A press that doesn't move is a tap, which pauses / resumes.
  function setupSwipe() {
    let start = null;
    let dragging = false;
    let neighbor = null;
    let dx = 0;

    function neighborFor(offset) {
      return offset < 0 ? mod(current + 1) : mod(current - 1);
    }

    deck.addEventListener('pointerdown', (e) => {
      if (slides.length < 2 || !e.isPrimary || e.button > 0) return;
      start = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId };
      dragging = false;
      dx = 0;
    });

    deck.addEventListener('pointermove', (e) => {
      if (!start || e.pointerId !== start.id) return;
      dx = e.clientX - start.x;
      const dy = e.clientY - start.y;
      if (!dragging) {
        if (Math.abs(dx) < DRAG_START_PX || Math.abs(dx) < Math.abs(dy)) return;
        dragging = true;
        try { deck.setPointerCapture(e.pointerId); } catch (err) { /* keep dragging without capture */ }
        if (progressAnim) progressAnim.pause();
      }
      const next = neighborFor(dx);
      if (next !== neighbor) {
        neighbor = next;
        hideAllExcept(current, neighbor);
      }
      place(slides[current], 0, dx, false);
      place(slides[neighbor], dx < 0 ? 100 : -100, dx, false);
    });

    function finish(e, cancelled) {
      if (!start || e.pointerId !== start.id) return;
      const elapsed = Math.max(1, performance.now() - start.t);
      const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y);
      start = null;
      if (!dragging) {
        const onButton = e.target instanceof Element && e.target.closest('button');
        if (!cancelled && !onButton && moved < DRAG_START_PX) togglePause();
        return;
      }
      dragging = false;

      const width = slidesEl.clientWidth;
      const fast = Math.abs(dx) / elapsed > SWIPE_VELOCITY;
      const far = Math.abs(dx) > width * SWIPE_FRACTION;
      const dir = dx < 0 ? 1 : -1;

      if (!cancelled && (far || fast)) {
        goTo(neighbor, dir, true);
      } else {
        place(slides[current], 0, 0, true);
        place(slides[neighbor], dir * 100, 0, true);
        if (progressAnim && !paused) progressAnim.play();
      }
      neighbor = null;
    }

    deck.addEventListener('pointerup', (e) => finish(e, false));
    deck.addEventListener('pointercancel', (e) => finish(e, true));
  }

  // Trackpad two-finger swipe or mouse wheel: one slide per gesture.
  // After a swipe, macOS keeps sending shrinking "momentum" wheel events. Those
  // are ignored, but a new swipe is recognized as soon as the deltas grow again
  // or reverse direction, so you can swipe repeatedly without pausing.
  function setupWheel() {
    let total = 0;
    let lastTime = 0;
    let lastDelta = 0;
    let locked = false;
    let lockedAt = 0;
    let lockedDir = 0;
    let decaying = false;
    let trough = 0; // smallest delta seen while momentum is fading

    function wheelDelta(e) {
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (e.deltaMode === 1) return delta * 16; // lines
      if (e.deltaMode === 2) return delta * slidesEl.clientWidth; // pages
      return delta;
    }

    deck.addEventListener('wheel', (e) => {
      e.preventDefault();
      const now = performance.now();
      const delta = wheelDelta(e);
      const size = Math.abs(delta);
      const lastSize = Math.abs(lastDelta);
      const paused = now - lastTime > WHEEL_QUIET_MS;
      lastTime = now;
      lastDelta = delta;

      if (locked) {
        if (decaying) trough = Math.min(trough, size);
        else if (size < lastSize) {
          decaying = true;
          trough = size;
        }
        const settled = now - lockedAt > WHEEL_MIN_LOCK_MS;
        const reversed = size > 3 && Math.sign(delta) !== lockedDir;
        const grew = decaying && size > trough * WHEEL_GROWTH + 2;
        if (!paused && !(settled && (reversed || grew))) return;
        locked = false;
        total = 0;
      } else if (paused || (delta && Math.sign(delta) !== Math.sign(total))) {
        total = 0;
      }

      total += delta;
      if (Math.abs(total) >= WHEEL_THRESHOLD) {
        lockedDir = Math.sign(total);
        step(lockedDir);
        total = 0;
        locked = true;
        lockedAt = now;
        decaying = false;
      }
    }, { passive: false });
  }

  // Hide the cursor and nav buttons when nobody is interacting.
  function setupIdle() {
    let timer = null;
    function wake() {
      document.body.classList.remove('idle');
      clearTimeout(timer);
      timer = setTimeout(() => document.body.classList.add('idle'), IDLE_MS);
    }
    ['pointermove', 'pointerdown', 'keydown'].forEach((type) => document.addEventListener(type, wake));
    wake();
  }

  // ---------- Kiosk helpers ----------

  function toggleFullscreen() {
    const root = document.documentElement;
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    } else if (root.requestFullscreen) {
      root.requestFullscreen().catch(() => {});
    } else if (root.webkitRequestFullscreen) {
      root.webkitRequestFullscreen();
    }
  }

  // Keep the screen from sleeping while the deck is showing.
  function setupWakeLock() {
    if (!('wakeLock' in navigator)) return;
    let lock = null;
    let requesting = false;
    async function request() {
      if (lock || requesting || document.visibilityState !== 'visible') return;
      requesting = true;
      try {
        lock = await navigator.wakeLock.request('screen');
        lock.addEventListener('release', () => { lock = null; });
      } catch (err) {
        // Some browsers only allow this after a tap; retried on the next one.
      } finally {
        requesting = false;
      }
    }
    document.addEventListener('visibilitychange', request);
    document.addEventListener('pointerdown', request);
    request();
  }

  // ---------- Start ----------

  async function init() {
    setupIdle();
    setupWakeLock();

    const [config, btcUsd] = await Promise.all([
      fetchJson(PRODUCTS_URL, { cache: 'no-cache' }).catch((err) => {
        showMessage(`Couldn't load products.json (${err.message}).`);
        return null;
      }),
      loadBtcUsd(),
    ]);
    if (!config) return;

    rateEl.textContent = btcUsd
      ? `1 BTC = ${btcUsd.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })}`
      : 'BTC rate unavailable. Refresh to try again.';

    const products = Array.isArray(config.products) ? config.products : [];
    if (!products.length) {
      showMessage('No products yet. Add some to products.json.');
      return;
    }

    const defaultSeconds = toNumber(config.defaultSeconds) || DEFAULT_SECONDS;
    const catalogRules = { rounding: {}, discounts: {} };
    for (const key of ['usd', 'sats']) {
      catalogRules.rounding[key] = roundingRule(config.rounding && config.rounding[key], `rounding.${key}`);
      catalogRules.discounts[key] = discountRule(config.discount && config.discount[key], `discount.${key}`);
    }

    products.forEach((product) => {
      const slide = buildSlide(product, resolvePrices(product, btcUsd, pricingRules(catalogRules, product)));
      slidesEl.appendChild(slide);
      slides.push(slide);
      durations.push(toNumber(product.seconds) || defaultSeconds);
    });

    document.body.classList.toggle('single', slides.length < 2);
    setupTextFitting();
    place(slides[0], 0, 0, false);
    setActive(0);

    setupButtons();
    setupKeyboard();
    setupSwipe();
    setupWheel();
  }

  init();
})();
