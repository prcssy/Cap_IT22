/* Resizes an image file client-side (via a <canvas>) and returns a base64
 * data URL, so it can be stored directly on a Firestore document instead
 * of Firebase Storage — same approach SportsTeamsManager.jsx's LogoUpload
 * already uses for sport/team logos (which works reliably), used here for
 * Branding's school logo and the Landing Page CMS's hero/gallery images,
 * neither of which worked when they depended on Firebase Storage being
 * provisioned (uploadBytes/getDownloadURL silently failing).
 *
 * - mode: 'contain' (default) scales down to fit within maxWidth/maxHeight,
 *   preserving aspect ratio, no cropping — for photos (hero banners,
 *   gallery images).
 * - mode: 'square' crops/pads to a maxWidth×maxWidth square against
 *   `background`, matching LogoUpload's behavior — for logos/icons.
 * - format 'png' keeps transparency (logos); 'jpeg' compresses harder via
 *   `quality` (0-1) — better for photos, which don't need transparency.
 */
export function resizeImageToDataUrl(file, {
  maxWidth = 800,
  maxHeight = 800,
  mode = 'contain',
  format = 'jpeg',
  quality = 0.7,
  background = '#ffffff',
} = {}) {
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
      const mime = format === 'png' ? 'image/png' : 'image/jpeg';
      resolve(canvas.toDataURL(mime, quality));
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Could not read this image file.'));
    };
    img.src = objectUrl;
  });
}
