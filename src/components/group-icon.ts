// Genre-icon matching for channel groups. Group titles are short, noisy and
// multilingual, so we normalize (lowercase + strip diacritics), tokenize on
// word boundaries (keeping non-Latin scripts intact), then match each rule's
// keywords against the title: an alphabetic word as a token PREFIX (catches
// plurals/inflections/translations and avoids substring false-positives like
// "sport" in "passport"); a phrase, symbol ("nat geo", "18+"), or CJK/Arabic
// keyword as a substring (CJK has no word boundaries; Arabic glues on "ال").
// Rules are in priority order — first match wins, so list specific genres
// first. Author keywords lowercase + accent-free (Latin) or in native script
// (non-Latin); adding a language is a one-line edit to GROUP_ICON_RULES below.
//
// Icons are Twemoji artwork (https://github.com/jdecked/twemoji), licensed
// under CC-BY 4.0 (https://creativecommons.org/licenses/by/4.0/); each is a
// file in assets/group-icons/<name>.svg.

const GROUP_ICON_DIR = 'assets/group-icons';

interface IconRule {
  icon: string;
  keywords: string[];
}

const GROUP_ICON_RULES: IconRule[] = [
  {
    icon: 'teddy_bear',
    keywords: ['kid', 'child', 'cartoon', 'toon', 'infantil', 'junior', 'baby', 'babies', 'nick', 'disney', 'enfant', 'kinder', 'zeichentrick', 'kika', 'bambini', 'cocuk', 'nino', 'ninos', 'dibujos', 'caricatura', 'desenho', 'детск', 'дети', 'اطفال', '儿童', '少儿', '卡通', '动画', '动漫'],
  },
  {
    icon: 'soccer_ball',
    keywords: ['sport', 'spor', 'deport', 'esport', 'futbol', 'futebol', 'baloncesto', 'ciclismo', 'foot', 'football', 'soccer', 'calcio', 'fussball', 'fußball', 'bundesliga', 'voetbal', 'pilka', 'nba', 'nfl', 'nhl', 'mlb', 'ufc', 'boxing', 'boxe', 'golf', 'tennis', 'tenis', 'cricket', 'rugby', 'racing', 'motogp', 'formula', 'espn', 'bein', 'dazn', 'eurosport', 'спорт', 'футбол', 'رياض', '体育', '运动', '足球', '篮球'],
  },
  {
    icon: 'gaming',
    keywords: ['gaming', 'gamer', 'games', 'game', 'twitch', 'videojuego', 'juego', 'spiele', 'العاب', '游戏', '电竞'],
  },
  {
    icon: 'newspaper',
    keywords: ['news', 'notici', 'notizie', 'nachricht', 'actualit', 'haber', 'nieuws', 'wiadomosc', 'journal', 'breaking', 'cnn', 'bbc', 'msnbc', 'euronews', 'cnbc', 'aljazeera', 'новост', 'أخبار', 'al jazeera', 'sky news', 'fox news', '新闻', '资讯'],
  },
  {
    icon: 'musical_note',
    keywords: ['music', 'musica', 'musique', 'musik', 'muzyka', 'muzik', 'mtv', 'vevo', 'hits', 'radio', 'song', 'concert', 'concierto', 'konzert', 'karaoke', 'музык', 'موسيق', '音乐'],
  },
  {
    icon: 'cooking',
    keywords: ['cook', 'food', 'kitchen', 'recipe', 'chef', 'cocina', 'gastro', 'culinar', 'cuisine', 'kochen', 'طبخ', 'طعام', '美食', '烹饪', '料理'],
  },
  {
    icon: 'shopping',
    keywords: ['shop', 'teleshop', 'qvc', 'compra', 'tienda', 'einkauf', 'achat', 'تسوق', '购物'],
  },
  {
    icon: 'no_one_under_eighteen',
    keywords: ['adult', 'adulte', 'xxx', 'porn', 'erotic', 'erotik', 'взросл', 'yetiskin', 'erwachsen', 'brazzers', 'playboy', 'للكبار', 'بالغ', '+18', '18+', '21+', '成人'],
  },
  {
    icon: 'world_map',
    keywords: ['document', 'docu', 'dokument', 'discovery', 'histor', 'histoire', 'geschichte', 'science', 'cienc', 'wissen', 'nature', 'natur', 'tier', 'animal', 'planet', 'travel', 'viaje', 'voyage', 'reise', 'educa', 'wild', 'ocean', 'наук', 'документаль', 'истори', 'وثائق', 'nat geo', 'national geographic', 'bbc earth', '纪录', '探索', '自然', '历史', '科学', '地理'],
  },
  {
    icon: 'church',
    keywords: ['relig', 'church', 'gospel', 'islam', 'christ', 'cristian', 'quran', 'koran', 'bible', 'biblia', 'spiritual', 'catholic', 'catolic', 'iglesia', 'igreja', 'eglise', 'kirche', 'kilise', 'jesus', 'allah', 'mosque', 'mezquita', 'hindu', 'buddh', 'ислам', 'религ', 'православ', 'قرآن', 'ديني', 'اسلام', 'مسيحي', '宗教', '基督', '佛教', '伊斯兰'],
  },
  {
    icon: 'clapper_board',
    keywords: ['movie', 'film', 'cinema', 'cine', 'pelicula', 'kino', 'sinema', 'vod', 'افلام', 'فيلم', 'кино', 'фильм', '电影', '影院'],
  },
  {
    icon: 'television',
    keywords: ['series', 'serie', 'serial', 'show', 'shows', 'sitcom', 'episod', 'dizi', 'novela', 'сериал', 'مسلسل', '电视剧', '连续剧', '剧集'],
  },
  {
    icon: 'entertainment',
    keywords: ['entertain', 'entreten', 'unterhaltung', 'divertiss', 'variety', 'variedad', 'general', 'comedy', 'comedi', 'ترفيه', 'منوعات', '娱乐', '综艺'],
  },
];

