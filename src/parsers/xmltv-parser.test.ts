// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  parseXMLTVWithStats,
  XMLTVStreamParser,
} from './xmltv-parser';

// Format a Date as an XMLTV UTC timestamp: YYYYMMDDHHMMSS +0000
function xmltvDate(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())} +0000`
  );
}

describe('parseXMLTV', () => {
  it('takes an empty guide that closes itself as complete', () => {
    expect(parseXMLTVWithStats('<?xml version="1.0"?><tv generator-info-name="g"/>').stats.incomplete).toBe(false);
  });

  it('marks a feed that ends before its closing </tv> incomplete', () => {
    const programme = '<programme channel="a" start="20240601110000 +0000" stop="20240601130000 +0000"><title>T</title></programme>';
    const opts = { nowMs: Date.UTC(2024, 5, 1, 12) };
    expect(parseXMLTVWithStats(`<tv>${programme}</tv>`, opts).stats.incomplete).toBe(false);
    const cut = parseXMLTVWithStats(`<tv>${programme}${programme.slice(0, 40)}`, opts);
    expect(cut.stats).toMatchObject({ incomplete: true, programmesKept: 1 });
  });

  it('reads a human-readable source name from the XMLTV root', () => {
    const result = parseXMLTVWithStats(`<?xml version="1.0"?>
      <tv source-info-name="Guide Alpha" generator-info-name="Generator">
      </tv>`).data;

    expect(result.sourceName).toBe('Guide Alpha');
  });

  it('falls back to the XMLTV generator name', () => {
    const result = parseXMLTVWithStats(
      '<tv generator-info-name="Generator Alpha"></tv>',
    ).data;

    expect(result.sourceName).toBe('Generator Alpha');
  });

  it('reads a program catch-up id, in any attribute position, and decodes entities', () => {
    const now = new Date();
    const start = xmltvDate(new Date(now.getTime() - 3_600_000));
    const stop = xmltvDate(new Date(now.getTime() + 3_600_000));
    const later = xmltvDate(new Date(now.getTime() + 7_200_000));
    const last = xmltvDate(new Date(now.getTime() + 10_800_000));
    const result = parseXMLTVWithStats(`<tv>
      <programme catchup-id="http://host/vod?id=p1&amp;x=1" start="${start}" stop="${stop}" channel="ch1">
        <title>Alpha</title>
      </programme>
      <programme start="${stop}" stop="${later}" channel="ch1" catchup-id="p2"><title>Bravo</title></programme>
      <programme start="${later}" stop="${last}" channel="ch1"><title>Charlie</title></programme>
    </tv>`).data;

    const [alpha, bravo, charlie] = result.programmes.ch1;
    expect(charlie.title).toBe('Charlie');
    expect('catchupId' in charlie).toBe(false);
    expect(alpha.catchupId).toBe('http://host/vod?id=p1&x=1');
    expect(bravo.catchupId).toBe('p2');
  });

  it('reads the catch-up id among attributes it does not use', () => {
    const now = new Date();
    const start = xmltvDate(new Date(now.getTime() - 3_600_000));
    const stop = xmltvDate(new Date(now.getTime() + 3_600_000));
    const later = xmltvDate(new Date(now.getTime() + 7_200_000));
    const result = parseXMLTVWithStats(`<tv>
      <programme vps-start="${start}" clumpidx="0/1" catchup-idx="no" catchup-id="p3&amp;q"
        pdc-start="${start}" start="${start}" stop="${stop}" showview='a"b' channel="ch1">
        <title>Alpha</title>
      </programme>
      <programme start="${stop}" stop="${later}" channel="ch1" videoplus="x" catchup-id='p4'
        clumpidx="1/2"><title>Bravo</title></programme>
    </tv>`).data;

    expect(result.programmes.ch1.map(p => [p.title, p.catchupId])).toEqual([
      ['Alpha', 'p3&q'],
      ['Bravo', 'p4'],
    ]);
  });

  it('keeps catch-up ids only for the channels asked for, by id or display name', () => {
    const now = new Date();
    const start = xmltvDate(new Date(now.getTime() - 3_600_000));
    const stop = xmltvDate(new Date(now.getTime() + 3_600_000));
    const xml = `<tv>
      <channel id="ch2"><display-name>Bravo</display-name></channel>
      <programme start="${start}" stop="${stop}" channel="ch1" catchup-id="p1"><title>A</title></programme>
      <programme start="${start}" stop="${stop}" channel="ch2" catchup-id="p2"><title>B</title></programme>
      <programme start="${start}" stop="${stop}" channel="ch3" catchup-id="p3"><title>C</title></programme>
    </tv>`;
    const ids = (options: Parameters<typeof parseXMLTVWithStats>[1]) => {
      const { programmes } = parseXMLTVWithStats(xml, options).data;
      return ['ch1', 'ch2', 'ch3'].map(id => programmes[id]?.[0]?.catchupId ?? null);
    };

    expect(ids({})).toEqual(['p1', 'p2', 'p3']);
    expect(ids({ catchupIdChannelIds: new Set(['ch1']), catchupIdChannelNames: new Set(['bravo']) }))
      .toEqual(['p1', 'p2', null]);
    expect(ids({ catchupIdChannelIds: new Set(), catchupIdChannelNames: new Set() }))
      .toEqual([null, null, null]);
  });

  it('parses channels with display names and icons', () => {
    const xml = `<?xml version="1.0"?>
      <tv>
        <channel id="chan1">
          <display-name>Channel One</display-name>
          <icon src="http://logo/chan1.png"/>
        </channel>
      </tv>`;
    const { channels } = parseXMLTVWithStats(xml).data;
    expect(channels['chan1']).toEqual({ name: 'Channel One', icon: 'http://logo/chan1.png' });
  });

  it('parses programmes that fall within the ±7 day window', () => {
    const start = new Date();
    const stop = new Date(start.getTime() + 60 * 60 * 1000);
    const xml = `<?xml version="1.0"?>
      <tv>
        <channel id="c1"><display-name>Chan</display-name></channel>
        <programme channel="c1" start="${xmltvDate(start)}" stop="${xmltvDate(stop)}">
          <title>The Show</title>
          <desc>An episode</desc>
        </programme>
      </tv>`;
    const { programmes } = parseXMLTVWithStats(xml).data;
    expect(programmes['c1']).toHaveLength(1);
    expect(programmes['c1'][0].title).toBe('The Show');
  });

  it('drops programmes far outside the time window', () => {
    const old = new Date('2000-01-01T00:00:00Z');
    const oldStop = new Date('2000-01-01T01:00:00Z');
    const xml = `<?xml version="1.0"?>
      <tv>
        <channel id="c1"><display-name>Chan</display-name></channel>
        <programme channel="c1" start="${xmltvDate(old)}" stop="${xmltvDate(oldStop)}">
          <title>Ancient</title>
        </programme>
      </tv>`;
    const { programmes } = parseXMLTVWithStats(xml).data;
    expect(programmes['c1']).toBeUndefined();
  });

  it('decodes entities, CDATA, nested text, and stray ampersands', () => {
    const start = new Date();
    const stop = new Date(start.getTime() + 60 * 60 * 1000);
    const xml = `<tv>
      <channel id="c&amp;1">
        <display-name><![CDATA[Alpha & Bravo]]></display-name>
        <icon src="http://host/a?x=1&amp;y=2"/>
      </channel>
      <programme channel="c&amp;1" start="${xmltvDate(start)}" stop="${xmltvDate(stop)}">
        <title>Alpha & Bravo &amp; <b>Charlie</b></title>
        <desc><![CDATA[One &amp; Two]]></desc>
        <category>News &#x26; Talk</category>
      </programme>
    </tv>`;
    const result = parseXMLTVWithStats(xml).data;
    expect(result.channels['c&1']).toEqual({
      name: 'Alpha & Bravo',
      icon: 'http://host/a?x=1&y=2',
    });
    expect(result.programmes['c&1'][0]).toMatchObject({
      title: 'Alpha & Bravo & Charlie',
      description: 'One &amp; Two',
      category: 'News & Talk',
    });
  });

  it('accepts single quotes and whitespace around attribute equals', () => {
    const start = new Date();
    const stop = new Date(start.getTime() + 60 * 60 * 1000);
    const xml = `<tv>
      <channel id = 'c1'><display-name>Alpha</display-name></channel>
      <programme channel = 'c1' start = '${xmltvDate(start)}' stop = '${xmltvDate(stop)}'>
        <title>First</title>
      </programme>
    </tv>`;
    expect(parseXMLTVWithStats(xml).data.programmes.c1[0].title).toBe('First');
  });

  it('parses every possible chunk boundary identically', () => {
    const start = new Date();
    const stop = new Date(start.getTime() + 60 * 60 * 1000);
    const xml = `<?xml version="1.0"?><!DOCTYPE tv [<!ELEMENT tv ANY>]><tv>
      <!-- <programme channel="ignored"> -->
      <channel id="c1"><display-name>Alpha</display-name><icon src="http://host/a"/></channel>
      <programme channel="c1" start="${xmltvDate(start)}" stop="${xmltvDate(stop)}">
        <title>First &amp; Best</title><desc>Long enough description</desc>
      </programme>
    </tv>`;
    const expected = parseXMLTVWithStats(xml).data;
    for (let split = 1; split < xml.length; split++) {
      const parser = new XMLTVStreamParser();
      parser.write(xml.slice(0, split));
      parser.write(xml.slice(split));
      expect(parser.finish()).toEqual(expected);
    }
  });

  it('filters channels before retaining their programmes', () => {
    const start = new Date();
    const stop = new Date(start.getTime() + 60 * 60 * 1000);
    const xml = `<tv>
      <channel id="c1"><display-name>Alpha</display-name></channel>
      <channel id="c2"><display-name>Bravo</display-name></channel>
      <programme channel="c1" start="${xmltvDate(start)}" stop="${xmltvDate(stop)}"><title>One</title></programme>
      <programme channel="c2" start="${xmltvDate(start)}" stop="${xmltvDate(stop)}"><title>Two</title></programme>
    </tv>`;
    const result = parseXMLTVWithStats(xml, { channelIds: new Set(['c2']) }).data;
    expect(Object.keys(result.channels)).toEqual(['c2']);
    expect(Object.keys(result.programmes)).toEqual(['c2']);
  });

  it('can retain the channel catalog while filtering programme arrays', () => {
    const start = new Date();
    const stop = new Date(start.getTime() + 60 * 60 * 1000);
    const xml = `<tv>
      <channel id="c1"><display-name>Alpha</display-name></channel>
      <channel id="c2"><display-name>Bravo</display-name></channel>
      <programme channel="c1" start="${xmltvDate(start)}" stop="${xmltvDate(stop)}"><title>One</title></programme>
      <programme channel="c2" start="${xmltvDate(start)}" stop="${xmltvDate(stop)}"><title>Two</title></programme>
    </tv>`;
    const result = parseXMLTVWithStats(xml, {
      channelIds: new Set(['c2']),
      retainChannelCatalog: true,
    }).data;
    expect(Object.keys(result.channels)).toEqual(['c1', 'c2']);
    expect(Object.keys(result.programmes)).toEqual(['c2']);
    expect(result.channelCatalogComplete).toBe(true);
  });

  it('sorts only unordered schedules and preserves equal-time input order', () => {
    const now = new Date();
    const earlier = new Date(now.getTime() - 60 * 60 * 1000);
    const stop = (start: Date): Date => new Date(start.getTime() + 30 * 60 * 1000);
    const xml = `<tv>
      <programme channel="c1" start="${xmltvDate(now)}" stop="${xmltvDate(stop(now))}"><title>Later A</title></programme>
      <programme channel="c1" start="${xmltvDate(earlier)}" stop="${xmltvDate(stop(earlier))}"><title>Earlier</title></programme>
      <programme channel="c1" start="${xmltvDate(now)}" stop="${xmltvDate(stop(now))}"><title>Later B</title></programme>
    </tv>`;
    expect(parseXMLTVWithStats(xml).data.programmes.c1.map(programme => programme.title))
      .toEqual(['Earlier', 'Later A', 'Later B']);
  });

  it('captures the first retained programme timezone and validates dates', () => {
    const now = new Date();
    const start = xmltvDate(now).replace('+0000', '+0530');
    const stop = xmltvDate(new Date(now.getTime() + 60 * 60 * 1000)).replace('+0000', '+0530');
    const xml = `<tv>
      <programme channel="bad" start="20260230000000 +0000" stop="${stop}"><title>Bad</title></programme>
      <programme channel="c1" start="${start}" stop="${stop}"><title>Good</title></programme>
    </tv>`;
    const result = parseXMLTVWithStats(xml).data;
    expect(result.tzOffsetMinutes).toBe(330);
    expect(result.programmes.bad).toBeUndefined();
  });

  it('continues past malformed and incomplete elements', () => {
    const start = new Date();
    const stop = new Date(start.getTime() + 60 * 60 * 1000);
    const parser = new XMLTVStreamParser();
    parser.write(`<tv>
      <programme channel="c1" start="bad" stop="bad"><title>Bad</title></programme>
      <programme channel="c1" start="${xmltvDate(start)}" stop="${xmltvDate(stop)}"><title>Good</title></programme>
      <programme channel="c1"><title>Incomplete`);
    const result = parser.finish();
    expect(result.programmes.c1.map(programme => programme.title)).toEqual(['Good']);
    expect(parser.stats.skippedDate).toBe(1);
    expect(parser.stats.malformed).toBeGreaterThan(0);
  });
});

describe('parseXMLTV channel filter', () => {
  const start = new Date();
  const stop = new Date(start.getTime() + 60 * 60 * 1000);
  const feed = `<tv>
      <channel id="c1"><display-name>Alpha</display-name></channel>
      <channel id="c2"><display-name>Bravo</display-name><display-name>Bravo HD</display-name></channel>
      <channel id="c3"><display-name>Charlie</display-name></channel>
      <programme channel="c1" start="${xmltvDate(start)}" stop="${xmltvDate(stop)}"><title>A</title></programme>
      <programme channel="c2" start="${xmltvDate(start)}" stop="${xmltvDate(stop)}"><title>B</title></programme>
      <programme channel="c3" start="${xmltvDate(start)}" stop="${xmltvDate(stop)}"><title>C</title></programme>
    </tv>`;

  it('keeps only the requested ids', () => {
    const parser = new XMLTVStreamParser({ channelIds: new Set(['c1']) });
    parser.write(feed);
    const result = parser.finish();
    expect(Object.keys(result.channels)).toEqual(['c1']);
    expect(Object.keys(result.programmes)).toEqual(['c1']);
    expect(parser.stats.programmesSeen).toBe(3);
    expect(parser.stats.programmesKept).toBe(1);
    expect(parser.stats.skippedFilter).toBeGreaterThan(0);
  });

  it('admits a channel matched by any display name, including its programmes', () => {
    const result = parseXMLTVWithStats(
      feed,
      { channelNames: new Set(['bravo hd']) },
    ).data;
    expect(Object.keys(result.channels)).toEqual(['c2']);
    expect(result.channels.c2.name).toBe('Bravo');
    expect(result.channels.c2.aliases).toEqual(['Bravo HD']);
    expect(result.programmes.c2.map(programme => programme.title)).toEqual(['B']);
  });

  it('matches programmes declared before their channel', () => {
    const reordered = `<tv>
      <programme channel="c2" start="${xmltvDate(start)}" stop="${xmltvDate(stop)}"><title>B</title></programme>
      <channel id="c2"><display-name>Bravo</display-name><display-name>Bravo HD</display-name></channel>
    </tv>`;
    const result = parseXMLTVWithStats(
      reordered,
      { channelNames: new Set(['bravo hd']) },
    ).data;
    expect(result.programmes.c2.map(programme => programme.title)).toEqual(['B']);
  });

  it('matches and retains a requested display name after the retention cap', () => {
    const aliases = `<tv>
      <channel id="c4">
        <display-name>One</display-name><display-name>Two</display-name>
        <display-name>Three</display-name><display-name>Four</display-name>
        <display-name>Five</display-name>
      </channel>
      <programme channel="c4" start="${xmltvDate(start)}" stop="${xmltvDate(stop)}"><title>D</title></programme>
    </tv>`;
    const result = parseXMLTVWithStats(
      aliases,
      { channelNames: new Set(['five']) },
    ).data;
    expect(result.channels.c4.aliases).toContain('Five');
    expect(result.programmes.c4.map(programme => programme.title)).toEqual(['D']);
  });

  it('counts filter matches before discarding out-of-range programmes', () => {
    const parser = new XMLTVStreamParser({
      nowMs: start.getTime() + 30 * 24 * 60 * 60 * 1000,
      channelNames: new Set(['bravo hd']),
    });
    parser.write(feed);
    parser.finish();
    expect(parser.stats.channelsKept).toBe(1);
    expect(parser.stats.programmesMatched).toBe(1);
    expect(parser.stats.programmesKept).toBe(0);
  });

  it('unions ids and names', () => {
    const result = parseXMLTVWithStats(feed, {
      channelIds: new Set(['c1']),
      channelNames: new Set(['charlie']),
    }).data;
    expect(Object.keys(result.programmes).sort()).toEqual(['c1', 'c3']);
  });

  it('keeps everything when no filter is configured', () => {
    const result = parseXMLTVWithStats(
      feed,
      { channelIds: new Set(), channelNames: new Set() },
    ).data;
    expect(Object.keys(result.programmes).sort()).toEqual(['c1', 'c2', 'c3']);
  });
});


describe('parseXMLTV retention ceiling', () => {
  const now = Date.now();
  const feed = (count: number): string => {
    let xml = '<tv>';
    for (let i = 0; i < count; i++) {
      const start = new Date(now + i * 60_000);
      const stop = new Date(now + (i + 1) * 60_000);
      xml += `<channel id="c${String(i)}"><display-name>Ch ${String(i)}`
        + '</display-name></channel>'
        + `<programme channel="c${String(i)}" start="${xmltvDate(start)}"`
        + ` stop="${xmltvDate(stop)}"><title>P${String(i)}</title></programme>`;
    }
    return xml + '</tv>';
  };

  it('stops retaining past the ceiling and counts what it dropped', () => {
    const { data, stats } = parseXMLTVWithStats(feed(10), { maxProgrammes: 4 });

    expect(stats.programmesKept).toBe(4);
    expect(stats.droppedBudget).toBe(6);
    expect(stats.programmesSeen).toBe(10);
    expect(Object.keys(data.programmes).sort()).toEqual(['c0', 'c1', 'c2', 'c3']);
  });

  it('leaves the channel catalog complete past the ceiling', () => {
    const { data } = parseXMLTVWithStats(feed(10), { maxProgrammes: 4 });

    expect(Object.keys(data.channels)).toHaveLength(10);
  });

  it('retains everything when no ceiling is configured', () => {
    const { stats } = parseXMLTVWithStats(feed(10));

    expect(stats.programmesKept).toBe(10);
    expect(stats.droppedBudget).toBe(0);
  });
});
