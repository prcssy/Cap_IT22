import { useContext } from 'react';
import { BrandingContext } from '../../context/BrandingContext';
import './HeaderBrand.css';

/* School logo + name for the top bar of every logged-in page. The logo and
   name both come from BrandingContext (Super Admin → Web Customization), so
   uploading a new logo updates every header at once. `titleClassName` keeps
   each page's own title styling (font, size, color). */
export default function HeaderBrand({ titleClassName }) {
  const { schoolName, logo } = useContext(BrandingContext);
  return (
    <div className="header-brand">
      {logo && <img className="header-brand__logo" src={logo} alt="" />}
      <h1 className={titleClassName}>{schoolName}</h1>
    </div>
  );
}
