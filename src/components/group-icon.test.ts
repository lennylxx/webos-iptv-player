import { describe, it, expect, vi } from 'vitest';
import { matchGroupIcon, groupIcon, isAdultGroupName, detectGroupLanguage, playlistLanguage } from './group-icon';
import { EXTRA_LEXICONS, GENRES, UI_LEXICONS, type Genre } from './group-icon-lexicon';
import { localeOptions, type SupportedLocale } from '../i18n';

describe('matchGroupIcon', () => {
  describe('category matching', () => {
    it('maps each genre to its icon', () => {
      expect(matchGroupIcon('Kids')).toBe('teddy_bear');
      expect(matchGroupIcon('Sports')).toBe('soccer_ball');
      expect(matchGroupIcon('Gaming')).toBe('gaming');
      expect(matchGroupIcon('News HD')).toBe('newspaper');
      expect(matchGroupIcon('Music')).toBe('musical_note');
      expect(matchGroupIcon('Cooking')).toBe('cooking');
      expect(matchGroupIcon('Shopping')).toBe('shopping');
      expect(matchGroupIcon('Adult')).toBe('no_one_under_eighteen');
      expect(matchGroupIcon('Documentaries')).toBe('world_map');
      expect(matchGroupIcon('Religion')).toBe('church');
      expect(matchGroupIcon('Movies')).toBe('clapper_board');
      expect(matchGroupIcon('Series')).toBe('television');
      expect(matchGroupIcon('Entertainment')).toBe('entertainment');
    });

    it('recognizes alias keywords', () => {
      expect(matchGroupIcon('Comedy')).toBe('entertainment');
      expect(matchGroupIcon('Food Network')).toBe('cooking');
    });
  });

  describe('normalization & matching rules', () => {
    it('ignores case and diacritics', () => {
      expect(matchGroupIcon('FÚTBOL')).toBe('soccer_ball');
      expect(matchGroupIcon('Notícias')).toBe('newspaper');
      expect(matchGroupIcon('Música')).toBe('musical_note');
      expect(matchGroupIcon('Niños')).toBe('teddy_bear');
    });

    it('strips IPTV prefixes, flags and quality tags', () => {
      expect(matchGroupIcon('FR| SPORT FHD')).toBe('soccer_ball');
      expect(matchGroupIcon('🇬🇧 UK | Kids')).toBe('teddy_bear');
      expect(matchGroupIcon('US: Music 4K')).toBe('musical_note');
    });

    it('uses token-prefix matching to avoid substring false-positives', () => {
      // "sport" is a substring of "passport" but not a token prefix.
      expect(matchGroupIcon('Passport Services')).toBeNull();
      expect(matchGroupIcon('αsports')).toBeNull();
    });

    it('splits tokens on Unicode punctuation and whitespace', () => {
      expect(matchGroupIcon('HD—Sports')).toBe('soccer_ball');
      expect(matchGroupIcon('UK\u2003Sports')).toBe('soccer_ball');
      expect(matchGroupIcon('Sports•News')).toBe('soccer_ball');
    });

    it('resolves overlaps by rule priority (first match wins)', () => {
      expect(matchGroupIcon('Kids Movies')).toBe('teddy_bear');            // kids before movies
      expect(matchGroupIcon('Adult Movies')).toBe('no_one_under_eighteen'); // adult before movies
    });

    it('matches +18 / 18+ markers as substrings', () => {
      expect(matchGroupIcon('Movies 18+')).toBe('no_one_under_eighteen');
      expect(matchGroupIcon('+18 VIP')).toBe('no_one_under_eighteen');
    });

    it('returns null for groups with no genre signal', () => {
      expect(matchGroupIcon('')).toBeNull();
      expect(matchGroupIcon('— •')).toBeNull();
      expect(matchGroupIcon('Uncategorized')).toBeNull();
      expect(matchGroupIcon('Random Channel 42')).toBeNull();
    });
  });

  describe('language coverage', () => {
    it('Spanish, incl. inflected forms', () => {
      expect(matchGroupIcon('Deportes')).toBe('soccer_ball');        // deport- stem
      expect(matchGroupIcon('Fútbol Deportivo')).toBe('soccer_ball');
      expect(matchGroupIcon('Noticiero 24h')).toBe('newspaper');     // notici- stem
      expect(matchGroupIcon('Películas')).toBe('clapper_board');
      expect(matchGroupIcon('Infantil')).toBe('teddy_bear');
      expect(matchGroupIcon('Documentales')).toBe('world_map');
      expect(matchGroupIcon('Cocina')).toBe('cooking');
      expect(matchGroupIcon('Música en Español')).toBe('musical_note');
    });

    it('German', () => {
      expect(matchGroupIcon('Nachrichten')).toBe('newspaper');
      expect(matchGroupIcon('Kinder')).toBe('teddy_bear');
      expect(matchGroupIcon('DE | Sport')).toBe('soccer_ball');
      expect(matchGroupIcon('Fußball Bundesliga')).toBe('soccer_ball');
      expect(matchGroupIcon('Dokumentation')).toBe('world_map');
      expect(matchGroupIcon('Geschichte & Wissen')).toBe('world_map');
      expect(matchGroupIcon('Kinofilme')).toBe('clapper_board');
      expect(matchGroupIcon('Unterhaltung')).toBe('entertainment');
    });

    it('Russian (Cyrillic)', () => {
      expect(matchGroupIcon('Спорт')).toBe('soccer_ball');
      expect(matchGroupIcon('Новости')).toBe('newspaper');
    });

    it('Simplified Chinese (substring — no word boundaries)', () => {
      expect(matchGroupIcon('体育频道')).toBe('soccer_ball');   // sports channel
      expect(matchGroupIcon('环球新闻')).toBe('newspaper');      // news mid-token
      expect(matchGroupIcon('电影')).toBe('clapper_board');      // movies
      expect(matchGroupIcon('电视剧')).toBe('television');       // series
      expect(matchGroupIcon('少儿频道')).toBe('teddy_bear');     // kids
      expect(matchGroupIcon('音乐')).toBe('musical_note');       // music
      expect(matchGroupIcon('购物')).toBe('shopping');           // shopping
      expect(matchGroupIcon('游戏')).toBe('gaming');             // gaming
      expect(matchGroupIcon('纪录片')).toBe('world_map');        // documentary
      expect(matchGroupIcon('娱乐')).toBe('entertainment');      // entertainment
    });

    it('Arabic, incl. the definite article (ال) and inflections', () => {
      expect(matchGroupIcon('رياضة')).toBe('soccer_ball');
      expect(matchGroupIcon('الرياضة')).toBe('soccer_ball');      // "the sports"
      expect(matchGroupIcon('الرِّيَاضَة')).toBe('soccer_ball');
      expect(matchGroupIcon('قنوات رياضية')).toBe('soccer_ball'); // adjective form
      expect(matchGroupIcon('الأخبار')).toBe('newspaper');        // the news
      expect(matchGroupIcon('أَخْبَار')).toBe('newspaper');
      expect(matchGroupIcon('قناة الأطفال')).toBe('teddy_bear');  // kids channel
      expect(matchGroupIcon('أفلام')).toBe('clapper_board');      // movies
      expect(matchGroupIcon('مسلسلات')).toBe('television');       // series
      expect(matchGroupIcon('ألعاب')).toBe('gaming');             // games
      expect(matchGroupIcon('تسوق')).toBe('shopping');            // shopping
      expect(matchGroupIcon('ترفيه')).toBe('entertainment');      // entertainment
    });
  });
});

