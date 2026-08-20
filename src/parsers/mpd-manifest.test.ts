// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { parseMpd } from './mpd-manifest';

const ROLE = 'urn:mpeg:dash:role:2011';
const CICP = 'urn:mpeg:mpegB:cicp:TransferCharacteristics';
const CEA608 = 'urn:scte:dash:cc:cea-608:2015';
const CEA708 = 'urn:scte:dash:cc:cea-708:2015';
const DOLBY_JOC = 'tag:dolby.com,2018:dash:EC3_ExtensionType:2018';

function mpd(body: string, attrs = 'type="static"'): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" ${attrs}>${body}</MPD>`;
}

const VIDEO_SET = `
  <AdaptationSet contentType="video" mimeType="video/mp4">
    <Representation id="v1" width="1920" height="1080" codecs="avc1.640028" frameRate="30000/1001"/>
    <Representation id="v2" width="1280" height="720" codecs="avc1.4d401f" frameRate="25"/>
  </AdaptationSet>`;

describe('parseMpd', () => {
  it('reads presentation type and content protection from a static manifest', () => {
    const r = parseMpd(mpd(`<Period>${VIDEO_SET}</Period>`));
    expect(r.isLive).toBe(false);
    expect(r.hasContentProtection).toBe(false);
  });

  it('flags a dynamic manifest as live', () => {
    const r = parseMpd(mpd(`<Period>${VIDEO_SET}</Period>`, 'type="dynamic"'));
    expect(r.isLive).toBe(true);
  });

  it('flags a DRM ContentProtection scheme', () => {
    const r = parseMpd(mpd(`<Period>
      <AdaptationSet contentType="video" mimeType="video/mp4">
        <ContentProtection schemeIdUri="urn:uuid:00000000-0000-0000-0000-000000000000"/>
        <Representation id="v1" width="1920" height="1080" codecs="avc1.640028"/>
      </AdaptationSet></Period>`));
    expect(r.hasContentProtection).toBe(true);
  });

  it('does not treat the generic MP4 protection descriptor as DRM by itself', () => {
    const r = parseMpd(mpd(`<Period>
      <AdaptationSet contentType="video" mimeType="video/mp4">
        <ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011"
          value="cenc"/>
        <Representation id="v1" width="1920" height="1080" codecs="avc1.640028"/>
      </AdaptationSet></Period>`));
    expect(r.hasContentProtection).toBe(false);
  });

  it('names multi-language audio from Label, @label and the language code', () => {
    const r = parseMpd(mpd(`<Period>
      <AdaptationSet contentType="audio" lang="l1" codecs="mp4a.40.2">
        <Label>Track 1</Label>
        <Role schemeIdUri="${ROLE}" value="main"/>
        <Representation id="a1"/>
      </AdaptationSet>
      <AdaptationSet contentType="audio" lang="l2" label="Track 2">
        <Representation id="a2" codecs="ec-3"/>
      </AdaptationSet>
      <AdaptationSet contentType="audio" lang="l3">
        <Representation id="a3" codecs="mp4a.40.2"/>
      </AdaptationSet></Period>`));
    expect(r.audio).toEqual([
      { name: 'Track 1', lang: 'l1', isDefault: true },
      { name: 'Track 2', lang: 'l2', isDefault: false },
      { name: '', lang: 'l3', isDefault: false },
    ]);
  });

  it('falls back to the highest selectionPriority when no Role is main', () => {
    const r = parseMpd(mpd(`<Period>
      <AdaptationSet contentType="audio" lang="l1" selectionPriority="1">
        <Representation id="a1" codecs="mp4a.40.2"/>
      </AdaptationSet>
      <AdaptationSet contentType="audio" lang="l2" selectionPriority="5">
        <Representation id="a2" codecs="mp4a.40.2"/>
      </AdaptationSet></Period>`));
    expect(r.audio.map(a => a.isDefault)).toEqual([false, true]);
  });

  it('marks no audio default when nothing signals one', () => {
    const r = parseMpd(mpd(`<Period>
      <AdaptationSet contentType="audio" lang="l1">
        <Representation id="a1" codecs="mp4a.40.2"/>
      </AdaptationSet>
      <AdaptationSet contentType="audio" lang="l2">
        <Representation id="a2" codecs="mp4a.40.2"/>
      </AdaptationSet></Period>`));
    expect(r.audio.map(a => a.isDefault)).toEqual([false, false]);
  });

  it('classifies text WebVTT separately from native TTML, stpp and wvtt', () => {
    const r = parseMpd(mpd(`<Period>
      <AdaptationSet contentType="text" mimeType="text/vtt" lang="l1" label="Track 1">
        <Representation id="s1"/>
      </AdaptationSet>
      <AdaptationSet mimeType="application/ttml+xml" lang="l2">
        <Label>Track 2</Label>
        <Representation id="s2"/>
      </AdaptationSet>
      <AdaptationSet mimeType="application/mp4" lang="l3" codecs="stpp.ttml.im1t">
        <Representation id="s3"/>
      </AdaptationSet>
      <AdaptationSet mimeType="application/mp4" lang="l4" codecs="wvtt">
        <Representation id="s4"/>
      </AdaptationSet></Period>`));
    expect(r.subtitles.map(s => `${s.name}|${s.lang}`))
      .toEqual(['Track 1|l1', 'Track 2|l2', '|l3', '|l4']);
    expect(r.subtitles.map(s => s.dash?.kind))
      .toEqual(['webvtt', 'native', 'native', 'native']);
  });

  it('resolves a single-file DASH WebVTT rendition through inherited BaseURLs', () => {
    const r = parseMpd(mpd(`<BaseURL>media/</BaseURL><Period>
      <BaseURL>period/</BaseURL>
      <AdaptationSet contentType="text" mimeType="text/vtt" lang="l1">
        <Representation id="s1"><BaseURL>sub.vtt</BaseURL></Representation>
      </AdaptationSet></Period>`), 'http://host/path/stream.mpd');
    expect(r.subtitles[0].dash).toEqual({
      kind: 'webvtt',
      url: 'http://host/path/media/period/sub.vtt',
    });
  });

  it('expands a DASH WebVTT SegmentTimeline and template placeholders', () => {
    const r = parseMpd(mpd(`<Period>
      <AdaptationSet contentType="text" mimeType="application/x-subtitle-vtt" lang="l1">
        <SegmentTemplate media="subs/$RepresentationID$/$Number%05d$-$Time$.vtt"
          timescale="1000" startNumber="7">
          <SegmentTimeline><S t="2000" d="1500" r="1"/></SegmentTimeline>
        </SegmentTemplate>
        <Representation id="s1"/>
      </AdaptationSet></Period>`), 'http://host/path/stream.mpd');
    expect(r.subtitles[0].dash).toEqual({
      kind: 'webvtt',
      segments: [
        { url: 'http://host/path/subs/s1/00007-2000.vtt', start: 2, duration: 1.5 },
        { url: 'http://host/path/subs/s1/00008-3500.vtt', start: 3.5, duration: 1.5 },
      ],
    });
  });

  it('formats DASH template identifiers and preserves escaped dollars', () => {
    const r = parseMpd(mpd(`<Period>
      <AdaptationSet contentType="text" mimeType="text/vtt" lang="l1">
        <SegmentTemplate
          media="sub-$$Time$$-$Time%06d$-$Bandwidth%08d$-$Number%05d$.vtt"
          timescale="1000" startNumber="7">
          <SegmentTimeline><S t="2000" d="1500"/></SegmentTimeline>
        </SegmentTemplate>
        <Representation id="s1" bandwidth="1200"/>
      </AdaptationSet></Period>`), 'http://host/stream.mpd');
    expect(r.subtitles[0].dash?.segments).toEqual([{
      url: 'http://host/sub-$Time$-002000-00001200-00007.vtt',
      start: 2,
      duration: 1.5,
    }]);
  });

  it('maps SegmentTimeline through Period start and presentationTimeOffset', () => {
    const r = parseMpd(mpd(`<Period start="PT10S" duration="PT4S">
      <AdaptationSet contentType="text" mimeType="text/vtt" lang="l1">
        <SegmentTemplate media="sub-$Time$.vtt" timescale="1000"
          presentationTimeOffset="5000">
          <SegmentTimeline><S t="5000" d="2000" r="1"/></SegmentTimeline>
        </SegmentTemplate>
        <Representation id="s1"/>
      </AdaptationSet></Period>`), 'http://host/stream.mpd');
    expect(r.subtitles[0].dash?.segments).toEqual([
      { url: 'http://host/sub-5000.vtt', start: 10, duration: 2 },
      { url: 'http://host/sub-7000.vtt', start: 12, duration: 2 },
    ]);
  });

  it('inherits a SegmentTimeline when a Representation overrides template attributes', () => {
    const r = parseMpd(mpd(`<Period duration="PT4S">
      <AdaptationSet contentType="text" mimeType="text/vtt" lang="l1">
        <SegmentTemplate timescale="1000">
          <SegmentTimeline><S t="0" d="2000" r="1"/></SegmentTimeline>
        </SegmentTemplate>
        <Representation id="s1">
          <SegmentTemplate media="sub-$Time$.vtt"/>
        </Representation>
      </AdaptationSet></Period>`), 'http://host/stream.mpd');
    expect(r.subtitles[0].dash?.segments).toEqual([
      { url: 'http://host/sub-0.vtt', start: 0, duration: 2 },
      { url: 'http://host/sub-2000.vtt', start: 2, duration: 2 },
    ]);
  });

  it('inherits fixed duration when a Representation overrides the media template', () => {
    const r = parseMpd(mpd(`<Period duration="PT4S">
      <AdaptationSet contentType="text" mimeType="text/vtt" lang="l1">
        <SegmentTemplate timescale="1000" duration="2000"/>
        <Representation id="s1">
          <SegmentTemplate media="sub-$Number$.vtt"/>
        </Representation>
      </AdaptationSet></Period>`), 'http://host/stream.mpd');
    expect(r.subtitles[0].dash?.segments).toEqual([
      { url: 'http://host/sub-1.vtt', start: 0, duration: 2 },
      { url: 'http://host/sub-2.vtt', start: 2, duration: 2 },
    ]);
  });

  it('expands an open SegmentTimeline repeat to the Period boundary', () => {
    const r = parseMpd(mpd(`<Period duration="PT6S">
      <AdaptationSet contentType="text" mimeType="text/vtt" lang="l1">
        <SegmentTemplate media="sub-$Number$.vtt" timescale="1">
          <SegmentTimeline><S t="0" d="2" r="-1"/></SegmentTimeline>
        </SegmentTemplate>
        <Representation id="s1"/>
      </AdaptationSet></Period>`), 'http://host/stream.mpd');
    expect(r.subtitles[0].dash?.segments).toEqual([
      { url: 'http://host/sub-1.vtt', start: 0, duration: 2 },
      { url: 'http://host/sub-2.vtt', start: 2, duration: 2 },
      { url: 'http://host/sub-3.vtt', start: 4, duration: 2 },
    ]);
  });

  it('resolves SegmentList URLs and timeline timing', () => {
    const r = parseMpd(mpd(`<Period start="PT10S">
      <AdaptationSet contentType="text" mimeType="text/vtt" lang="l1">
        <BaseURL>subs/</BaseURL>
        <SegmentList timescale="1000" presentationTimeOffset="1000">
          <SegmentTimeline><S t="1000" d="2000" r="-1"/></SegmentTimeline>
          <SegmentURL media="a.vtt" mediaRange="0-99"/>
          <SegmentURL media="b.vtt"/>
        </SegmentList>
        <Representation id="s1"/>
      </AdaptationSet></Period>`), 'http://host/path/stream.mpd');
    expect(r.subtitles[0].dash?.segments).toEqual([
      {
        url: 'http://host/path/subs/a.vtt',
        start: 10,
        duration: 2,
        range: '0-99',
      },
      { url: 'http://host/path/subs/b.vtt', start: 12, duration: 2 },
    ]);
  });

  it('expands fixed-duration templates around the current playback time', () => {
    const r = parseMpd(mpd(`<Period duration="PT1000S">
      <AdaptationSet contentType="text" mimeType="text/vtt" lang="l1">
        <SegmentTemplate media="sub-$Number$.vtt" timescale="1"
          duration="2" startNumber="1"/>
        <Representation id="s1"/>
      </AdaptationSet></Period>`), 'http://host/stream.mpd', 505);
    const segments = r.subtitles[0].dash?.segments || [];
    expect(segments[0]).toEqual({
      url: 'http://host/sub-251.vtt',
      start: 500,
      duration: 2,
    });
    expect(segments).toHaveLength(200);
  });

  it('reads forced and default subtitle roles', () => {
    const r = parseMpd(mpd(`<Period>
      <AdaptationSet contentType="text" mimeType="text/vtt" lang="l1">
        <Role schemeIdUri="${ROLE}" value="forced-subtitle"/>
        <Representation id="s1"/>
      </AdaptationSet>
      <AdaptationSet contentType="text" mimeType="text/vtt" lang="l2">
        <Role schemeIdUri="${ROLE}" value="main"/>
        <Representation id="s2"/>
      </AdaptationSet></Period>`));
    expect(r.subtitles.map(s => [s.isForced, s.isDefault]))
      .toEqual([[true, false], [false, true]]);
  });

  it('reads CEA-608 and CEA-708 accessibility descriptors as closed captions', () => {
    const r = parseMpd(mpd(`<Period>
      <AdaptationSet contentType="video" mimeType="video/mp4">
        <Accessibility schemeIdUri="${CEA608}" value="CC1=l1;CC3=l2"/>
        <Representation id="v1" width="1920" height="1080" codecs="avc1.640028"/>
      </AdaptationSet>
      <AdaptationSet contentType="video" mimeType="video/mp4">
        <Accessibility schemeIdUri="${CEA708}" value="1=lang:l3"/>
        <Representation id="v2" width="1280" height="720" codecs="avc1.4d401f"/>
      </AdaptationSet></Period>`));
    expect(r.closedCaptions.map(c => `${c.instreamId}|${c.lang}`))
      .toEqual(['CC1|l1', 'CC3|l2', 'SERVICE1|l3']);
  });

  it('builds one variant per video Representation with a converted frame rate', () => {
    const r = parseMpd(mpd(`<Period>${VIDEO_SET}
      <AdaptationSet contentType="audio" lang="l1">
        <Representation id="a1" codecs="mp4a.40.2"/>
      </AdaptationSet></Period>`));
    expect(r.variants).toEqual([
      { width: 1920, height: 1080, videoCodec: 'avc1.640028', audioCodec: 'mp4a.40.2',
        atmos: false, videoRange: '', frameRate: 30000 / 1001 },
      { width: 1280, height: 720, videoCodec: 'avc1.4d401f', audioCodec: 'mp4a.40.2',
        atmos: false, videoRange: '', frameRate: 25 },
    ]);
  });

  it('inherits Representation attributes declared on the AdaptationSet', () => {
    const r = parseMpd(mpd(`<Period>
      <AdaptationSet contentType="video" mimeType="video/mp4"
                     width="3840" height="2160" codecs="hvc1.2.4.L153.B0" frameRate="50">
        <Representation id="v1"/>
      </AdaptationSet></Period>`));
    expect(r.variants).toEqual([
      { width: 3840, height: 2160, videoCodec: 'hvc1.2.4.L153.B0', audioCodec: '',
        atmos: false, videoRange: '', frameRate: 50 },
    ]);
  });

  it('reads HDR from a CICP transfer-characteristics descriptor', () => {
    const pq = parseMpd(mpd(`<Period>
      <AdaptationSet contentType="video" mimeType="video/mp4">
        <EssentialProperty schemeIdUri="${CICP}" value="16"/>
        <Representation id="v1" width="3840" height="2160" codecs="hvc1.2.4.L153.B0"/>
      </AdaptationSet></Period>`));
    expect(pq.variants[0].videoRange).toBe('PQ');

    const hlg = parseMpd(mpd(`<Period>
      <AdaptationSet contentType="video" mimeType="video/mp4">
        <SupplementalProperty schemeIdUri="${CICP}" value="18"/>
        <Representation id="v1" width="3840" height="2160" codecs="hvc1.2.4.L153.B0"/>
      </AdaptationSet></Period>`));
    expect(hlg.variants[0].videoRange).toBe('HLG');
  });

  it('infers PQ from a Dolby Vision codec when no CICP descriptor is present', () => {
    const r = parseMpd(mpd(`<Period>
      <AdaptationSet contentType="video" mimeType="video/mp4">
        <Representation id="v1" width="3840" height="2160" codecs="dvh1.05.06"/>
      </AdaptationSet></Period>`));
    expect(r.variants[0].videoRange).toBe('PQ');
  });

  it('flags Atmos from a Dolby JOC supplemental property on the audio set', () => {
    const r = parseMpd(mpd(`<Period>${VIDEO_SET}
      <AdaptationSet contentType="audio" lang="l1">
        <SupplementalProperty schemeIdUri="${DOLBY_JOC}" value="JOC"/>
        <Representation id="a1" codecs="ec-3"/>
      </AdaptationSet></Period>`));
    expect(r.variants.every(v => v.atmos)).toBe(true);
    expect(r.variants[0].audioCodec).toBe('ec-3');
  });

  it('reads only the first period of a multi-period manifest', () => {
    const r = parseMpd(mpd(`
      <Period id="p0">
        <AdaptationSet contentType="audio" lang="l1"><Representation id="a1" codecs="mp4a.40.2"/></AdaptationSet>
      </Period>
      <Period id="p1">
        <AdaptationSet contentType="audio" lang="l2"><Representation id="a2" codecs="mp4a.40.2"/></AdaptationSet>
      </Period>`));
    expect(r.audio.map(a => a.lang)).toEqual(['l1']);
  });

  it('handles a namespace-prefixed manifest', () => {
    const r = parseMpd(`<?xml version="1.0"?>
<d:MPD xmlns:d="urn:mpeg:dash:schema:mpd:2011" type="dynamic">
  <d:Period>
    <d:AdaptationSet contentType="audio" lang="l1" label="Track 1">
      <d:Representation id="a1" codecs="mp4a.40.2"/>
    </d:AdaptationSet>
  </d:Period>
</d:MPD>`);
    expect(r.isLive).toBe(true);
    expect(r.audio).toEqual([{ name: 'Track 1', lang: 'l1', isDefault: false }]);
  });

  it('returns an empty result for malformed, truncated and non-MPD XML', () => {
    const empty = { audio: [], subtitles: [], closedCaptions: [], variants: [],
      isLive: false, hasContentProtection: false };
    expect(parseMpd('<MPD><Period><AdaptationSet')).toEqual(empty);
    expect(parseMpd('')).toEqual(empty);
    expect(parseMpd('<html><body>error</body></html>')).toEqual(empty);
    expect(parseMpd('#EXTM3U\n#EXT-X-VERSION:3')).toEqual(empty);
  });
});
