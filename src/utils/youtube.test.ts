import { describe, expect, it } from 'vitest';
import { firstYoutubeVideoId, youtubeVideoId } from './youtube';

describe('youtubeVideoId', () => {
  it.each([
    ['abcDEF12_-z', 'abcDEF12_-z'],
    ['  abcDEF12_-z ', 'abcDEF12_-z'],
    ['v=abcDEF12_-z', 'abcDEF12_-z'],
    ['https://www.youtube.com/watch?v=abcDEF12_-z', 'abcDEF12_-z'],
    ['https://www.youtube.com/watch?feature=share&v=abcDEF12_-z&t=5', 'abcDEF12_-z'],
    ['https://youtu.be/abcDEF12_-z?si=x', 'abcDEF12_-z'],
    ['https://www.youtube.com/embed/abcDEF12_-z', 'abcDEF12_-z'],
    ['https://www.youtube-nocookie.com/embed/abcDEF12_-z', 'abcDEF12_-z'],
    ['https://m.youtube.com/shorts/abcDEF12_-z', 'abcDEF12_-z'],
    ['https://www.youtube.com/tv?v=abcDEF12_-z', 'abcDEF12_-z'],
  ])('reads %s', (value, id) => {
    expect(youtubeVideoId(value)).toBe(id);
  });

  it.each([
    '', 'abc', 'abcDEF12_-z1', 'abc def 12x', 'http://host/a?v=abcDEF12_-z',
    'https://www.youtube.com/watch?v=abcDEF12_-z1', 'https://www.youtube.com/', 42, null, undefined,
  ])('rejects %s', (value) => {
    expect(youtubeVideoId(value)).toBe('');
  });

  it('takes the first field that holds a video', () => {
    expect(firstYoutubeVideoId('', 'n/a', 'https://youtu.be/abcDEF12_-z', 'zyxWVU98_-a')).toBe('abcDEF12_-z');
    expect(firstYoutubeVideoId(undefined, null)).toBe('');
  });
});
