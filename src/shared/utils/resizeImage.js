/* Resizes an image file client-side via a <canvas>.
 *
 * - mode: 'contain' (default) scales down to fit within maxWidth/maxHeight,
 *   preserving aspect ratio, no cropping — for photos (hero banners,
 *   gallery images, registration photos).
 * - mode: 'square' pads to a maxWidth×maxWidth square against
 *   `background` (whole image visible, centered) — for logos/icons.
 * - format 'png' keeps transparency (logos); 'jpeg' compresses harder via
 *   `quality` (0-1) — better for photos, which don't need transparency.
 * - maxBytes (jpeg only): most of these images are stored as base64 right
 *   on a Firestore doc (1 MB hard limit), so quality steps down only as far
 *   as needed to fit the budget instead of always compressing hard.
 */

/* One drawImage from a 4000px photo straight to 192px skips most source
   pixels (browsers don't average that many), which is what made uploads
   look soft/jagged. Halving repeatedly with high-quality smoothing, then a
   final draw to the exact size, averages them properly. */
function drawScaled(ctx, img, dx, dy, dw, dh) {
  let source = img;
  let sw = img.width;
  let sh = img.height;
  while (sw / 2 >= dw && sh / 2 >= dh) {
    const step = document.createElement('canvas');
    step.width = Math.max(1, Math.round(sw / 2));
    step.height = Math.max(1, Math.round(sh / 2));
    const sctx = step.getContext('2d');
    sctx.imageSmoothingEnabled = true;
    sctx.imageSmoothingQuality = 'high';
    sctx.drawImage(source, 0, 0, sw, sh, 0, 0, step.width, step.height);
    source = step;
    sw = step.width;
    sh = step.height;
  }
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, sw, sh, dx, dy, dw, dh);
}

function drawResizedImage(file, { maxWidth = 800, maxHeight = 800, mode = 'contain', format = 'jpeg', background = '#ffffff' } = {}) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(file);

    img.onload = () => {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');

      if (mode === 'square') {
        canvas.width = maxWidth;
        canvas.height = maxWidth;
        if (background) {
          ctx.fillStyle = background;
          ctx.fillRect(0, 0, maxWidth, maxWidth);
        }
        const scale = Math.min(maxWidth / img.width, maxWidth / img.height);
        const w = img.width * scale;
        const h = img.height * scale;
        drawScaled(ctx, img, (maxWidth - w) / 2, (maxWidth - h) / 2, w, h);
      } else {
        const scale = Math.min(maxWidth / img.width, maxHeight / img.height, 1);
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        if (format === 'jpeg') {
          ctx.fillStyle = background;
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        drawScaled(ctx, img, 0, 0, canvas.width, canvas.height);
      }

      URL.revokeObjectURL(objectUrl);
      resolve(canvas);
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Could not read this image file.'));
    };
    img.src = objectUrl;
  });
}

const MIN_QUALITY = 0.5;

// Decoded size of a base64 data URL, in bytes.
const dataUrlBytes = (dataUrl) => Math.ceil((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75);

// Returns a base64 data URL — for images stored directly on a Firestore
// document instead of Firebase Storage (Branding's school logo, Landing
// Page CMS hero/gallery images, Sports & Teams logos).
export async function resizeImageToDataUrl(file, options = {}) {
  const { format = 'jpeg', quality = 0.85, maxBytes } = options;
  const canvas = await drawResizedImage(file, options);
  const mime = format === 'png' ? 'image/png' : 'image/jpeg';
  let q = quality;
  let dataUrl = canvas.toDataURL(mime, q);
  while (maxBytes && mime === 'image/jpeg' && dataUrlBytes(dataUrl) > maxBytes && q > MIN_QUALITY) {
    q = Math.max(MIN_QUALITY, q - 0.07);
    dataUrl = canvas.toDataURL(mime, q);
  }
  // Still over budget at the lowest acceptable quality (a very detailed
  // photo): shrink the dimensions rather than dropping quality further.
  if (maxBytes && mime === 'image/jpeg' && dataUrlBytes(dataUrl) > maxBytes && (options.maxWidth || 800) > 160) {
    return resizeImageToDataUrl(file, {
      ...options,
      maxWidth: Math.round((options.maxWidth || 800) * 0.85),
      maxHeight: Math.round((options.maxHeight || 800) * 0.85),
    });
  }
  return dataUrl;
}

// Returns a Blob — for images uploaded to Firebase Storage (e.g. the
// registration photo), where a data URL would need decoding back to
// binary first. Shrinking large phone-camera photos before upload keeps
// Storage usage well under the 5 MB/file rule cap and the project's
// overall storage budget.
export async function resizeImageToBlob(file, options = {}) {
  const { format = 'jpeg', quality = 0.85 } = options;
  const canvas = await drawResizedImage(file, options);
  const mime = format === 'png' ? 'image/png' : 'image/jpeg';
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not compress this image.'))),
      mime,
      quality
    );
  });
}

/* Team/sport logos: stored inline on sportsTeamsConfig/{level}, which holds
   every sport and team logo of that level in ONE doc (1 MB cap). 192px
   covers the largest on-screen size (~96px) on 2× screens; the byte cap
   keeps ~40+ logos per level comfortably under the doc limit. */
export const LOGO_OPTIONS = {
  maxWidth: 192, mode: 'square', format: 'jpeg', quality: 0.9,
  background: '#001529', maxBytes: 14 * 1024,
};
