#!/usr/bin/env node
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const TV_SCRIPT = join(SCRIPT_DIR, 'tv.sh');
const REMOTE_HELPER = join(SCRIPT_DIR, 'tv-capt-remote.js');
const REMOTE_NAME_PREFIX = 'webos-iptv-capt-';
const REMOTE_NODE_PATH = '/usr/lib/node_modules:/usr/lib/nodejs';
const METHODS = new Map([
  ['blended', 'BLENDED'],
  ['display', 'DISPLAY'],
  ['video-only', 'VIDEO_ONLY'],
]);

const usage = `Capture the LG webOS TV display through its system capture service.

Usage:
  scripts/tv.sh capt screenshot [output.png] [options]
  scripts/tv.sh capt record [output.mp4] [options]

Options:
  --method <name>    blended (default), display, or video-only
  --width <pixels>   output width (default: 1920)
  --height <pixels>  output height (default: 1080)
  --duration <sec>   recording duration (default: 10, maximum: 300)
  --fps <number>     target recording frame rate (default: 5, maximum: 10)
  --quality <1-100>  recording JPEG quality (default: 85)
  -h, --help         show this help

Recording streams each frame to this computer immediately, requires ffmpeg,
and captures video without audio.
Protected DRM video is intentionally denied or blacked out by webOS.
`;

const numberOption = (value, name, { integer = false, maximum = Infinity } = {}) => {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || number > maximum
      || (integer && !Number.isInteger(number))) {
    throw new Error(`${name} must be a positive${integer ? ' integer' : ''}`
      + (maximum < Infinity ? ` no greater than ${maximum}` : ''));
  }
  return number;
};

const requiredValue = (args, index, option) => {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value`);
  return value;
};

const timestamp = (now = new Date()) => {
  const part = (value) => String(value).padStart(2, '0');
  return [
    now.getFullYear(),
    part(now.getMonth() + 1),
    part(now.getDate()),
    '-',
    part(now.getHours()),
    part(now.getMinutes()),
    part(now.getSeconds()),
  ].join('');
};

export function parseCaptureArgs(args, { now = new Date() } = {}) {
  if (!args.length || args.includes('-h') || args.includes('--help')) {
    return { help: true };
  }
  const mode = args[0];
  if (mode !== 'screenshot' && mode !== 'record') {
    throw new Error('capture mode must be screenshot or record');
  }

  const options = {
    help: false,
    mode,
    method: 'BLENDED',
    width: 1920,
    height: 1080,
    duration: 10,
    fps: 5,
    quality: 85,
    output: '',
  };
  let positional = '';

  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('-')) {
      if (positional) throw new Error(`unexpected argument: ${arg}`);
      positional = arg;
      continue;
    }
    if (arg === '--method') {
      const value = requiredValue(args, index, arg);
      const method = METHODS.get(value.toLowerCase());
      if (!method) throw new Error('--method must be blended, display, or video-only');
      options.method = method;
      index += 1;
    } else if (arg === '--width' || arg === '--height') {
      options[arg.slice(2)] = numberOption(
        requiredValue(args, index, arg),
        arg,
        { integer: true, maximum: 7680 },
      );
      index += 1;
    } else if (arg === '--duration') {
      options.duration = numberOption(
        requiredValue(args, index, arg),
        arg,
        { maximum: 300 },
      );
      index += 1;
    } else if (arg === '--fps') {
      options.fps = numberOption(
        requiredValue(args, index, arg),
        arg,
        { integer: true, maximum: 10 },
      );
      index += 1;
    } else if (arg === '--quality') {
      options.quality = numberOption(
        requiredValue(args, index, arg),
        arg,
        { integer: true, maximum: 100 },
      );
      index += 1;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }

  if (mode === 'screenshot'
      && (args.includes('--duration') || args.includes('--fps') || args.includes('--quality'))) {
    throw new Error('--duration, --fps, and --quality are only valid for record');
  }
  const defaultName = mode === 'screenshot'
    ? `tv-screenshot-${timestamp(now)}.png`
    : `tv-recording-${timestamp(now)}.mp4`;
  options.output = resolve(positional || defaultName);
  const extension = extname(options.output).toLowerCase();
  if (mode === 'screenshot' && !['.png', '.jpg', '.jpeg'].includes(extension)) {
    throw new Error('screenshot output must end in .png, .jpg, or .jpeg');
  }
  if (mode === 'record' && extension !== '.mp4') {
    throw new Error('recording output must end in .mp4');
  }
  return options;
}

export function buildFfmpegArgs({ fps, framesDirectory, output }) {
  return [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-framerate', String(fps),
    '-i', join(framesDirectory, 'frame-%06d.jpg'),
    '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    output,
  ];
}

const shellQuote = (value) => `'${String(value).replace(/'/g, `'\"'\"'`)}'`;

