import {
  TbRun, TbSwimming, TbBallBasketball, TbBallVolleyball, TbBallFootball,
  TbBallBaseball, TbBallTennis, TbPingPong, TbChess, TbKarate, TbTargetArrow,
  TbTarget, TbBike, TbGolf, TbCricket, TbRugby, TbBallAmericanFootball,
  TbBallBowling, TbSportBillard, TbBarbell, TbStretching2, TbYoga, TbJumpRope,
  TbSword, TbKayak, TbSailboat, TbHorse, TbSkateboard, TbRollerSkating,
  TbMountain, TbDeviceGamepad2, TbCards, TbPuzzle, TbUsers, TbWheelchair,
  TbTrophy,
} from 'react-icons/tb';
import { ShuttlecockIcon, BoxingGloveIcon, TakrawBallIcon } from '../components/SportIcon/customSportIcons';

/* ═══════════════════════════════════════════
   SPORT ICON CATALOGUE
   Every sport's icon comes from this one Tabler (24px, 2px round stroke)
   family so they all match — no uploaded images. Tabler has no badminton,
   boxing or sepak takraw glyph, so those three are drawn in
   components/SportIcon/customSportIcons.jsx with the exact same grid/stroke.
═══════════════════════════════════════════ */

/* `match` = words/phrases that auto-pick this icon from a sport's name
   (whole-word, so "ml" never fires inside "html"). When several icons match
   the longest phrase wins, which is why "table tennis" beats "tennis" and
   "american football" beats "football". */
