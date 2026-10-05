/* Removes the navy (#001529) padding that older logo uploads baked into
   every team/sport logo (LOGO_OPTIONS used to fill the empty square around
   the logo with navy, so no color theme could change it).

   Flood-fills from the image's edges through pixels close to the padding
   color, making them transparent — so navy INSIDE the logo's own artwork
   (not connected to the edge) is kept. Pixels at the boundary that are only
   partly navy (anti-aliased edges) are faded instead of cut, so the logo's
   outline stays smooth. Returns a transparent WebP data URL (PNG if the
   browser can't encode WebP), or null when the image has no navy padding
   to remove (leave it as is). */

const PAD = [0, 21, 41]; // #001529
const CUT = 42; // color distance treated as padding
const FADE = 90; // up to this distance, edge pixels are partly faded

const dist = (d, i) => Math.hypot(d[i] - PAD[0], d[i + 1] - PAD[1], d[i + 2] - PAD[2]);

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not read this logo.'));
    img.src = src;
  });
}

export async function stripLogoBackground(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return null;
  const img = await loadImage(dataUrl);
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  if (!w || !h) return null;

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const image = ctx.getImageData(0, 0, w, h);
  const d = image.data;

  // Only touch logos whose corners are actually the navy padding.
  const corners = [0, w - 1, (h - 1) * w, h * w - 1];
  const navyCorners = corners.filter((p) => d[p * 4 + 3] > 200 && dist(d, p * 4) < CUT).length;
  if (navyCorners < 3) return null;

  const seen = new Uint8Array(w * h);
  const stack = [];
  const push = (p) => { if (!seen[p]) { seen[p] = 1; stack.push(p); } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }

  let removed = 0;
  while (stack.length) {
    const p = stack.pop();
    const i = p * 4;
    const dd = dist(d, i);
    if (dd >= FADE) continue; // logo artwork: stop here
    if (dd < CUT) {
      d[i + 3] = 0;
      removed += 1;
      const x = p % w;
      const y = (p - x) / w;
      if (x > 0) push(p - 1);
      if (x < w - 1) push(p + 1);
      if (y > 0) push(p - w);
      if (y < h - 1) push(p + w);
    } else {
      // Anti-aliased edge between padding and artwork: fade, don't spread.
      d[i + 3] = Math.round(d[i + 3] * ((dd - CUT) / (FADE - CUT)));
    }
  }
  if (removed === 0) return null;

  ctx.putImageData(image, 0, 0);
  return canvas.toDataURL('image/webp', 0.9);
}