const runTv = (args, { capture = false, timeoutSeconds = null } = {}) => {
  const result = spawnSync(TV_SCRIPT, args, {
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    env: timeoutSeconds === null
      ? process.env
      : { ...process.env, TV_TIMEOUT: String(Math.ceil(timeoutSeconds)) },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`tv.sh ${args[0]} failed with exit code ${result.status}`);
  }
  return capture ? result.stdout.trim() : '';
};

const parseRemoteResult = (output) => {
  const line = output.split(/\r?\n/).reverse().find((entry) => entry.trim().startsWith('{'));
  if (!line) throw new Error('TV capture returned no result');
  return JSON.parse(line);
};

const checkFfmpeg = () => {
  const result = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  if (result.error || result.status !== 0) {
    throw new Error('recording requires ffmpeg in PATH');
  }
};

export const temporaryRootForNodeMajor = (major) =>
  major >= 20 ? '/media/developer/temp' : '/tmp';

const remoteTemporaryRoot = () => {
  const output = runTv([
    'run',
    `NODE_PATH=${REMOTE_NODE_PATH} node -e ${shellQuote(
      'process.stdout.write("@node-major|"+process.versions.node.split(".")[0])',
    )}`,
  ], { capture: true });
  const line = output.split(/\r?\n/).reverse()
    .find((entry) => entry.startsWith('@node-major|'));
  const major = Number(line?.slice(12));
  if (!Number.isInteger(major) || major <= 0) {
    throw new Error(`unexpected TV Node.js version: ${output}`);
  }
  return temporaryRootForNodeMajor(major);
};

const frameName = (index) => `frame-${String(index).padStart(6, '0')}.jpg`;

