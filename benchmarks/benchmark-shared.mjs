import { once } from 'node:events';
import { createSocket } from 'node:dgram';

// Node-side helpers shared by the benchmark suites. Browser functions are
// injected via `fn.toString()`, so they cannot use these.

// The address this computer uses to reach the device, so a TV can fetch from
// a local fixture server.
export async function resolveLocalAddress(deviceIp) {
  const socket = createSocket(deviceIp.includes(':') ? 'udp6' : 'udp4');
  try {
    socket.connect(9, deviceIp);
    await once(socket, 'connect');
    return socket.address().address;
  } finally {
    socket.close();
  }
}

export function formatUrlHost(host) {
  return host.includes(':') ? `[${host}]` : host;
}

// Resolves false when the client hung up before the chunk drained.
export async function writeBenchmarkResponse(response, chunk) {
  if (response.destroyed) return false;
  if (response.write(chunk)) return true;
  return new Promise((resolve) => {
    const done = () => {
      response.off('drain', drained);
      response.off('close', closed);
    };
    const drained = () => {
      done();
      resolve(true);
    };
    const closed = () => {
      done();
      resolve(false);
    };
    response.once('drain', drained);
    response.once('close', closed);
  });
}

export function bytesToMiB(bytes) {
  return roundHundredths(bytes / 1_048_576);
}

export function roundHundredths(value) {
  return Math.round(value * 100) / 100;
}

export function positiveIntegerEnv(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function nonNegativeIntegerEnv(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

// Returns { [key]: value } only when the variable is set, for spreading over
// a profile's defaults.
export function numberOverride(key, name) {
  const raw = process.env[name];
  if (raw === undefined) return {};
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return { [key]: value };
}

export function listEnv(name, fallback) {
  const value = process.env[name];
  return value ? value.split(',').map(item => item.trim()).filter(Boolean) : fallback;
}
