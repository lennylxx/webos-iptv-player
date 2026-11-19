// Per-language genre keywords for channel-group icons. Group titles come from
// the playlist, not the UI language, so every lexicon is always active; each
// UI locale must cover every genre (group-icon.test.ts enforces it).
//
// Authoring: Latin keywords lowercase without accents, other scripts in
// their native form. A bare word matches a whole token only, so a short word
// in one language can't swallow a longer word in another ("dini" is not
// "dining"). A trailing "*" marks a stem that matches a token prefix
// ("deport*" -> "deportes", "deportivo"); list inflections instead when the
// stem would be short or ambiguous. A multi-word phrase matches whole tokens
// in order and outranks single words ("serie a" beats "serie"). Han, Arabic,
// symbol ("18+") and "*...*" keywords match as substrings. A token that
// matches nothing is retried without a glued "TV", "HD" or digit/"+" suffix
// ("News24", "KidsTV"). Adult keywords also match any token prefix in
// isAdultGroupName, since a missed adult group costs more than a false
// suggestion.

import type { SupportedLocale } from '../i18n';

export type Genre =
  | 'kids'
  | 'sports'
  | 'gaming'
  | 'weather'
  | 'business'
  | 'news'
  | 'public'
  | 'music'
  | 'cooking'
  | 'shopping'
  | 'adult'
  | 'classic'
  | 'documentary'
  | 'outdoor'
  | 'auto'
  | 'culture'
  | 'religion'
  | 'movies'
  | 'series'
  | 'lifestyle'
  | 'relax'
  | 'entertainment';

export type Lexicon = Record<Genre, string[]>;

// Priority order: on an equal score the earlier genre wins ("Kids Movies"),
// so a specific genre precedes a broad one ("Business News"). Culture and
// classic modify other genres ("Classic Series", "Art House Movies"), so they
// come late; phrases keep "Classic Movies" classic.
export const GENRES: readonly Genre[] = [
  'kids', 'sports', 'gaming', 'weather', 'business', 'news', 'public', 'music',
  'cooking', 'shopping', 'adult', 'documentary', 'outdoor', 'auto', 'religion',
  'movies', 'series', 'culture', 'lifestyle', 'relax', 'entertainment', 'classic',
];