const GENRE_SAMPLES: Record<SupportedLocale, Record<Genre, string>> = {
  en: { kids: 'Kids', sports: 'Sports', gaming: 'Gaming', news: 'News', music: 'Music', cooking: 'Cooking', shopping: 'Shopping', adult: 'Adult', documentary: 'Documentary', religion: 'Religious', movies: 'Movies', series: 'TV Series', entertainment: 'Entertainment', weather: 'Weather', business: 'Business', public: 'Legislative', classic: 'Classic', outdoor: 'Outdoor', auto: 'Auto', culture: 'Culture', lifestyle: 'Lifestyle', relax: 'Relax' },
  de: { kids: 'Kinder', sports: 'Sport', gaming: 'Spiele', news: 'Nachrichten', music: 'Musik', cooking: 'Kochen', shopping: 'Einkaufen', adult: 'Erotik', documentary: 'Doku', religion: 'Religion', movies: 'Spielfilme', series: 'Serien', entertainment: 'Unterhaltung', weather: 'Wetter', business: 'Wirtschaft', public: 'Parlament', classic: 'Klassiker', outdoor: 'Angeln', auto: 'Kfz', culture: 'Kultur', lifestyle: 'Wohnen & Garten', relax: 'Entspannung' },
  fr: { kids: 'Jeunesse', sports: 'Sports', gaming: 'Jeux vidéo', news: 'Infos', music: 'Musique', cooking: 'Cuisine', shopping: 'Téléachat', adult: 'Adultes', documentary: 'Documentaires', religion: 'Religion', movies: 'Films', series: 'Séries', entertainment: 'Divertissement', weather: 'Météo', business: 'Économie', public: 'Parlement', classic: 'Classiques', outdoor: 'Chasse et pêche', auto: 'Automobile', culture: 'Culturel', lifestyle: 'Maison', relax: 'Détente' },
  it: { kids: 'Bambini', sports: 'Calcio', gaming: 'Videogiochi', news: 'Notizie', music: 'Musica', cooking: 'Cucina', shopping: 'Televendite', adult: 'Adulti', documentary: 'Documentari', religion: 'Religione', movies: 'Film', series: 'Serie TV', entertainment: 'Intrattenimento', weather: 'Meteo', business: 'Economia', public: 'Parlamento', classic: 'Classici', outdoor: 'Caccia e pesca', auto: 'Motori', culture: 'Cultura', lifestyle: 'Moda', relax: 'Rilassamento' },
  es: { kids: 'Infantil', sports: 'Deportes', gaming: 'Videojuegos', news: 'Noticias', music: 'Música', cooking: 'Cocina', shopping: 'Teletienda', adult: 'Adultos', documentary: 'Documentales', religion: 'Religión', movies: 'Películas', series: 'Telenovelas', entertainment: 'Entretenimiento', weather: 'El Tiempo', business: 'Negocios', public: 'Congreso', classic: 'Clásicos', outdoor: 'Caza y pesca', auto: 'Coches', culture: 'Cultura', lifestyle: 'Hogar', relax: 'Relajación' },
  'pt-BR': { kids: 'Infantil', sports: 'Esportes', gaming: 'Jogos', news: 'Notícias', music: 'Música', cooking: 'Culinária', shopping: 'Compras', adult: 'Adultos', documentary: 'Documentários', religion: 'Religiosos', movies: 'Filmes', series: 'Novelas', entertainment: 'Variedades', weather: 'Previsão do tempo', business: 'Economia', public: 'Política', classic: 'Clássicos', outdoor: 'Pesca', auto: 'Carros', culture: 'Arte', lifestyle: 'Saúde', relax: 'Relaxamento' },
  pl: { kids: 'Dla dzieci', sports: 'Sport', gaming: 'Gry', news: 'Wiadomości', music: 'Muzyka', cooking: 'Kulinarne', shopping: 'Telezakupy', adult: 'Dla dorosłych', documentary: 'Dokumentalne', religion: 'Religijne', movies: 'Filmy', series: 'Seriale', entertainment: 'Rozrywka', weather: 'Pogoda', business: 'Biznes', public: 'Sejm', classic: 'Klasyka', outdoor: 'Wędkarstwo', auto: 'Motoryzacja', culture: 'Kultura', lifestyle: 'Styl życia', relax: 'Relaks' },
  tr: { kids: 'Çocuk', sports: 'Spor', gaming: 'Oyun', news: 'Haber', music: 'Müzik', cooking: 'Yemek', shopping: 'Alışveriş', adult: 'Yetişkin', documentary: 'Belgesel', religion: 'Dini', movies: 'Sinema', series: 'Dizi', entertainment: 'Eğlence', weather: 'Hava Durumu', business: 'Ekonomi', public: 'Meclis', classic: 'Klasik', outdoor: 'Avcılık', auto: 'Otomobil', culture: 'Kültür', lifestyle: 'Yaşam', relax: 'Rahatlama' },
  ru: { kids: 'Детские', sports: 'Спорт', gaming: 'Игры', news: 'Новости', music: 'Музыка', cooking: 'Кулинария', shopping: 'Телемагазин', adult: 'Для взрослых', documentary: 'Познавательные', religion: 'Религия', movies: 'Кино', series: 'Сериалы', entertainment: 'Развлекательные', weather: 'Погода', business: 'Бизнес', public: 'Парламент', classic: 'Ретро', outdoor: 'Охота и рыбалка', auto: 'Авто', culture: 'Культура', lifestyle: 'Стиль жизни', relax: 'Релакс' },
  uk: { kids: 'Дитячі', sports: 'Спорт', gaming: 'Ігри', news: 'Новини', music: 'Музика', cooking: 'Кулінарія', shopping: 'Телемагазин', adult: 'Для дорослих', documentary: 'Пізнавальні', religion: 'Релігія', movies: 'Фільми', series: 'Серіали', entertainment: 'Розважальні', weather: 'Погода', business: 'Бізнес', public: 'Верховна Рада', classic: 'Ретро', outdoor: 'Риболовля', auto: 'Автомобілі', culture: 'Культура', lifestyle: 'Стиль життя', relax: 'Релакс' },
  'zh-CN': { kids: '少儿', sports: '体育', gaming: '游戏', news: '新闻', music: '音乐', cooking: '美食', shopping: '购物', adult: '成人', documentary: '纪录片', religion: '宗教', movies: '电影', series: '电视剧', entertainment: '综艺', weather: '天气', business: '财经', public: '政务', classic: '经典', outdoor: '户外', auto: '汽车', culture: '文化', lifestyle: '生活', relax: '放松' },
};

