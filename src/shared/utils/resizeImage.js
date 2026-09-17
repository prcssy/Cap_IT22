/* Resizes an image file client-side via a <canvas>.
 *
 * - mode: 'contain' (default) scales down to fit within maxWidth/maxHeight,
 *   preserving aspect ratio, no cropping — for photos (hero banners,
 *   gallery images, registration photos).
 * - mode: 'square' crops/pads to a maxWidth×maxWidth square against
 *   `background`, matching LogoUpload's behavior — for logos/icons.
 * - format 'png' keeps transparency (logos); 'jpeg' compresses harder via
 *   `quality` (0-1) — better for photos, which don't need transparency.
 */
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
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, maxWidth, maxWidth);
        const scale = Math.min(maxWidth / img.width, maxWidth / img.height);
        const x = (maxWidth - img.width * scale) / 2;
        const y = (maxWidth - img.height * scale) / 2;
        ctx.drawImage(img, x, y, img.width * scale, img.height * scale);
      } else {
        const scale = Math.min(maxWidth / img.width, maxHeight / img.height, 1);
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        if (format === 'jpeg') {
          ctx.fillStyle = background;
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
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

// Returns a base64 data URL — for images stored directly on a Firestore
// document instead of Firebase Storage (Branding's school logo, Landing
// Page CMS hero/gallery images, Sports & Teams logos).
export async function resizeImageToDataUrl(file, options = {}) {
  const { format = 'jpeg', quality = 0.7 } = options;
  const canvas = await drawResizedImage(file, options);
  const mime = format === 'png' ? 'image/png' : 'image/jpeg';
  return canvas.toDataURL(mime, quality);
}

// Returns a Blob — for images uploaded to Firebase Storage (e.g. the
// registration photo), where a data URL would need decoding back to
// binary first. Shrinking large phone-camera photos before upload keeps
// Storage usage well under the 5 MB/file rule cap and the project's
// overall storage budget.
export async function resizeImageToBlob(file, options = {}) {
  const { format = 'jpeg', quality = 0.7 } = options;
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