export const UI_LEXICONS: Record<SupportedLocale, Lexicon> = {
  en: {
    kids: ['kids*', 'kid', 'kidz', 'kiddo', 'children*', 'child', 'cartoon*', 'toon*', 'junior*', 'baby', 'babies', 'family', 'animation', 'animated', 'anime'],
    sports: ['sport*', 'football*', 'footy', 'martial arts', 'moto gp', 'moto2', 'moto3', 'f1', 'soccer', 'boxing', 'boxer*', 'golf*', 'tennis', 'cricket', 'rugby', 'racing', 'motorsport*', 'formula', 'basketball', 'hockey'],
    gaming: ['gaming', 'gamer', 'gamers', 'game', 'games', 'videogame*', 'esports', 'esport', 'interactive'],
    news: ['news*', 'breaking', 'info', 'infos', 'journalism', 'news weather', 'news and weather'],
    music: ['music*', 'hits', 'radio*', 'song*', 'concert*', 'karaoke', 'classical', 'oldies', 'rock', 'pop', 'jazz', 'adult hits', 'adult contemporary', 'classic hits', 'classic rock', 'retro hits', 'golden hits'],
    cooking: ['cooking', 'cook*', 'food*', 'culinar*', 'gastro*', 'kitchen*', 'recipe*', 'chef*'],
    shopping: ['shop*', 'teleshop*'],
    adult: ['adult*', '*xxx*', 'porn*', 'erot*', 'sex', 'sexy'],
    documentary: ['docu*', 'discovery', 'histor*', 'science*', 'nature', 'animal*', 'planet*', 'travel*', 'educa*', 'wild', 'wildlife', 'ocean*', 'adult education'],
    religion: ['religi*', 'church*', 'gospel*', 'faith', 'christian*', 'bible*', 'spiritual*', 'catholic*'],
    movies: ['movie*', 'film*', 'cinema*', 'science fiction', 'sci fi', 'scifi', 'action', 'thriller', 'thrillers', 'horror', 'political thriller', 'political thrillers'],
    series: ['series', 'serial*', 'show', 'shows', 'sitcom*', 'episode*', 'soap opera', 'soap operas'],
    weather: ['weather', 'forecast', 'meteorolog*'],
    business: ['business*', 'finance*', 'financial', 'economy', 'money', 'markets'],
    public: ['legislativ*', 'parliament*', 'government', 'congress*', 'senate', 'public', 'public tv', 'public affairs', 'public broadcasting', 'public service', 'politics', 'political'],
    classic: ['classic', 'classics', 'retro', 'vintage', 'nostalgi*', 'golden', 'classic movies', 'classic films', 'classic cinema', 'classic tv', 'retro tv'],
    outdoor: ['outdoor*', 'hunting', 'fishing', 'camping'],
    auto: ['auto', 'autos', 'car', 'cars', 'motor', 'motors', 'automotive', 'moto'],
    culture: ['culture*', 'cultural', 'arts', 'art', 'theater', 'theatre', 'opera', 'ballet', 'museum*'],
    lifestyle: ['lifestyle*', 'fashion', 'home', 'garden*', 'beauty', 'health'],
    relax: ['relax*', 'ambient', 'chill', 'chillout', 'chill out', 'calm', 'meditation', 'sleep', 'fireplace', 'aquarium', 'slow tv'],
    entertainment: ['entertain*', 'variety', 'general', 'generalist*', 'comedy', 'comedi*', 'game show', 'game shows', 'gameshow*', 'talk show', 'talk shows'],
  },
  de: {
    kids: ['kinder*', 'zeichentrick*', 'familie'],
    sports: ['sport*', 'fussball', 'fußball', 'bundesliga'],
    gaming: ['spiele*', 'games', 'zocken'],
    news: ['nachricht*', 'aktuell', 'wetter nachrichten', 'nachrichten wetter', 'nachrichten und wetter', 'wetter und nachrichten'],
    music: ['musik*', 'konzert*', 'klassik', 'klassische musik'],
    cooking: ['kochen', 'kochshow*', 'chefkoch', 'kuche', 'kulinarisch*'],
    shopping: ['einkauf*', 'shopping'],
    adult: ['erwachsen*', 'erot*', 'sex'],
    documentary: ['doku', 'dokus', 'dokument*', 'tierdoku*', 'tier', 'wissen*', 'geschichte', 'natur*', 'tiere', 'tierwelt', 'reise*'],
    religion: ['religi*', 'kirche*', 'kirchlich*', 'christlich*', 'glaube'],
    movies: ['film*', 'kino*', 'spielfilm*'],
    series: ['serie', 'serien'],
    weather: ['wetter'],
    business: ['wirtschaft*', 'finanz*', 'borse'],
    public: ['parlament*', 'bundestag', 'landtag', 'politik', 'offentlich*', 'regierung'],
    classic: ['klassiker'],
    outdoor: ['angeln', 'jagd'],
    auto: ['kfz', 'fahrzeug*'],
    culture: ['kultur*', 'kunst'],
    lifestyle: ['wohnen', 'garten', 'gesundheit', 'schonheit', 'mode'],
    relax: ['entspann*', 'kamin*'],
    entertainment: ['unterhaltung*', 'comedy*', 'spielshow*'],
  },
  fr: {
    kids: ['enfant*', 'jeunesse', 'dessins animes', 'dessin anime', 'famille'],
    sports: ['sport*', 'foot', 'football'],
    gaming: ['jeux', 'jeux video', 'jeuxvideo', 'jeu video'],
    news: ['info', 'infos', 'information*', 'actualite*', 'journal', 'journaux'],
    music: ['musique*', 'concert*', 'musique classique'],
    cooking: ['cuisine*', 'gastronomie', 'culinaire*'],
    shopping: ['achat*', 'teleachat'],
    adult: ['adulte*', 'erot*', 'sexe', 'pour adultes'],
    documentary: ['docu*', 'histoire', 'science*', 'nature', 'decouverte*', 'voyage*', 'animaux', 'planete'],
    religion: ['religi*', 'eglise', 'chretien*', 'catholique*'],
    movies: ['film*', 'cinema*', 'horreur', 'policier', 'policiers'],
    series: ['serie*', 'feuilleton*'],
    weather: ['meteo'],
    business: ['economie', 'economique*', 'affaires', 'bourse'],
    public: ['parlement*', 'assemblee', 'senat', 'politique', 'publique'],
    classic: ['classiques', 'classique'],
    outdoor: ['chasse', 'peche', 'plein air'],
    auto: ['automobile', 'automobiles', 'voiture*'],
    culture: ['culturel*'],
    lifestyle: ['maison', 'jardin*', 'sante', 'beaute', 'art de vivre'],
    relax: ['detente', 'zen'],
    entertainment: ['divertissement*', 'humour', 'variete*', 'generaliste*'],
  },
  it: {
    kids: ['bambini', 'ragazzi', 'cartoni', 'cartoni animati', 'famiglia', 'animazione'],
    sports: ['sport*', 'calcio', 'serie a', 'serie b'],
    gaming: ['giochi', 'videogiochi', 'videogioco'],
    news: ['notizie', 'notiziari*', 'informazione', 'telegiornal*'],
    music: ['musica', 'musicale', 'concerto', 'concerti', 'classica', 'musica classica'],
    cooking: ['cucina', 'culinari*'],
    shopping: ['acquisti', 'televendite', 'televendita', 'shopping'],
    adult: ['adulti', 'erot*', 'per adulti'],
    documentary: ['docu*', 'storia', 'scienza', 'scienze', 'natura', 'viaggi', 'viaggio', 'animali'],
    religion: ['religi*', 'chiesa', 'cristian*', 'cattolic*'],
    movies: ['film*', 'cinema*'],
    series: ['serie*', 'telefilm', 'fiction'],
    weather: ['meteo'],
    business: ['economia', 'finanza', 'affari', 'borsa'],
    public: ['parlamento', 'senato', 'politica', 'istituzional*', 'pubblic*'],
    classic: ['classici', 'vintage'],
    outdoor: ['caccia', 'pesca'],
    auto: ['motori', 'automobili'],
    culture: ['cultura', 'culturale', 'arte', 'teatro'],
    lifestyle: ['moda', 'casa', 'giardin*', 'salute', 'bellezza', 'stile di vita'],
    relax: ['rilass*'],
    entertainment: ['intrattenimento', 'varieta', 'commedia', 'commedie', 'generale*', 'generali'],
  },
  es: {
    kids: ['infantil*', 'nino', 'ninos', 'ninas', 'dibujos', 'dibujos animados', 'caricatura*', 'familia', 'animacion'],
    sports: ['deport*', 'futbol', 'baloncesto', 'ciclismo', 'juegos olimpicos'],
    gaming: ['juego*', 'videojuego*'],
    news: ['noticia*', 'noticiero*', 'informativo*'],
    music: ['musica*', 'concierto*', 'musica clasica'],
    cooking: ['cocina*', 'gastronomia', 'receta*'],
    shopping: ['compra*', 'tienda*', 'teletienda'],
    adult: ['adulto*', 'para adultos', 'sexo', 'erot*'],
    documentary: ['docu*', 'historia', 'ciencia*', 'naturaleza', 'viaje*', 'animal*'],
    religion: ['religi*', 'iglesia*', 'cristian*', 'catolic*', 'biblia'],
    movies: ['pelicula*', 'cine*'],
    series: ['serie*', 'telenovela*', 'novela*'],
    weather: ['el tiempo', 'clima', 'meteorolog*'],
    business: ['economia', 'negocios', 'finanzas'],
    public: ['parlamento', 'congreso', 'senado', 'politica', 'publico*', 'legislativ*', 'gobierno'],
    classic: ['clasicos', 'clasico', 'retro'],
    outdoor: ['caza', 'pesca', 'aire libre'],
    auto: ['coches', 'automovil*', 'motor'],
    culture: ['cultura', 'cultural', 'arte', 'teatro'],
    lifestyle: ['moda', 'hogar', 'jardin*', 'salud', 'belleza', 'estilo de vida'],
    relax: ['relajacion', 'relax*', 'meditacion'],
    entertainment: ['entretenimiento', 'variedad*', 'comedia*', 'generale*'],
  },
  'pt-BR': {
    kids: ['infantil*', 'crianca*', 'desenho*', 'animacao', 'animacoes'],
    sports: ['esporte*', 'esportiv*', 'futebol', 'brasileirao', 'copa', 'jogos de hoje', 'jogos ao vivo', 'jogos do dia'],
    gaming: ['jogo', 'jogos', 'videogame*', 'games'],
    news: ['noticia*', 'jornal*', 'telejorna*'],
    music: ['musica*', 'musica classica'],
    cooking: ['culinaria', 'receita*', 'cozinha'],
    shopping: ['compra*', 'loja*'],
    adult: ['adulto*', 'para adultos', 'sexo', 'erot*'],
    documentary: ['docu*', 'historia', 'ciencia*', 'natureza', 'viagem', 'viagens', 'animais'],
    religion: ['religi*', 'igreja*', 'gospel', 'evangel*', 'catolic*'],
    movies: ['filme*', 'cinema*'],
    series: ['serie*', 'novela*'],
    weather: ['previsao do tempo', 'clima'],
    business: ['economia', 'negocios', 'financas'],
    public: ['camara', 'senado', 'politica', 'publica', 'publico*', 'legislativ*', 'governo'],
    classic: ['classicos', 'classico', 'retro'],
    outdoor: ['caca', 'pesca', 'ar livre'],
    auto: ['carros', 'automove*', 'automobilismo'],
    culture: ['cultura', 'arte', 'teatro'],
    lifestyle: ['moda', 'casa', 'jardim', 'saude', 'beleza', 'estilo de vida'],
    relax: ['relax*', 'meditacao'],
    entertainment: ['entretenimento', 'variedade*', 'humor', 'comedia*'],
  },
  pl: {
    kids: ['dzieci', 'dziecie*', 'bajki', 'bajka', 'rodzin*', 'animowan*', 'animacj*'],
    sports: ['sport*', 'pilka', 'pilka nozna'],
    gaming: ['gry', 'gier', 'gry wideo'],
    news: ['wiadomosci', 'informacje', 'informacyjn*', 'fakty'],
    music: ['muzyk*', 'muzyczn*', 'koncert*', 'muzyka klasyczna'],
    cooking: ['kulinarn*', 'gotowanie', 'kuchnia'],
    shopping: ['zakupy', 'telezakupy'],
    adult: ['dorosl*', 'erot*', 'seks'],
    documentary: ['dokument*', 'popularnonaukow*', 'nauka', 'naukow*', 'historia', 'historyczn*', 'przyroda', 'przyrodnicz*', 'podroze'],
    religion: ['religi*', 'religijn*', 'koscio*', 'katolick*'],
    movies: ['film*', 'kino*', 'kina'],
    series: ['serial*'],
    weather: ['pogoda'],
    business: ['biznes', 'ekonomi*', 'finans*'],
    public: ['sejm', 'parlament*', 'senat', 'polityk*', 'publiczn*'],
    classic: ['klasyk*', 'retro'],
    outdoor: ['wedkarstw*', 'lowiectw*'],
    auto: ['motoryzacj*', 'samochod*'],
    culture: ['kultur*', 'sztuka', 'teatr'],
    lifestyle: ['styl zycia', 'moda', 'dom', 'ogrod*', 'zdrowie', 'uroda'],
    relax: ['relaks*', 'medytacj*'],
    entertainment: ['rozrywk*', 'komedi*'],
  },
  tr: {
    kids: ['cocuk*', 'cizgi', 'cizgi film', 'aile', 'animasyon'],
    sports: ['spor', 'futbol*'],
    gaming: ['oyun', 'oyunlar*'],
    news: ['haber*'],
    music: ['muzik*', 'muzigi', 'klasik muzik'],
    cooking: ['yemek*', 'mutfak*'],
    shopping: ['alisveris'],
    adult: ['yetiskin*', 'erot*'],
    documentary: ['belgesel*', 'tarih', 'bilim', 'doga', 'seyahat'],
    religion: ['dini', 'kuran'],
    movies: ['film*', 'sinema*'],
    series: ['dizi*'],
    weather: ['hava durumu'],
    business: ['ekonomi', 'borsa', 'finans', 'is dunyasi'],
    public: ['meclis', 'tbmm', 'siyaset', 'kamu', 'politika'],
    classic: ['klasik*', 'nostalji', 'yesilcam'],
    outdoor: ['avcilik', 'balikcilik'],
    auto: ['otomobil', 'araba*', 'oto'],
    culture: ['kultur*', 'sanat', 'tiyatro'],
    lifestyle: ['yasam', 'moda', 'saglik', 'guzellik'],
    relax: ['rahatla*', 'meditasyon'],
    entertainment: ['eglence*', 'komedi*'],
  },
  ru: {
    kids: ['детск*', 'дети', 'детей', 'мульт*', 'семейн*', 'анимаци*'],
    sports: ['спорт*', 'футбол*', 'хоккей', 'бокс'],
    gaming: ['игры', 'игров*', 'киберспорт*'],
    news: ['новост*', 'информационн*'],
    music: ['музык*', 'классическая музыка'],
    cooking: ['кулинар*', 'кухня', 'еда'],
    shopping: ['магазин*', 'телемагазин*', 'покупки', 'шопинг'],
    adult: ['взросл*', 'эрот*', 'порн*', 'секс*'],
    documentary: ['документальн*', 'познавательн*', 'научн*', 'наука', 'истори*', 'природа', 'путешеств*'],
    religion: ['религи*', 'православн*', 'церковь', 'ислам*', 'христиан*'],
    movies: ['кино*', 'фильм*'],
    series: ['сериал*'],
    weather: ['погода'],
    business: ['бизнес', 'экономик*', 'финанс*'],
    public: ['парламент*', 'дума', 'госдум*', 'политик*', 'обществен*', 'государствен*'],
    classic: ['классик*', 'ретро', 'ностальги*', 'советск*'],
    outdoor: ['охот*', 'рыбалк*', 'активный отдых'],
    auto: ['авто', 'автомобил*', 'мото'],
    culture: ['культур*', 'искусств*', 'театр*'],
    lifestyle: ['стиль жизни', 'мода', 'дом', 'здоровь*', 'красот*', 'дача'],
    relax: ['релакс*', 'медитаци*', 'отдых'],
    entertainment: ['развлекательн*', 'юмор*', 'комеди*'],
  },
  uk: {
    kids: ['дитяч*', 'діти', 'дітей', 'мульт*', 'сімейн*', 'анімаці*'],
    sports: ['спорт*', 'футбол*'],
    gaming: ['ігри', 'ігров*', 'кіберспорт*'],
    news: ['новини', 'інформаційн*'],
    music: ['музик*', 'музичн*', 'класична музика'],
    cooking: ['кулінар*', 'кухня', 'їжа'],
    shopping: ['телемагазин*', 'покупки', 'шопінг'],
    adult: ['доросл*', 'ерот*', 'порн*', 'секс*'],
    documentary: ['документальн*', 'пізнавальн*', 'наука', 'науков*', 'істори*', 'природа', 'подорож*'],
    religion: ['релігі*', 'православн*', 'церква'],
    movies: ['кіно*', 'фільм*'],
    series: ['серіал*'],
    weather: ['погода'],
    business: ['бізнес', 'економік*', 'фінанс*'],
    public: ['парламент*', 'верховна рада', 'політик*', 'суспільн*', 'державн*'],
    classic: ['класик*', 'ретро', 'ностальгі*'],
    outdoor: ['полювання', 'риболов*', 'активний відпочинок'],
    auto: ['авто', 'автомобіл*'],
    culture: ['культур*', 'мистецтв*', 'театр*'],
    lifestyle: ['стиль життя', 'мода', 'дім', 'здоров*', 'краса'],
    relax: ['релакс*', 'медитаці*', 'відпочинок'],
    entertainment: ['розважальн*', 'гумор*', 'комеді*'],
  },
  'zh-CN': {
    kids: ['儿童', '少儿', '卡通', '动画', '动漫', '亲子'],
    sports: ['体育', '运动', '足球', '篮球', '赛车'],
    gaming: ['游戏', '电竞'],
    news: ['新闻', '资讯'],
    music: ['音乐', '戏曲', '古典音乐'],
    cooking: ['美食', '烹饪', '料理'],
    shopping: ['购物'],
    adult: ['成人', '色情', '情色'],
    documentary: ['纪录', '探索', '科教', '自然', '历史', '科学', '地理'],
    religion: ['宗教', '基督', '佛教', '伊斯兰'],
    movies: ['电影', '影院', '影视'],
    series: ['电视剧', '连续剧', '剧集', '剧场'],
    weather: ['天气', '气象'],
    business: ['财经', '财富', '商业', '经济', '股市', '股票', '证券'],
    public: ['议会', '人大', '政务', '政府', '公共', '政协'],
    classic: ['经典', '怀旧', '老电影', '经典电影', '经典影视'],
    outdoor: ['户外', '钓鱼', '狩猎'],
    auto: ['汽车', '车迷'],
    culture: ['文化', '艺术', '戏剧', '人文'],
    lifestyle: ['生活', '时尚', '家居', '健康'],
    relax: ['放松', '休闲', '冥想', '助眠'],
    entertainment: ['娱乐', '综艺', '卫视', '央视', '综合'],
  },
};