const GENRE_ICON: Record<Genre, string> = {
  kids: 'teddy_bear', sports: 'soccer_ball', gaming: 'gaming', news: 'newspaper',
  music: 'musical_note', cooking: 'cooking', shopping: 'shopping',
  adult: 'no_one_under_eighteen', documentary: 'world_map', religion: 'church',
  movies: 'clapper_board', series: 'television', entertainment: 'entertainment',
  weather: 'sun_behind_cloud', business: 'chart_increasing', public: 'classical_building',
  classic: 'film_frames', outdoor: 'camping', auto: 'automobile',
  culture: 'amphora', lifestyle: 'couch_and_lamp', relax: 'person_in_lotus_position',
};

describe('UI locale coverage', () => {
  for (const { value: locale } of localeOptions()) {
    it(`matches every genre in ${locale}`, () => {
      for (const genre of GENRES) {
        expect([genre, matchGroupIcon(GENRE_SAMPLES[locale][genre])]).toEqual([genre, GENRE_ICON[genre]]);
      }
    });
  }

  const fold = (text: string): string =>
    text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const allKeywords = (): Array<{ keyword: string; genre: Genre }> => {
    const lexicons = [...Object.values(UI_LEXICONS), ...Object.values(EXTRA_LEXICONS)];
    return lexicons.flatMap(lexicon => GENRES.flatMap(genre =>
      (lexicon[genre] ?? []).map(keyword => ({ keyword, genre }))));
  };

  it('never assigns one keyword to two genres', () => {
    const owner = new Map<string, Genre>();
    for (const { keyword, genre } of allKeywords()) {
      const text = fold(keyword.replace(/\*/g, ''));
      expect([keyword, owner.get(text) ?? genre]).toEqual([keyword, genre]);
      owner.set(text, genre);
    }
  });

  it('keeps stems long enough and out of other genres', () => {
    const keywords = allKeywords();
    for (const { keyword, genre } of keywords) {
      if (!/^[^*].*\*$/.test(keyword)) continue;
      const stem = fold(keyword.slice(0, -1));
      expect([keyword, stem.length >= 4]).toEqual([keyword, true]);
      for (const other of keywords) {
        // A phrase outranks a stem by design ("science fiction").
        if (other.genre === genre || other.keyword.includes(' ')) continue;
        expect([keyword, other.keyword, fold(other.keyword).startsWith(stem)])
          .toEqual([keyword, other.keyword, false]);
      }
    }
  });

  it('matches a word with a glued TV, HD, digit or + suffix', () => {
    expect(matchGroupIcon('News24')).toBe('newspaper');
    expect(matchGroupIcon('Kids+')).toBe('teddy_bear');
    expect(matchGroupIcon('KidsTV')).toBe('teddy_bear');
    expect(matchGroupIcon('SportHD')).toBe('soccer_ball');
    expect(matchGroupIcon('Info24')).toBe('newspaper');
  });

  it('does not let a short keyword swallow a longer word', () => {
    expect(matchGroupIcon('Новинки')).toBeNull();
    expect(matchGroupIcon('Новинки кино')).toBe('clapper_board');
    expect(matchGroupIcon('Dining')).toBeNull();
    expect(matchGroupIcon('Cristal')).toBeNull();
    expect(matchGroupIcon('Dokuz')).toBeNull();
    expect(matchGroupIcon('Serie A-Z')).toBe('television');
  });

  it('matches common variants', () => {
    expect(matchGroupIcon('Мультфильмы')).toBe('teddy_bear');
    expect(matchGroupIcon('Мультфільми')).toBe('teddy_bear');
    expect(matchGroupIcon('Cartoni animati')).toBe('teddy_bear');
    expect(matchGroupIcon('Dessins animés')).toBe('teddy_bear');
    expect(matchGroupIcon('Bajki')).toBe('teddy_bear');
    expect(matchGroupIcon('Telefilm')).toBe('television');
    expect(matchGroupIcon('Кіно')).toBe('clapper_board');
    expect(matchGroupIcon('财经')).toBe('chart_increasing');
    expect(matchGroupIcon('卫视')).toBe('entertainment');
    expect(matchGroupIcon('Comedies')).toBe('entertainment');
    expect(matchGroupIcon('Canais Esportivos')).toBe('soccer_ball');
    expect(matchGroupIcon('Jogos ao Vivo')).toBe('soccer_ball');
    expect(matchGroupIcon('Juegos Olímpicos')).toBe('soccer_ball');
    expect(matchGroupIcon('Информационные')).toBe('newspaper');
    expect(matchGroupIcon('Інформаційні')).toBe('newspaper');
    expect(matchGroupIcon('Informacyjne')).toBe('newspaper');
    expect(matchGroupIcon('影视')).toBe('clapper_board');
    expect(matchGroupIcon('Kirchliche')).toBe('church');
    expect(matchGroupIcon('Spielshows')).toBe('entertainment');
    expect(matchGroupIcon('Musikfilme')).toBe('musical_note');
    expect(matchGroupIcon('Nachrichtensender')).toBe('newspaper');
    expect(matchGroupIcon('Naturdokus')).toBe('world_map');
    expect(matchGroupIcon('Tierdokus')).toBe('world_map');
    expect(matchGroupIcon('Toonami')).toBe('teddy_bear');
  });
});

