import { createHash } from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const RELEASES = {
  'v0.12.2': {
    'darwin-x64': '7d382f8988ea441e2918d9d935003177affd13d4d160020df6b3d8ee7d65ec2d',
    'linux-x64': '4e1578efc2a2cc67651413a05ccc4c5d43f6b4329c599901c556f24d93cd0508',
  },
  'v8.12.0': {
    'darwin-x64': 'ca131b84dfcf2b6f653a6521d31f7a108ad7d83f4d7e781945b2eca8172064aa',
    'linux-x64': '3df19b748ee2b6dfe3a03448ebc6186a3a86aeab557018d77a0f7f3314594ef6',
  },
  'v12.21.0': {
    'darwin-x64': '4d0b5d07d41a16909fdeb41c3158c27bcdccf16231cccf76d5eb6835e2076e90',
    'linux-x64': 'ab121de3c472d76ec425480b0594e43109ee607bd57c3d5314bdb65fa816bf1c',
  },
  'v16.19.1': {
    'darwin-arm64': '168f787f457bf645f3fc41e7419b62071db7d42519ce461b1d7ebfc0acbdbfb1',
    'linux-x64': 'ca63da538e02de15b7e974f7a17ce4732cc0d63023942301d30044c472ed9ddd',
  },
  'v20.12.2': {
    'darwin-arm64': '98eb624b52efec2530079e1d11296ec0ac20771b94b087d21649250339cf5332',
    'linux-x64': 'f8f9b6877778ed2d5f920a5bd853f0f8a8be1c42f6d448c763a95625cbbb4b0d',
  },
};

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const versions = process.argv.includes('--matrix')
  ? Object.keys(RELEASES)
  : ['v0.12.2'];

function releaseKeyFor(version) {
  const nativeKey = `${process.platform}-${process.arch}`;
  if (RELEASES[version][nativeKey]) return nativeKey;
  if (process.platform === 'darwin' && process.arch === 'arm64') return 'darwin-x64';
  return nativeKey;
}

const supportedHost =
  (process.platform === 'darwin' && process.arch === 'arm64') ||
  (process.platform === 'linux' && process.arch === 'x64');
if (!supportedHost) {
  throw new Error(
    `Service runtime smoke is unavailable for ${process.platform}/${process.arch}. ` +
    'Supported hosts are Apple Silicon macOS and Linux x64.',
  );
}

const cacheRoot = path.join(
  os.homedir(),
  '.cache',
  'webos-iptv-player',
  'node-runtimes',
);

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function download(url, destination) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 &&
          response.headers.location) {
        response.resume();
        download(response.headers.location, destination).then(resolve, reject);
        return;
      }
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Download failed with HTTP ${response.statusCode}: ${url}`));
        return;
      }
      const output = fs.createWriteStream(destination);
      response.pipe(output);
      output.on('finish', () => output.close(resolve));
      output.on('error', reject);
    });
    request.on('error', reject);
  });
}

async function ensureRuntime(version) {
  const releaseKey = releaseKeyFor(version);
  const sha = RELEASES[version][releaseKey];
  const archive = `node-${version}-${releaseKey}.tar.gz`;
  const cacheDir = path.join(cacheRoot, `node-${version}-${releaseKey}`);
  const archivePath = path.join(cacheDir, archive);
  const runtimeDir = path.join(cacheDir, archive.replace(/\.tar\.gz$/, ''));
  const nodePath = path.join(runtimeDir, 'bin', 'node');
  const archiveValid = fs.existsSync(archivePath) && sha256(archivePath) === sha;
  const cachedVersion = archiveValid && fs.existsSync(nodePath)
    ? spawnSync(nodePath, ['--version'], { encoding: 'utf8' })
    : null;
  if (cachedVersion?.status === 0 && cachedVersion.stdout.trim() === version) {
    return nodePath;
  }

  fs.mkdirSync(cacheDir, { recursive: true });
  if (!archiveValid) {
    const temporaryArchive = archivePath + `.download-${process.pid}`;
    console.log(`Downloading official Node.js ${version} for ${releaseKey}...`);
    try {
      await download(
        `https://nodejs.org/dist/${version}/${archive}`,
        temporaryArchive,
      );
      const actualHash = sha256(temporaryArchive);
      if (actualHash !== sha) {
        throw new Error(
          `Node archive SHA-256 mismatch: expected ${sha}, got ${actualHash}`,
        );
      }
      fs.renameSync(temporaryArchive, archivePath);
    } finally {
      if (fs.existsSync(temporaryArchive)) fs.unlinkSync(temporaryArchive);
    }
  }

  const extracted = spawnSync('tar', ['-xzf', archivePath, '-C', cacheDir], {
    stdio: 'inherit',
  });
  if (extracted.status !== 0) throw new Error('Failed to extract Node.js runtime');
  return nodePath;
}

for (const version of versions) {
  const nodePath = await ensureRuntime(version);
  console.log(`Running service smoke with Node.js ${version} (${releaseKeyFor(version)})...`);
  const result = spawnSync(
    nodePath,
    [path.join(ROOT, 'scripts', 'service-runtime-smoke.js')],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        SERVICE_BUILD_DIR: path.join(ROOT, 'build', 'bundled-service'),
      },
      stdio: 'inherit',
    },
  );

  if (result.error) throw result.error;
  if (result.signal) throw new Error(`Node.js ${version} smoke ended with ${result.signal}`);
  if (result.status !== 0) process.exit(result.status ?? 1);
}