const streamRecording = ({ command, framesDirectory, timeoutSeconds }) =>
  new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(TV_SCRIPT, ['run', command], {
      env: { ...process.env, TV_TIMEOUT: String(Math.ceil(timeoutSeconds)) },
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let buffer = '';
    let frameCount = 0;
    let timing = null;
    let failed = false;

    const reject = (error) => {
      if (failed) return;
      failed = true;
      rejectPromise(error);
    };

    const processLine = (line) => {
      if (line.startsWith('@frame|')) {
        const first = line.indexOf('|', 7);
        const second = first < 0 ? -1 : line.indexOf('|', first + 1);
        if (first < 0 || second < 0) throw new Error('invalid streamed frame');
        const index = Number(line.slice(7, first));
        if (!Number.isInteger(index) || index !== frameCount + 1) {
          throw new Error('streamed frames arrived out of order');
        }
        const data = Buffer.from(line.slice(second + 1), 'base64');
        if (!data.length) throw new Error(`streamed frame ${index} was empty`);
        writeFileSync(join(framesDirectory, frameName(index)), data);
        frameCount = index;
      } else if (line.startsWith('@done|')) {
        timing = JSON.parse(line.slice(6));
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (failed) return;
      buffer += chunk;
      let newline;
      try {
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, '');
          buffer = buffer.slice(newline + 1);
          processLine(line);
        }
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        child.kill('SIGTERM');
      }
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (failed) return;
      try {
        if (buffer) processLine(buffer.replace(/\r$/, ''));
        if (code !== 0) throw new Error(`TV recording failed with exit code ${code}`);
        if (!timing) throw new Error('TV recording returned no completion record');
        if (frameCount !== timing.frameCount) {
          throw new Error(`received ${frameCount} of ${timing.frameCount} frames`);
        }
        resolvePromise(timing);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });

const cleanupRemote = (paths) => {
  const directoryCommand = paths.directory && paths.helper
    ? [
      `NODE_PATH=${REMOTE_NODE_PATH}`,
      'node',
      shellQuote(paths.helper),
      'cleanup',
      shellQuote(paths.directory),
      '2>/dev/null || true',
    ].join(' ')
    : '';
  const files = paths.files.map(shellQuote).join(' ');
  const command = [
    directoryCommand,
    files ? `rm -f ${files}` : '',
  ].filter(Boolean).join('; ');
  if (!command) return;
  try {
    runTv(['run', command]);
  } catch {
    console.error('tv-capt: warning: could not remove TV temporary files');
  }
};

export async function runCapture(options) {
  mkdirSync(dirname(options.output), { recursive: true });
  const id = `${process.pid}-${Date.now()}`;
  const remotePrefix = `${remoteTemporaryRoot()}/${REMOTE_NAME_PREFIX}`;
  const remoteDirectory = `${remotePrefix}${id}`;
  const remoteHelper = `${remotePrefix}${id}.js`;
  const remoteFiles = [remoteHelper];
  let localTemporary = null;

  try {
    runTv(['push', REMOTE_HELPER, remoteHelper]);
    runTv(['run', `mkdir ${shellQuote(remoteDirectory)}`]);

    if (options.mode === 'screenshot') {
      const extension = extname(options.output).toLowerCase();
      const format = extension === '.png' ? 'PNG' : 'JPEG';
      const remoteOutput = `${remoteDirectory}/capture${extension === '.jpeg' ? '.jpg' : extension}`;
      remoteFiles.push(remoteOutput);
      const result = parseRemoteResult(runTv([
        'run',
        [
          `NODE_PATH=${REMOTE_NODE_PATH}`,
          'node',
          shellQuote(remoteHelper),
          'screenshot',
          shellQuote(remoteOutput),
          shellQuote(options.method),
          String(options.width),
          String(options.height),
          format,
        ].join(' '),
      ], { capture: true }));
      runTv(['pull', remoteOutput, options.output]);
      console.log(`Screenshot written to ${options.output}`
        + ` (${result.capturedWidth}x${result.capturedHeight})`);
      return;
    }

    checkFfmpeg();
    localTemporary = mkdtempSync(join(tmpdir(), 'webos-tv-capt-'));
    const framesDirectory = join(localTemporary, 'frames');
    mkdirSync(framesDirectory);
    const timing = await streamRecording({
      command: [
        `NODE_PATH=${REMOTE_NODE_PATH}`,
        'node',
        shellQuote(remoteHelper),
        'record',
        shellQuote(remoteDirectory),
        shellQuote(options.method),
        String(options.width),
        String(options.height),
        String(options.fps),
        String(Math.round(options.duration * 1000)),
        String(options.quality),
      ].join(' '),
      framesDirectory,
      timeoutSeconds: options.duration + 60,
    });
    const actualFps = timing.frameCount * 1000 / timing.elapsedMs;
    const encode = spawnSync('ffmpeg', buildFfmpegArgs({
      fps: actualFps,
      framesDirectory,
      output: options.output,
    }), { stdio: 'inherit' });
    if (encode.error) throw encode.error;
    if (encode.status !== 0) throw new Error('ffmpeg could not encode the recording');
    const elapsed = (timing.elapsedMs / 1000).toFixed(1);
    const achievedFps = actualFps.toFixed(1);
    console.log(`Recording written to ${options.output}`
      + ` (${timing.frameCount} frames over ${elapsed}s,`
      + ` ${achievedFps} fps achieved, no audio)`);
    if (timing.profile && timing.frameCount > 0) {
      const average = (value) => (value / timing.frameCount).toFixed(1);
      console.log('Capture profile:'
        + ` capture ${average(timing.profile.captureMs)}ms/frame,`
        + ` read ${average(timing.profile.readMs)}ms/frame,`
        + ` Base64 ${average(timing.profile.base64Ms)}ms/frame,`
        + ` output wait ${average(timing.profile.drainMs)}ms/frame`);
    }
    if (actualFps < options.fps * 0.9 && (options.width > 1280 || options.height > 720)) {
      console.log('Tip: use --width 1280 --height 720 for a higher frame rate;'
        + ' the TV capture service is resolution-bound.');
    }
  } finally {
    cleanupRemote({
      files: remoteFiles,
      directory: remoteDirectory,
      helper: remoteHelper,
    });
    if (localTemporary) rmSync(localTemporary, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const options = parseCaptureArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(usage);
    } else {
      await runCapture(options);
    }
  } catch (error) {
    console.error(`tv-capt: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