describe('broad catalog categories', () => {
  it('maps every common catalog category with a fitting icon', () => {
    const expected: Record<string, string | null> = {
      Animation: 'teddy_bear', Family: 'teddy_bear', Business: 'chart_increasing',
      Legislative: 'classical_building', Public: 'classical_building',
      Weather: 'sun_behind_cloud', Outdoor: 'camping', Auto: 'automobile',
      Culture: 'amphora', Lifestyle: 'couch_and_lamp', Classic: 'film_frames',
      Relax: 'person_in_lotus_position', Undefined: null,
    };
    for (const [group, icon] of Object.entries(expected)) {
      expect([group, matchGroupIcon(group)]).toEqual([group, icon]);
    }
  });

  it('matches common variants of the new genres', () => {
    const expected: Array<[string, string]> = [
      ['Forecast', 'sun_behind_cloud'], ['Politics', 'classical_building'],
      ['Gobierno', 'classical_building'], ['Governo', 'classical_building'],
      ['Politika', 'classical_building'], ['İş Dünyası', 'chart_increasing'],
      ['股票', 'chart_increasing'], ['Kaminfeuer', 'person_in_lotus_position'],
      ['Oto', 'automobile'], ['Мото', 'automobile'], ['老电影', 'film_frames'],
      ['赛车', 'soccer_ball'], ['Oldies', 'musical_note'],
    ];
    for (const [group, icon] of expected) {
      expect([group, matchGroupIcon(group)]).toEqual([group, icon]);
    }
  });

  it('prefers the specific genre over the broad one', () => {
    expect(matchGroupIcon('Business News')).toBe('chart_increasing');
    expect(matchGroupIcon('Weather News')).toBe('sun_behind_cloud');
    expect(matchGroupIcon('Classic Movies')).toBe('film_frames');
    expect(matchGroupIcon('Family Movies')).toBe('clapper_board');
    expect(matchGroupIcon('Home Shopping')).toBe('shopping');
  });

  it('keeps classical music under music', () => {
    expect(matchGroupIcon('Classical')).toBe('musical_note');
    expect(matchGroupIcon('Klassik')).toBe('musical_note');
    expect(matchGroupIcon('Musica Classica')).toBe('musical_note');
    expect(matchGroupIcon('Classica')).toBe('musical_note');
    expect(matchGroupIcon('Классическая музыка')).toBe('musical_note');
    expect(matchGroupIcon('古典音乐')).toBe('musical_note');
  });
});

