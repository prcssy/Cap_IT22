import './LandingPage.css';

// ImageCarousel: renders two rows of images that scroll continuously without pausing on hover.
// Props:
// - images: array of image URLs (strings). Replace the example URLs where the component is used.
// - duration: total seconds for one full loop (smaller = faster). Default 20.
export default function ImageCarousel({ images = [], duration = 20 }) {
  if (!images || images.length === 0) {
    return null;
  }

  // Duplicate images for seamless looping
  const doubled = [...images, ...images];

  return (
    <div className="carousel-viewport" style={{ ['--carousel-duration']: `${duration}s` }}>
      <div className="carousel-track">
        {/* Row 1 */}
        <div className="carousel-row">
          {doubled.map((src, idx) => (
            <div className="carousel-slide" key={`r1-${idx}`}>
              <img src={src} alt={`highlight-${idx}`} loading="lazy" decoding="async" />
            </div>
          ))}
        </div>

        {/* Row 2 (duplicate content to form two stacked rows) */}
        <div className="carousel-row carousel-row--offset">
          {doubled.map((src, idx) => (
            <div className="carousel-slide" key={`r2-${idx}`}>
              <img src={src} alt={`highlight-2-${idx}`} loading="lazy" decoding="async" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
