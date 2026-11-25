import { describe, it, expect } from 'vitest';
import { srtToVtt, parseSubtitleFile } from './srt';
import { parseWebVTT } from './webvtt';

describe('srtToVtt', () => {
  it('prepends a WEBVTT header and converts comma decimals so parseWebVTT reads the cues', () => {
    const srt = [
      '1',
      '00:00:01,000 --> 00:00:04,000',
      'Line one',
      '',
      '2',
      '00:00:05,500 --> 00:00:07,250',
      'Line two',
      '',
    ].join('\n');
    const vtt = srtToVtt(srt);
    expect(vtt.startsWith('WEBVTT')).toBe(true);
    const { cues } = parseWebVTT(vtt);
    expect(cues).toEqual([
      { start: 1, end: 4, text: 'Line one' },
      { start: 5.5, end: 7.25, text: 'Line two' },
    ]);
  });

  it('leaves commas in the cue text untouched', () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,000\nHello, world\n';
    const { cues } = parseWebVTT(srtToVtt(srt));
    expect(cues[0].text).toBe('Hello, world');
  });

  it('strips a leading BOM so the WEBVTT header is recognized', () => {
    const srt = '\uFEFF1\n00:00:01,000 --> 00:00:02,000\nHi\n';
    const vtt = srtToVtt(srt);
    expect(vtt.startsWith('WEBVTT')).toBe(true);
    expect(parseWebVTT(vtt).cues).toHaveLength(1);
  });

  it('handles CRLF line endings', () => {
    const srt = '1\r\n00:00:01,000 --> 00:00:02,000\r\nHi\r\n';
    expect(parseWebVTT(srtToVtt(srt)).cues).toHaveLength(1);
  });
});

describe('parseSubtitleFile', () => {
  it('parses a WebVTT sidecar directly', () => {
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n';
    expect(parseSubtitleFile(vtt)).toEqual([{ start: 1, end: 2, text: 'Hi' }]);
  });

  it('detects a WebVTT header even behind a BOM', () => {
    const vtt = '\uFEFFWEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi\n';
    expect(parseSubtitleFile(vtt)).toEqual([{ start: 1, end: 2, text: 'Hi' }]);
  });

  it('converts an SRT sidecar (comma decimals, no header) before parsing', () => {
    const srt = '1\n00:00:01,000 --> 00:00:02,500\nHi\n';
    expect(parseSubtitleFile(srt)).toEqual([{ start: 1, end: 2.5, text: 'Hi' }]);
  });
});

describe('SRT position tags', () => {
  const srt = (...texts: string[]): string => texts
    .map((text, k) => `${k + 1}\n00:00:0${k},000 --> 00:00:0${k},500\n${text}\n`).join('\n');

  it('moves {\\anN} into the cue positioning and out of the text', () => {
    const cues = parseSubtitleFile(srt('{\\an8}Top', '{\\an5}Middle', '{\\an1}Bottom left', '{\\an9}Top right', 'Plain {\\an7}late'));
    expect(cues.map(cue => [cue.text, cue.settings])).toEqual([
      ['Top', { line: 0, snapToLines: true }],
      ['Middle', { line: 50, snapToLines: false, lineAlign: 'center' }],
      ['Bottom left', { align: 'left' }],
      ['Top right', { line: 0, snapToLines: true, align: 'right' }],
      ['Plain late', { line: 0, snapToLines: true, align: 'left' }],
    ]);
  });

  it('keeps {\\an2}, the default, out of the text with no positioning, and drops a tag on its own line', () => {
    const cues = parseSubtitleFile(srt('{\\an2}Bottom', '{\\an8}\nTop'));
    expect(cues.map(cue => [cue.text, cue.settings])).toEqual([['Bottom', undefined], ['Top', { line: 0, snapToLines: true }]]);
  });

  it('leaves a WebVTT file as it is', () => {
    expect(parseSubtitleFile('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n{\\an8}Top\n')[0].text).toBe('{\\an8}Top');
  });
});