describe('new genres keep their place', () => {
  const cases: Array<[string, string | null]> = [
    ['Classic Hits', 'musical_note'], ['Retro Hits', 'musical_note'],
    ['Golden Hits', 'musical_note'], ['Classic Rock', 'musical_note'],
    ['Action & Adventure', 'clapper_board'], ['Adventure Movies', 'clapper_board'],
    ['Filmes de Aventura', 'clapper_board'], ['Aventuras', null], ['Приключения', null],
    ['Comédie', 'entertainment'], ['FR| GÉNÉRALISTES', 'entertainment'],
    ['Generales', 'entertainment'], ['Culinary', 'cooking'], ['Gastro', 'cooking'],
    ['Foodies', 'cooking'], ['Newsroom', 'newspaper'], ['Journalism', 'newspaper'],
    ['Juniors', 'teddy_bear'], ['Kidz', 'teddy_bear'], ['KidsCo', 'teddy_bear'],
    ['Footy', 'soccer_ball'], ['Unterhaltungsshows', 'entertainment'], ['Tier', 'world_map'],
    ['Public Movies', 'clapper_board'], ['Public Music', 'musical_note'],
    ['Public Series', 'television'], ['Political Thriller', 'clapper_board'],
    ['Public Affairs', 'classical_building'], ['Public', 'classical_building'],
    ['Martial Arts', 'soccer_ball'], ['Art House Movies', 'clapper_board'],
    ['Cine Arte', 'clapper_board'], ['Soap Opera', 'television'],
    ['Culture & Religion', 'church'], ['Arte', 'amphora'],
    ['Classic Series', 'television'], ['Classic Sitcoms', 'television'],
    ['Советские сериалы', 'television'], ['Classic Comedy', 'entertainment'],
    ['Classic Movies', 'film_frames'], ['Classic TV', 'film_frames'], ['Retro', 'film_frames'],
    ['News & Weather', 'newspaper'], ['Wetter & Nachrichten', 'newspaper'],
    ['Weather', 'sun_behind_cloud'], ['Dom kina', 'clapper_board'],
    ['Chiller', null], ['Chillout', 'person_in_lotus_position'], ['Interactive', 'gaming'],
    ['Thriller Series', 'television'], ['Horror Series', 'television'],
    ['Action Series', 'television'], ['Sci Fi Series', 'television'],
    ['Science Fiction', 'clapper_board'], ['Horror', 'clapper_board'],
    ['IT | Generali', 'entertainment'], ['DE | Wissenschaft', 'world_map'],
    ['DE | Reisemagazine', 'world_map'], ['DE | Kirchen', 'church'],
    ['RU | Исламские', 'church'], ['Spirituality', 'church'],
    ['Einkaufsfernsehen', 'shopping'], ['TR | Türk Dizisi', 'television'],
    ['Planète+', 'world_map'], ['Moto GP', 'soccer_ball'], ['Moto2', 'soccer_ball'],
    ['Adult Animation', 'no_one_under_eighteen'], ['Adult Cartoons', 'no_one_under_eighteen'],
    ['XXX Kids', 'no_one_under_eighteen'], ['Hentai Cartoons', 'no_one_under_eighteen'],
    ['Rock Entertainment', 'entertainment'], ['Pop Culture', 'amphora'],
    ['Rock', 'musical_note'], ['Pop Music', 'musical_note'], ['Interactive Movies', 'clapper_board'],
    ['经典电影', 'film_frames'], ['PT | Telejornais', 'newspaper'],
    ['IT | Telegiornali', 'newspaper'], ['FR | Horreur', 'clapper_board'],
    ['Policier', 'clapper_board'], ['F1', 'soccer_ball'], ['Anime', 'teddy_bear'],
    ['Nat Geo Kids', 'teddy_bear'], ['National Geographic Kids', 'teddy_bear'],
    ['BBC Earth Kids', 'teddy_bear'], ['Al Jazeera Sport', 'soccer_ball'],
    ['Sky News Sport', 'soccer_ball'], ['Nat Geo Music', 'musical_note'], ['Nat Geo', 'world_map'],
    ['Kids 2018+', 'teddy_bear'], ['Sports 2018+', 'soccer_ball'], ['News 2021+', 'newspaper'],
    ['Movies 18+', 'no_one_under_eighteen'], ['Adult Hits', 'musical_note'],
    ['Adult Contemporary', 'musical_note'], ['Adult Education', 'world_map'],
    ['Childrens Channels', 'teddy_bear'], ['Radiosender', 'musical_note'],
    ['Spielekanal', 'gaming'], ['Kitchens', 'cooking'], ['Chefkoch', 'cooking'],
    ['Bibles', 'church'], ['Gospels', 'church'], ['Planetas', 'world_map'],
    ['Oceans', 'world_map'], ['Footballs', 'soccer_ball'], ['Golfing', 'soccer_ball'],
    ['Boxers', 'soccer_ball'], ['Comedyserien', 'entertainment'],
    ['Jogos da Copa', 'soccer_ball'], ['Jogos do Brasileirão', 'soccer_ball'], ['Jogos', 'gaming'],
    ['Türk Halk Müziği', 'musical_note'], ['Świat Muzyki', 'musical_note'],
    ['Хоккей', 'soccer_ball'], ['Бокс', 'soccer_ball'], ['Христианские', 'church'],
    ['Animações', 'teddy_bear'],
  ];
  it('resolves overlaps with the established genres', () => {
    for (const [group, icon] of cases) {
      expect([group, matchGroupIcon(group)]).toEqual([group, icon]);
    }
  });
});