// Normalize for matching: strip combining diacritics ("Fútbol" -> "futbol"),
// unify Arabic alef/hamza/teh-marbuta/alef-maksura variants (so "الأطفال"
// folds toward "اطفال"), and lowercase.
function fold(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\p{Diacritic}ٕٓٔ]/gu, '')  // accents + Arabic tashkeel/hamza/madda
    .replace(/[آأإٱ]/gu, 'ا')   // آأإٱ -> ا
    .replace(/ى/gu, 'ي')                       // ى -> ي
    .replace(/ة/gu, 'ه')                       // ة -> ه
    .toLowerCase();
}

// Split into word tokens on anything that isn't a letter, digit or '+'.
// \p{L}/\p{N} keep Cyrillic/Arabic/CJK letters intact; '+' preserves markers
// like "18+". (Unicode property escapes need Chromium 64+; webOS 5 is 68.)
function tokenize(folded: string): string[] {
  return folded.split(/[^\p{L}\p{N}+]+/u).filter(Boolean);
}

// Pre-fold keywords once so rules can be authored with or without accents.
const RULES: IconRule[] = GROUP_ICON_RULES.map(rule => ({
  icon: rule.icon,
  keywords: rule.keywords.map(fold),
}));

function keywordHits(keyword: string, folded: string, tokens: string[]): boolean {
  // Alphabetic word (Latin/Cyrillic...) -> token prefix (catches inflections,
  // avoids substring false-positives like "sport" in "passport"). CJK and
  // Arabic are excluded -> substring: CJK has no word boundaries, and Arabic
  // glues the definite article/clitics ("ال") onto the front of words.
  if (/^[\p{L}\p{N}]+$/u.test(keyword) && !/[\p{sc=Han}\p{sc=Arabic}]/u.test(keyword)) {
    return tokens.some(token => token.startsWith(keyword));
  }
  // Phrase ("nat geo"), symbol ("18+"), CJK or Arabic keyword -> substring.
  return folded.includes(keyword);
}

/**
 * Map a group title to an icon file name (without extension), or null
 * when nothing matches (the caller falls back to a generic glyph).
 */
export function matchGroupIcon(group: string): string | null {
  const folded = fold(group);
  const tokens = tokenize(folded);
  for (const rule of RULES) {
    if (rule.keywords.some(keyword => keywordHits(keyword, folded, tokens))) {
      return rule.icon;
    }
  }
  return null;
}

function iconImg(name: string): string {
  return `<img class="group-logo" src="${GROUP_ICON_DIR}/${name}.svg" alt="">`;
}

/**
 * Render the group-list icon as an HTML string: a matched `<img>`
 * pointing at its asset path, the dedicated All/Favorites icons, or a generic
 * play-triangle icon for unmatched groups. (Inserted via the caller's `raw()`
 * helper.)
 */
export function groupIcon(group: string): string {
  if (group === 'All') return iconImg('all');
  if (group === 'Favorites') return iconImg('star');
  if (group === 'Recently Watched') return iconImg('three_oclock');
  const icon = matchGroupIcon(group);
  return icon ? iconImg(icon) : '&#9654;'; // fallback for unmatched groups
}
