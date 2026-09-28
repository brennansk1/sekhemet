// Screenshot diffs in Review (U8): a visual gate's baseline, the new capture
// and a pixel-difference overlay, side by side; and the images attached to the
// card (X3). `diffPixels` and `visualPairs` are pure (tested).

/** Visual-snapshot failures with a baseline and a capture under .sekhemet/visual. */
export function visualPairs(failures = []) {
  const rel = (p) => {
    const m = /\.sekhemet\/visual\/((?:baselines|actual|candidates)\/[\w.@-]+\.png)$/.exec(
      String(p ?? ""),
    );
    return m ? m[1] : undefined;
  };
  const out = [];
  for (const f of failures) {
    if (f.gate !== "visual-snapshot") continue;
    const expected = rel(f.expected);
    const actual = rel(f.actual);
    if (expected && actual) out.push({ expected, actual, text: f.errorExcerpt ?? "" });
  }
  return out;
}

/**
 * Compare two RGBA buffers of the same size. Returns the changed-pixel count
 * and an overlay: the baseline dimmed, changed pixels in `mark`.
 */
export function diffPixels(a, b, width, height, { tolerance = 16, mark = [229, 72, 77] } = {}) {
  const out = new Uint8ClampedArray(width * height * 4);
  let changed = 0;
  for (let i = 0; i < width * height * 4; i += 4) {
    const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
    if (d > tolerance * 3) {
      changed++;
      out[i] = mark[0];
      out[i + 1] = mark[1];
      out[i + 2] = mark[2];
      out[i + 3] = 255;
    } else {
      const g = (a[i] + a[i + 1] + a[i + 2]) / 3;
      out[i] = g;
      out[i + 1] = g;
      out[i + 2] = g;
      out[i + 3] = 70;
    }
  }
  return { changed, ratio: width * height ? changed / (width * height) : 0, overlay: out };
}

function esc(v) {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The section: screenshot pairs first, then attached images. Empty when neither. */
export function shotsHtml(evidence, attachments = [], cardId = "") {
  const pairs = visualPairs(evidence?.failures);
  if (pairs.length === 0 && attachments.length === 0) return "";
  const pairHtml = pairs
    .map(
      (p) =>
        `<div class="shot wide"><span class="cap">${esc(p.text)}</span><div class="shot-trio"><figure><img src="/api/visual/${esc(p.expected)}" alt="Approved baseline" loading="lazy"><figcaption>Baseline</figcaption></figure><figure><img src="/api/visual/${esc(p.actual)}" alt="This attempt" loading="lazy"><figcaption>This attempt</figcaption></figure><figure><canvas data-shot-diff data-a="/api/visual/${esc(p.expected)}" data-b="/api/visual/${esc(p.actual)}" role="img" aria-label="Changed pixels"></canvas><figcaption data-shot-ratio>Difference</figcaption></figure></div></div>`,
    )
    .join("");
  const attHtml = attachments
    .map(
      (a) =>
        `<figure class="shot"><img src="/api/cards/${encodeURIComponent(cardId)}/attachments/${esc(a.id)}" alt="${esc(a.name)}" loading="lazy"><figcaption>${esc(a.name)} · attached to the issue; the agent read the vision model's description</figcaption></figure>`,
    )
    .join("");
  const head = [
    pairs.length ? `${pairs.length} screenshot difference${pairs.length === 1 ? "" : "s"}` : "",
    attachments.length
      ? `${attachments.length} attached image${attachments.length === 1 ? "" : "s"}`
      : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return `<section aria-label="Screenshots"><h3 class="sh">Screenshots <span class="sec">${head}</span></h3><div class="shots">${pairHtml}${attHtml}</div></section>`;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

/** Paint every pending difference canvas under `root`. */
export async function paintShotDiffs(root) {
  for (const c of root.querySelectorAll("canvas[data-shot-diff]:not([data-done])")) {
    c.dataset.done = "1";
    try {
      const [a, b] = await Promise.all([loadImage(c.dataset.a), loadImage(c.dataset.b)]);
      const w = Math.min(a.naturalWidth, b.naturalWidth);
      const h = Math.min(a.naturalHeight, b.naturalHeight);
      const read = (img) => {
        const k = document.createElement("canvas");
        k.width = w;
        k.height = h;
        const x = k.getContext("2d");
        x.drawImage(img, 0, 0);
        return x.getImageData(0, 0, w, h).data;
      };
      const d = diffPixels(read(a), read(b), w, h);
      c.width = w;
      c.height = h;
      c.getContext("2d").putImageData(new ImageData(d.overlay, w, h), 0, 0);
      const cap = c.parentElement?.querySelector("[data-shot-ratio]");
      if (cap) cap.textContent = `Difference · ${(d.ratio * 100).toFixed(2)}% of pixels`;
    } catch {
      const cap = c.parentElement?.querySelector("[data-shot-ratio]");
      if (cap) cap.textContent = "Difference unavailable: an image did not load";
    }
  }
}