describe('scoring', () => {
  it('lets a phrase outrank its first word', () => {
    expect(matchGroupIcon('Serie A')).toBe('soccer_ball');
    expect(matchGroupIcon('Game Show')).toBe('entertainment');
    expect(matchGroupIcon('Sci-Fi')).toBe('clapper_board');
  });

  it('lets the longest prefix claim a token', () => {
    expect(matchGroupIcon('Gameshows')).toBe('entertainment');
    expect(matchGroupIcon('Christmas')).toBeNull();
    expect(matchGroupIcon('Tierra')).toBeNull();
    expect(matchGroupIcon('Christian')).toBe('church');
    expect(matchGroupIcon('Tierwelt')).toBe('world_map');
  });

  it('lets a clear genre beat a weak keyword of a higher-priority genre', () => {
    expect(matchGroupIcon('Comedy Hits')).toBe('entertainment');
    expect(matchGroupIcon('Wild Cinema')).toBe('clapper_board');
    expect(matchGroupIcon('Hits')).toBe('musical_note');
  });
});

describe('language hints', () => {
  it('reads the language from a country prefix or flag', () => {
    expect(detectGroupLanguage('FR| Sport')).toBe('fr');
    expect(detectGroupLanguage('UK | Kids')).toBe('en');
    expect(detectGroupLanguage('UA: Новини')).toBe('uk');
    expect(detectGroupLanguage('[PL] Filmy')).toBe('pl');
    expect(detectGroupLanguage('🇩🇪 Kinder')).toBe('de');
    expect(detectGroupLanguage('🇧🇷 Filmes')).toBe('pt-BR');
    expect(detectGroupLanguage('|FR| Sport')).toBe('fr');
    expect(detectGroupLanguage('VIP FR: Sport')).toBe('fr');
    expect(detectGroupLanguage('FR \u258e Sport')).toBe('fr');
    expect(detectGroupLanguage('## FR ## Sport')).toBe('fr');
  });

  it('reads the language from letters only one UI language uses', () => {
    expect(detectGroupLanguage('Дитячі')).toBe('uk');
    expect(detectGroupLanguage('Сериалы')).toBe('ru');
    expect(detectGroupLanguage('Alışveriş')).toBe('tr');
    expect(detectGroupLanguage('Dla dorosłych')).toBe('pl');
    expect(detectGroupLanguage('电影')).toBe('zh-CN');
  });

  it('finds no language without a hint', () => {
    expect(detectGroupLanguage('Sports')).toBeNull();
    expect(detectGroupLanguage('TV-Shows')).toBeNull();
    expect(detectGroupLanguage('Новости')).toBeNull();
  });

  it('takes the playlist language from a majority of hinted groups', () => {
    expect(playlistLanguage(['Telenovelas', 'Teletienda', 'Sports', 'Movies'])).toBe('es');
    expect(playlistLanguage(['FR| Films', 'FR| Sport', 'DE| Kino'])).toBe('fr');
    expect(playlistLanguage(['FR| Films', 'DE| Kino'])).toBeNull();
    expect(playlistLanguage(['Sports', 'Movies'])).toBeNull();
    // A brand keyword belongs to no UI language, so it doesn't void the vote.
    expect(playlistLanguage(['Kids Disney', 'News CNN', 'Movies'])).toBe('en');
    expect(playlistLanguage(['Islam TV', 'Islamic', 'Quran', 'Movies'])).not.toBe('tr');
    const huge = Array.from({ length: 50_000 }, (_, i) => (i % 2 ? 'Telenovelas' : 'Teletienda'));
    expect(playlistLanguage(huge)).toBe('es');
  });

  it('settles a tie between equal genres for the group language', () => {
    expect(matchGroupIcon('Cinema Gaming')).toBe('gaming');
    expect(matchGroupIcon('Cinema Gaming', 'it')).toBe('clapper_board');
    expect(matchGroupIcon('IT| Cinema Gaming')).toBe('clapper_board');
    expect(matchGroupIcon('EN| Cinema Gaming', 'it')).toBe('gaming');
    expect(groupIcon('Cinema Gaming', undefined, 'it')).toContain('clapper_board');
  });

  it('never outranks a phrase or a clearer genre', () => {
    expect(matchGroupIcon('Serie A', 'es')).toBe('soccer_ball');
    expect(matchGroupIcon('Comedy Hits', 'en')).toBe('entertainment');
  });
});