export const SPORT_ICONS = [
  { key: 'athletics',     label: 'Athletics',          Icon: TbRun,                 match: ['athletics', 'track', 'track and field', 'running', 'run', 'sprint', 'marathon', 'relay', 'hurdles', 'race walk', 'racewalk', 'pentathlon', 'decathlon', 'triathlon'] },
  { key: 'swimming',      label: 'Swimming',           Icon: TbSwimming,            match: ['swimming', 'swim', 'aquatics', 'diving', 'water polo'] },
  { key: 'basketball',    label: 'Basketball',         Icon: TbBallBasketball,      match: ['basketball', 'hoops', '3x3', 'streetball'] },
  { key: 'volleyball',    label: 'Volleyball',         Icon: TbBallVolleyball,      match: ['volleyball', 'volley'] },
  { key: 'football',      label: 'Football / Futsal',  Icon: TbBallFootball,        match: ['football', 'soccer', 'futsal'] },
  { key: 'baseball',      label: 'Baseball / Softball', Icon: TbBallBaseball,       match: ['baseball', 'softball'] },
  { key: 'tennis',        label: 'Tennis',             Icon: TbBallTennis,          match: ['tennis', 'lawn tennis'] },
  { key: 'table-tennis',  label: 'Table Tennis',       Icon: TbPingPong,            match: ['table tennis', 'ping pong', 'pingpong'] },
  { key: 'badminton',     label: 'Badminton',          Icon: ShuttlecockIcon,       match: ['badminton', 'shuttlecock', 'shuttle'] },
  { key: 'sepak-takraw',  label: 'Sepak Takraw',       Icon: TakrawBallIcon,        match: ['sepak takraw', 'takraw', 'sepak', 'sipa'] },
  { key: 'chess',         label: 'Chess / Dama',       Icon: TbChess,               match: ['chess', 'dama', 'checkers', 'draughts'] },
  { key: 'martial-arts',  label: 'Martial Arts',       Icon: TbKarate,              match: ['taekwondo', 'karate', 'judo', 'martial arts', 'arnis', 'wushu', 'kung fu', 'jiu jitsu', 'muay thai', 'aikido', 'kickboxing', 'wrestling', 'sumo'] },
  { key: 'boxing',        label: 'Boxing',             Icon: BoxingGloveIcon,       match: ['boxing', 'boxer'] },
  { key: 'archery',       label: 'Archery',            Icon: TbTargetArrow,         match: ['archery', 'bow', 'arrow'] },
  { key: 'shooting',      label: 'Shooting / Darts',   Icon: TbTarget,              match: ['shooting', 'darts', 'dart', 'target', 'marksmanship'] },
  { key: 'cycling',       label: 'Cycling',            Icon: TbBike,                match: ['cycling', 'biking', 'bike', 'bicycle', 'bmx', 'mountain bike'] },
  { key: 'golf',          label: 'Golf',               Icon: TbGolf,                match: ['golf', 'mini golf'] },
  { key: 'cricket',       label: 'Cricket',            Icon: TbCricket,             match: ['cricket'] },
  { key: 'rugby',         label: 'Rugby',              Icon: TbRugby,               match: ['rugby'] },
  { key: 'american-football', label: 'American Football', Icon: TbBallAmericanFootball, match: ['american football', 'gridiron', 'flag football'] },
  { key: 'bowling',       label: 'Bowling',            Icon: TbBallBowling,         match: ['bowling', 'tenpin'] },
  { key: 'billiards',     label: 'Billiards',          Icon: TbSportBillard,        match: ['billiards', 'billiard', 'pool', 'snooker'] },
  { key: 'weightlifting', label: 'Weightlifting',      Icon: TbBarbell,             match: ['weightlifting', 'weight lifting', 'powerlifting', 'bodybuilding', 'crossfit', 'gym', 'fitness'] },
  { key: 'gymnastics',    label: 'Gymnastics & Dance', Icon: TbStretching2,         match: ['gymnastics', 'aerobics', 'calisthenics', 'stretching', 'cheerleading', 'cheer', 'cheerdance', 'dance', 'dancesport', 'zumba'] },
  { key: 'yoga',          label: 'Yoga',               Icon: TbYoga,                match: ['yoga', 'pilates'] },
  { key: 'jump-rope',     label: 'Jump Rope',          Icon: TbJumpRope,            match: ['jump rope', 'rope skipping', 'skipping', 'double dutch'] },
  { key: 'fencing',       label: 'Fencing',            Icon: TbSword,               match: ['fencing', 'sword', 'swordsmanship'] },
  { key: 'rowing',        label: 'Rowing / Canoe',     Icon: TbKayak,               match: ['rowing', 'kayak', 'kayaking', 'canoe', 'canoeing', 'dragon boat', 'dragonboat', 'paddle'] },
  { key: 'sailing',       label: 'Sailing',            Icon: TbSailboat,            match: ['sailing', 'sailboat', 'regatta', 'windsurfing'] },
  { key: 'equestrian',    label: 'Equestrian',         Icon: TbHorse,               match: ['equestrian', 'horse riding', 'horseback', 'polo'] },
  { key: 'skateboarding', label: 'Skateboarding',      Icon: TbSkateboard,          match: ['skateboarding', 'skateboard'] },
  { key: 'roller-skating', label: 'Roller Skating',    Icon: TbRollerSkating,       match: ['roller skating', 'rollerblading', 'inline skating', 'skating', 'roller derby'] },
  { key: 'climbing',      label: 'Climbing / Hiking',  Icon: TbMountain,            match: ['climbing', 'rock climbing', 'mountaineering', 'hiking', 'trekking', 'orienteering'] },
  { key: 'esports',       label: 'Esports',            Icon: TbDeviceGamepad2,      match: ['esports', 'e sports', 'mobile legends', 'mlbb', 'ml', 'valorant', 'dota', 'cod', 'call of duty', 'league of legends', 'wild rift', 'gaming', 'video games', 'online games', 'free fire', 'minecraft', 'crossfire'] },
  { key: 'card-games',    label: 'Card Games',         Icon: TbCards,               match: ['card', 'cards', 'card games', 'uno'] },
  { key: 'puzzle',        label: 'Puzzle & Mind Games', Icon: TbPuzzle,             match: ['puzzle', 'scrabble', 'rubik', 'rubiks', 'speedcubing', 'quiz', 'quiz bee', 'spelling bee', 'trivia', 'sudoku', 'board games', 'board game', 'mind games'] },
  { key: 'team-game',     label: 'Team Game',          Icon: TbUsers,               match: ['tug of war', 'handball', 'dodgeball', 'netball', 'kickball', 'patintero', 'frisbee', 'ultimate frisbee'] },
  { key: 'para',          label: 'Para Sports',        Icon: TbWheelchair,          match: ['para', 'paralympic', 'wheelchair', 'special olympics', 'adaptive'] },
];

/* Shown when a sport's name matches nothing and no icon was picked */
export const DEFAULT_SPORT_ICON = { key: 'general', label: 'General', Icon: TbTrophy };

const BY_KEY = new Map([...SPORT_ICONS, DEFAULT_SPORT_ICON].map(i => [i.key, i]));

const words = (s) => ` ${String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()} `;

/* icon key a sport's NAME points at, or null when nothing matches */
export function guessSportIconKey(name) {
  const hay = words(name);
  if (hay.trim() === '') return null;
  let best = null;
  let bestLen = 0;
  for (const entry of SPORT_ICONS) {
    for (const term of entry.match) {
      const t = words(term).trim();
      if (t.length > bestLen && (hay.includes(` ${t} `) || hay.includes(` ${t}s `))) {
        best = entry.key;
        bestLen = t.length;
      }
    }
  }
  return best;
}

/* What to draw for a sport: the admin's explicit pick (`sport.icon`) wins,
   otherwise the name is matched, otherwise the general trophy.
   `source` says which of the three it was. */
export function resolveSportIcon(sport) {
  const chosen = sport?.icon && BY_KEY.get(sport.icon);
  if (chosen) return { ...chosen, source: 'chosen' };
  const guessed = BY_KEY.get(guessSportIconKey(sport?.name));
  if (guessed) return { ...guessed, source: 'auto' };
  return { ...DEFAULT_SPORT_ICON, source: 'default' };
}
