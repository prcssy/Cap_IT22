import { resolveSportIcon } from '../../constants/sportIcons';

/* Draws a sport's icon. Pass the sport object ({ name, icon }) — an explicit
   `icon` key wins, otherwise the name decides. Sizes with font-size / `size`
   and colors with `color`, like any react-icons glyph. */
export default function SportIcon({ sport, ...rest }) {
  const { Icon } = resolveSportIcon(sport);
  return <Icon aria-hidden="true" focusable="false" {...rest} />;
}