describe('groupIcon (rendered HTML)', () => {
  it('renders a matched genre as an <img> at its asset path', () => {
    expect(groupIcon('Sports')).toBe(
      '<img class="group-logo" src="assets/group-icons/soccer_ball.svg" alt="">',
    );
  });

  it('renders All and Favorites as icons too', () => {
    expect(groupIcon('All', 'all')).toBe(
      '<img class="group-logo" src="assets/group-icons/all.svg" alt="">',
    );
    expect(groupIcon('Favorites', 'favorites')).toBe(
      '<img class="group-logo" src="assets/group-icons/star.svg" alt="">',
    );
  });

  it('falls back to a play-triangle SVG, not a font glyph, for unmatched groups', () => {
    const icon = groupIcon('Uncategorized');
    expect(icon).toMatch(/^<svg class="group-fallback-icon"[^>]*>.*<\/svg>$/);
    expect(icon).not.toMatch(/&#|[^\x20-\x7e]/);
  });
});

describe('Chrome 53 fallback', () => {
  it('matches with explicit ranges when Unicode properties are unavailable', async () => {
    const NativeRegExp = RegExp;
    const LegacyRegExp = function (pattern: string | RegExp, flags?: string): RegExp {
      if (typeof pattern === 'string' && pattern.includes('\\p{')) {
        throw new SyntaxError('Unsupported Unicode property escape');
      }
      return new NativeRegExp(pattern, flags);
    } as RegExpConstructor;

    vi.stubGlobal('RegExp', LegacyRegExp);
    vi.resetModules();
    try {
      const { matchGroupIcon: fallbackMatchGroupIcon } = await import('./group-icon');
      expect(fallbackMatchGroupIcon('HD—Sports')).toBe('soccer_ball');
      expect(fallbackMatchGroupIcon('UK\u2003Sports')).toBe('soccer_ball');
      expect(fallbackMatchGroupIcon('أَخْبَار')).toBe('newspaper');
      expect(fallbackMatchGroupIcon('الرِّيَاضَة')).toBe('soccer_ball');
      expect(fallbackMatchGroupIcon('Passport Services')).toBeNull();
      expect(fallbackMatchGroupIcon('— •')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});

describe('isAdultGroupName', () => {
  it('detects adult groups even when a higher-priority genre matches', () => {
    expect(isAdultGroupName('Adult')).toBe(true);
    expect(isAdultGroupName('XXX 18+')).toBe(true);
    expect(isAdultGroupName('Kids XXX')).toBe(true);
    expect(isAdultGroupName('成人')).toBe(true);
    for (const name of ['La Sexta', 'Sexta', 'Sexto Sentido', 'The Penthouse']) {
      expect([name, matchGroupIcon(name) === 'no_one_under_eighteen']).toEqual([name, false]);
    }
    for (const name of ['La Sexta', 'Sexto Sentido', 'Sextas', 'Sexteto', 'Kids 2018+', 'News 2021+']) {
      expect([name, isAdultGroupName(name)]).toEqual([name, false]);
    }
    for (const name of [
      'Hentai', '18 Plus', '18 +', '+ 18', 'FSK 18', 'Babestation', 'Redlight', 'PenthouseTV',
      'Sextape', 'Sexting', 'FSK18', 'NSFW', 'R18', 'X-Rated', 'Plus 18', 'Over 18', 'MILF',
      '18plus', 'Plus18', 'Over18', 'R-18', 'R 18', 'Interdit -18', '18 ans', 'Hardcore',
      'Fetish', 'Brasileirinhas', 'Русская ночь', 'Private TV', 'Adult Hits',
      'Порно', 'Секс', 'Sex', 'Sexo', 'Seks', 'Sexe', '色情', 'EXXXTRA',
      'Erotikfilme', 'Erotika', 'Erotisch', 'Erotyczne', 'Erwachsenenfilme',
      'Für Erwachsenen', 'Sexfilme', 'BrazzersTV', 'PlayboyTV', 'Sex+',
    ]) {
      expect([name, isAdultGroupName(name)]).toEqual([name, true]);
    }
    expect(isAdultGroupName('Kids')).toBe(false);
    expect(isAdultGroupName('News')).toBe(false);
  });
});
