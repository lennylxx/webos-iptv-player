// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { parseXMLTV, XMLTVStreamParser } from './xmltv-parser';

// Format a Date as an XMLTV UTC timestamp: YYYYMMDDHHMMSS +0000
function xmltvDate(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())} +0000`
  );
}

describe('parseXMLTV', () => {
  it('parses channels with display names and icons', () => {
    const xml = `<?xml version="1.0"?>
      <tv>
        <channel id="chan1">
          <display-name>Channel One</display-name>
          <icon src="http://logo/chan1.png"/>
        </channel>
      </tv>`;
    const { channels } = parseXMLTV(xml);
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
    const { programmes } = parseXMLTV(xml);
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
    const { programmes } = parseXMLTV(xml);
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
    const result = parseXMLTV(xml);
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
    expect(parseXMLTV(xml).programmes.c1[0].title).toBe('First');
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
    const expected = parseXMLTV(xml);
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
    const result = parseXMLTV(xml, { channelIds: new Set(['c2']) });
    expect(Object.keys(result.channels)).toEqual(['c2']);
    expect(Object.keys(result.programmes)).toEqual(['c2']);
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
    expect(parseXMLTV(xml).programmes.c1.map(programme => programme.title))
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
    const result = parseXMLTV(xml);
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
