/* Hand-drawn stand-ins for sports Tabler has no glyph for (badminton,
   boxing, sepak takraw). Same 24px grid and 2px round stroke as the Tabler
   icons, and the same props (size / className / style) as a react-icons glyph. */
const svgProps = (size, rest) => ({
  width: size, height: size, viewBox: '0 0 24 24',
  fill: 'none', stroke: 'currentColor', strokeWidth: 2,
  strokeLinecap: 'round', strokeLinejoin: 'round', ...rest,
});

export function ShuttlecockIcon({ size = '1em', ...rest }) {
  return (
    <svg {...svgProps(size, rest)}>
      <path d="M9.5 15h5v2a2.5 2.5 0 0 1-5 0z" />
      <path d="M9.5 15 6 5M14.5 15 18 5M12 15V5" />
      <path d="M6 5c3.5-1.5 8.5-1.5 12 0" />
      <path d="M7.75 10h8.5" />
    </svg>
  );
}

export function BoxingGloveIcon({ size = '1em', ...rest }) {
  return (
    <svg {...svgProps(size, rest)}>
      <path d="M6 21v-5.2C4.8 14.6 4 13 4 11a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6c0 2-1 3.5-2 4.8V21z" />
      <path d="M6 17.5h12" />
      <path d="M9 11.5c0-1.5 1-2.5 2.5-2.5H14" />
    </svg>
  );
}

export function TakrawBallIcon({ size = '1em', ...rest }) {
  return (
    <svg {...svgProps(size, rest)}>
      <circle cx="12" cy="12" r="9" />
      <path d="M15.35 20.35 3.65 8.65M20.35 15.35 8.65 3.65M8.65 20.35 20.35 8.65M3.65 15.35 15.35 3.65" />
    </svg>
  );
}
