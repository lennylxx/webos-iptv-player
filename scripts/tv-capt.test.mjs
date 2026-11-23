import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildFfmpegArgs,
  parseCaptureArgs,
  temporaryRootForNodeMajor,
} from './tv-capt.mjs';

const now = new Date(2026, 8, 10, 12, 34, 56);

describe('TV capture arguments', () => {
  it('parses screenshot defaults and a generated filename', () => {
    expect(parseCaptureArgs(['screenshot'], { now })).toMatchObject({
      help: false,
      mode: 'screenshot',
      method: 'BLENDED',
      width: 1920,
      height: 1080,
      output: expect.stringMatching(/tv-screenshot-20260910-123456\.png$/),
    });
  });

  it('parses screenshot method, dimensions, and JPEG output', () => {
    expect(parseCaptureArgs([
      'screenshot',
      'screen.jpg',
      '--method', 'display',
      '--width', '1280',
      '--height', '720',
    ])).toMatchObject({
      mode: 'screenshot',
      method: 'DISPLAY',
      width: 1280,
      height: 720,
      output: expect.stringMatching(/screen\.jpg$/),
    });
  });

  it('parses recording duration, fps, and video-only capture', () => {
    expect(parseCaptureArgs([
      'record',
      'screen.mp4',
      '--duration', '2.5',
      '--fps', '8',
      '--quality', '75',
      '--method', 'video-only',
    ])).toMatchObject({
      mode: 'record',
      duration: 2.5,
      fps: 8,
      quality: 75,
      method: 'VIDEO_ONLY',
      output: expect.stringMatching(/screen\.mp4$/),
    });
  });

  it('rejects invalid modes, values, extensions, and mode-only options', () => {
    expect(() => parseCaptureArgs(['shot'])).toThrow(/mode/i);
    expect(() => parseCaptureArgs(['record', '--fps', '11'])).toThrow(/fps/i);
    expect(() => parseCaptureArgs(['record', '--duration', '301'])).toThrow(/duration/i);
    expect(() => parseCaptureArgs(['record', '--quality', '101'])).toThrow(/quality/i);
    expect(() => parseCaptureArgs(['screenshot', '--fps', '5'])).toThrow(/only valid/i);
    expect(() => parseCaptureArgs(['screenshot', 'screen.mp4'])).toThrow(/screenshot output/i);
    expect(() => parseCaptureArgs(['record', 'screen.webm'])).toThrow(/recording output/i);
    expect(() => parseCaptureArgs(['record', '--unknown'])).toThrow(/unknown option/i);
  });
});

describe('TV recording encoder', () => {
  it('builds an H.264 MP4 command with even-dimension padding', () => {
    const args = buildFfmpegArgs({
      fps: 5,
      framesDirectory: '/tmp/frames',
      output: '/tmp/out.mp4',
    });
    expect(args).toContain('libx264');
    expect(args).toContain('yuv420p');
    expect(args).toContain('pad=ceil(iw/2)*2:ceil(ih/2)*2');
    expect(args).toContain(join('/tmp/frames', 'frame-%06d.jpg'));
    expect(args.at(-1)).toBe('/tmp/out.mp4');
  });
});

describe('TV temporary directory', () => {
  it('uses the developer path for webOS 26 runtimes', () => {
    expect(temporaryRootForNodeMajor(12)).toBe('/tmp');
    expect(temporaryRootForNodeMajor(16)).toBe('/tmp');
    expect(temporaryRootForNodeMajor(20)).toBe('/media/developer/temp');
  });
});

const hasExpect = spawnSync('which', ['expect']).status === 0;
const tvSh = join(import.meta.dirname, 'tv.sh');
const dirs = [];

// Fake ssh prompts until a control connection exists, like real ssh:
// a key passphrase when -i is given, otherwise a login password.
function fakeBin({ auth, secret, refused = false, rejectPty = false }) {
  const dir = mkdtempSync(join(tmpdir(), 'tv-sh-test-'));
  dirs.push(dir);
  const details = auth === 'key'
    ? { privatekey: join(dir, 'key'), passphrase: secret }
    : { password: secret };
  const device = [{
    name: 'fake',
    default: true,
    deviceinfo: { ip: '127.0.0.1', port: '9922', user: 'prisoner' },
    details,
  }];
  writeFileSync(join(dir, 'ares-setup-device'),
    `#!/bin/sh\necho '${JSON.stringify(device)}'\n`);
  writeFileSync(join(dir, 'ssh'), `#!/bin/sh
${refused ? 'echo "ssh: connect to host 127.0.0.1 port 9922: Connection refused" >&2; exit 255' : ''}
master="${dir}/master"
if [ ! -f "$master" ]; then
  case " $* " in
    *" -i "*) printf "Enter passphrase for key '${dir}/key': " ;;
    *) printf "prisoner@127.0.0.1's password: " ;;
  esac
  read -r answer
  [ "$answer" = correct ] || exit 255
  touch "$master"
fi
for last; do :; done
[ "$last" = true ] && exit 0
${rejectPty ? `
case " $* " in
  *" -T "*)
    printf '$ '
    IFS= read -r line
    [ "$line" = 'exit 7' ] || exit 99
    exit 7
    ;;
  *) printf 'PTY allocation request failed\\n'; exit 255 ;;
esac` : ''}
touch "${dir}/ran"
echo '@node-major|16'
`);
  chmodSync(join(dir, 'ares-setup-device'), 0o755);
  chmodSync(join(dir, 'ssh'), 0o755);
  return dir;
}

function run(dir) {
  return spawnSync(tvSh, ['run', 'node -v'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TV_DEVICE: '' },
  });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!hasExpect)('tv.sh run', () => {
  it.each(['key', 'password'])('keeps the %s prompt out of command stdout', (auth) => {
    const result = run(fakeBin({ auth, secret: 'correct' }));
    expect(result.status).toBe(0);
    expect(result.stdout.replace(/\r/g, '')).toBe('@node-major|16\n');
  });

  it('forwards shell input and exit status after a PTY refusal', () => {
    const dir = fakeBin({ auth: 'key', secret: 'correct', rejectPty: true });
    const result = spawnSync('expect', [], {
      input: `
        set timeout 5
        spawn -noecho $env(TV_TEST_SCRIPT) shell
        expect {
          -re {\\$ $} { send -- "exit 7\\r" }
          timeout { exit 98 }
          eof { exit [lindex [wait] 3] }
        }
        expect eof
        exit [lindex [wait] 3]
      `,
      encoding: 'utf8',
      timeout: 10000,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, TV_DEVICE: '', TV_TEST_SCRIPT: tvSh },
    });
    expect(result.stdout + result.stderr).toContain('remote PTY unavailable');
    expect(result.status).toBe(7);
  });

  it('stops before running the command when authentication fails', () => {
    const dir = fakeBin({ auth: 'key', secret: 'wrong' });
    const result = run(dir);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe('');
    expect(existsSync(join(dir, 'ran'))).toBe(false);
    expect(result.stderr).toContain('tv.sh: ssh authentication failed');
  });

  it('reports a refused SSH port as Developer Mode being off', () => {
    const dir = fakeBin({ auth: 'key', secret: 'correct', refused: true });
    const result = run(dir);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('refused SSH on port 9922; Developer Mode may be off');
    expect(result.stderr).not.toContain('authentication failed');
    expect(existsSync(join(dir, 'ran'))).toBe(false);
  });
});