// Playlist languages beyond the UI locales, plus cross-language brands and
// symbols. Partial: a genre may have no entry.
export const EXTRA_LEXICONS: Record<string, Partial<Lexicon>> = {
  ar: {
    kids: ['اطفال'],
    sports: ['رياض'],
    gaming: ['العاب'],
    news: ['أخبار'],
    music: ['موسيق'],
    cooking: ['طبخ', 'طعام'],
    shopping: ['تسوق'],
    adult: ['للكبار', 'بالغ'],
    documentary: ['وثائق'],
    religion: ['قرآن', 'ديني', 'اسلام', 'مسيحي'],
    movies: ['افلام', 'فيلم'],
    series: ['مسلسل'],
    entertainment: ['ترفيه', 'منوعات'],
  },
  other: {
    kids: ['nick*', 'disney*', 'kika'],
    sports: ['nba', 'nfl', 'nhl', 'mlb', 'ufc', 'boxe', 'tenis', 'motogp', 'voetbal', 'olymp*', 'jeux olympiques', 'espn*', 'bein*', 'dazn', 'eurosport*'],
    gaming: ['twitch'],
    business: ['cnbc', 'bloomberg*', 'fox business'],
    public: ['cspan', 'c span'],
    news: ['nieuws', 'newsmax', 'cnn', 'bbc', 'msnbc', 'euronews', 'aljazeera', 'al jazeera', 'sky news', 'fox news'],
    music: ['mtv', 'vevo'],
    shopping: ['qvc'],
    adult: ['brazzers*', 'playboy*', 'dorcel*', 'hustler*', 'babestation*', 'redlight*', 'hentai', 'milf', 'nsfw', 'r18', 'fsk18', '+18', '18+', '21+', '18 plus', '+ 18', '18 +', 'fsk 18', 'plus 18', 'over 18', 'x rated', '18plus', 'plus18', 'over18', 'r 18', 'interdit 18', '18 ans'],
    documentary: ['nat geo', 'national geographic', 'bbc earth'],
    religion: ['islam*', 'quran', 'koran', 'jesus', 'allah', 'mosque*', 'mezquita', 'hindu*', 'buddh*', 'kilise'],
    movies: ['vod', 'showtime'],
  },
};

// Keywords that score below any normal keyword: a genre they suggest yields
// to a clearer one ("Comedy Hits" is comedy, not music).
export const WEAK_KEYWORDS: readonly string[] = [
  'general', 'show', 'shows', 'hits', 'wild', 'info', 'infos', 'aktuell', '卫视', '央视', '综合',
  'public', 'political', 'art', 'arts', 'arte', 'opera', 'generalist*', 'generale*', 'generaliste*', 'generali',
  'action', 'horror', 'thriller', 'thrillers', 'scifi', 'sci fi', 'science fiction', 'rock', 'pop', 'interactive',
  'planete', 'anime', 'planet*', 'ocean*', 'jogo', 'jogos',
  'family', 'familie', 'famille', 'famiglia', 'familia', 'rodzin*', 'aile', 'семейн*', 'сімейн*', 'home', 'casa', 'dom', 'дом', 'дім',
];

// Adult-only hints for parental-control suggestions, never icons: a word or
// brand that is also an ordinary title ("The Penthouse", "Nude Science").
export const ADULT_HINTS: readonly string[] = [
  'penthouse', 'hardcore', 'softcore', 'fetish', 'nude', 'brasileirinhas', 'шалун',
  'русская ночь', 'ню арт', 'private tv',
];
