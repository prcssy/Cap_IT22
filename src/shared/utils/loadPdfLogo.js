/* Shared header for every PDF export in the app (AdminSchedulePage's
 * schedule/bracket downloads, SuperAdminPage's analytics report,
 * StudentRegistrationDetails' per-student export): the school logo drawn
 * beside a centered title line, so every export has the same masthead.
 *
 * `logo` (from BrandingContext) is always a URL — either the bundled
 * default asset or a Firebase Storage download URL for a custom upload.
 * jsPDF's addImage() needs the image as a data URL plus its pixel
 * dimensions (to scale it without distorting), which a plain <img> only
 * exposes once loaded, so loadPdfLogo resolves both together.
 */

// Loads `logoUrl` into a canvas and reads it back out as a PNG data URL.
// Returns null (never throws) on any failure — a Firebase Storage logo
// that isn't CORS-enabled would otherwise taint the canvas and block
// toDataURL(), and a broken/unreachable logo shouldn't stop the export
// it's just decorating; see the CORS note on StudentRegistrationDetails'
// own handleDownloadPdf for why this app treats logo/photo embedding as
// best-effort rather than required.
export async function loadPdfLogo(logoUrl) {
  if (!logoUrl) return null;
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.crossOrigin = 'anonymous';
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Could not load logo image.'));
      el.src = logoUrl;
    });

    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext('2d').drawImage(img, 0, 0);

    return { dataUrl: canvas.toDataURL('image/png'), width: img.naturalWidth, height: img.naturalHeight };
  } catch (e) {
    console.warn('PDF export: skipping logo —', e);
    return null;
  }
}

// Draws `title` centered on the page at `y`, with the logo (if loaded)
// placed just to its left, vertically centered against the title text.
// The title itself always stays centered on the page — the logo doesn't
// shift it — so every export looks the same whether or not a custom
// logo is set, it just gains/loses the icon beside the text.
export function drawLogoTitleRow(doc, {
  pageWidth,
  y,
  title,
  logoInfo,
  fontSize = 18,
  logoHeight = 28,
  maxLogoWidth = 64,
}) {
  doc.setFontSize(fontSize);
  doc.setFont(undefined, 'bold');
  doc.setTextColor(0);
  doc.text(title, pageWidth / 2, y, { align: 'center' });

  if (!logoInfo) return;

  const scale = Math.min(logoHeight / logoInfo.height, maxLogoWidth / logoInfo.width, 1);
  const w = logoInfo.width * scale;
  const h = logoInfo.height * scale;

  const titleWidth = doc.getTextWidth(title);
  const gap = 10;
  const logoX = pageWidth / 2 - titleWidth / 2 - gap - w;
  // jsPDF's y is the text baseline, which sits below the glyphs' visual
  // vertical center by roughly a third of the font size — offsetting by
  // that before centering the (shorter) logo against it keeps the two
  // looking aligned instead of the logo reading as low.
  const logoY = y - fontSize * 0.32 - h / 2;

  doc.addImage(logoInfo.dataUrl, 'PNG', logoX, logoY, w, h);
}
