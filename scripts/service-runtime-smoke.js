'use strict';

var fs = require('fs');
var http = require('http');
var zlib = require('zlib');
var os = require('os');
var path = require('path');
var vm = require('vm');

var buildDir = process.env.SERVICE_BUILD_DIR;
if (!buildDir) throw new Error('SERVICE_BUILD_DIR is required');

var parsedFiles = 0;
function parseBuild(dir) {
  fs.readdirSync(dir).forEach(function (name) {
    var file = path.join(dir, name);
    if (fs.statSync(file).isDirectory()) {
      parseBuild(file);
    } else if (/\.js$/.test(name)) {
      new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file });
      parsedFiles++;
    }
  });
}
parseBuild(buildDir);

var startServer = require(path.join(buildDir, 'lan', 'server')).startServer;
var tempRoot = path.join(
  os.tmpdir(),
  'webos-iptv-service-smoke-' + process.pid + '-' + Date.now()
);
var dataDir = path.join(tempRoot, 'nested', 'uploads');
require(path.join(buildDir, 'compat')).mkdirRecursive(dataDir);

var server = null;
var timeout = setTimeout(function () {
  finish(new Error('Service runtime smoke timed out'));
}, 15000);

function request(port, method, route, body) {
  return new Promise(function (resolve, reject) {
    var headers = body
      ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      : {};
    var req = http.request({
      host: '127.0.0.1',
      port: port,
      method: method,
      path: route,
      headers: headers,
    }, function (res) {
      var chunks = [];
      res.on('data', function (chunk) { chunks.push(chunk); });
      res.on('end', function () {
        resolve({
          status: res.statusCode,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function expectStatus(response, status, route) {
  if (response.status !== status) {
    throw new Error(route + ' returned HTTP ' + response.status + ': ' + response.body);
  }
  return JSON.parse(response.body);
}

function cleanup() {
  ['alpha.m3u', 'alpha.json', 'service.log', 'service.log.1'].forEach(function (name) {
    var file = path.join(dataDir, name);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  });
  [dataDir, path.dirname(dataDir), tempRoot].forEach(function (dir) {
    if (fs.existsSync(dir)) fs.rmdirSync(dir);
  });
}

var finished = false;
function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(timeout);
  function exit() {
    try {
      cleanup();
    } catch (cleanupError) {
      if (!error) error = cleanupError;
    }
    if (error) {
      console.error(error.stack || error);
      process.exit(1);
    }
    console.log(
      process.version + ' service smoke passed (' + parsedFiles + ' compiled files)'
    );
  }
  if (server) {
    var activeServer = server;
    server = null;
    activeServer.close(exit);
  } else {
    exit();
  }
}

var state = {
  playlists: [{
    id: 'p1',
    name: 'Alpha',
    url: 'http://host/a',
  }],
  xtreamAccounts: [],
  uploadedPlaylists: [],
  manualEpgSources: [],
  onlineSubtitles: {
    preferredLanguage: '',
    subdlConfigured: false,
    assrtConfigured: false,
    opensubtitlesConfigured: false,
    opensubtitlesApiKeyConfigured: false,
    opensubtitlesPasswordConfigured: false,
    opensubtitlesUsername: '',
  },
};

startServer(0, dataDir).then(function (bound) {
  server = bound.server;
  return request(bound.port, 'GET', '/info').then(function (response) {
    var info = expectStatus(response, 200, '/info');
    return request(
      bound.port,
      'POST',
      '/pair',
      JSON.stringify({ code: info.pairingCode })
    ).then(function (pairResponse) {
      var token = expectStatus(pairResponse, 200, '/pair').token;
      return request(
        bound.port,
        'PUT',
        '/setup-state',
        JSON.stringify(state)
      ).then(function (stateResponse) {
        expectStatus(stateResponse, 200, 'PUT /setup-state');
        return request(
          bound.port,
          'GET',
          '/setup-state?token=' + encodeURIComponent(token)
        );
      }).then(function (stateResponse) {
        var savedState = expectStatus(stateResponse, 200, 'GET /setup-state');
        if (savedState.playlists.length !== 1 ||
            savedState.playlists[0].url !== 'http://host/a') {
          throw new Error('Setup state round-trip failed');
        }
        return request(
          bound.port,
          'POST',
          '/setup-actions?token=' + encodeURIComponent(token),
          JSON.stringify({
            type: 'manual-epg-sources',
            sources: [{ url: 'http://host/b', playlistIds: ['p1'] }],
          })
        );
      }).then(function (actionResponse) {
        var action = expectStatus(actionResponse, 201, 'POST /setup-actions');
        return request(bound.port, 'GET', '/setup-actions').then(function (listResponse) {
          var actions = expectStatus(listResponse, 200, 'GET /setup-actions');
          if (actions.length !== 1 || actions[0].id !== action.id) {
            throw new Error('Setup action queue failed');
          }
          return request(
            bound.port,
            'DELETE',
            '/setup-actions/' + action.id
          );
        });
      }).then(function (deleteResponse) {
        expectStatus(deleteResponse, 200, 'DELETE /setup-actions/:id');
        var playlist = '#EXTM3U\n#EXTINF:-1,Alpha\nhttp://host/a\n';
        return request(
          bound.port,
          'POST',
          '/uploads?name=Alpha.m3u&token=' + encodeURIComponent(token),
          playlist
        ).then(function (uploadResponse) {
          var upload = expectStatus(uploadResponse, 200, 'POST /uploads');
          if (upload.id !== 'alpha' || upload.count !== 1) {
            throw new Error('Upload metadata validation failed');
          }
          return request(bound.port, 'GET', '/uploads').then(function (listResponse) {
            var uploads = expectStatus(listResponse, 200, 'GET /uploads');
            if (uploads.length !== 1 || uploads[0].id !== 'alpha') {
              throw new Error('Upload listing failed');
            }
            return request(bound.port, 'GET', '/uploads/alpha.m3u');
          }).then(function (readResponse) {
            if (readResponse.status !== 200 || readResponse.body !== playlist) {
              throw new Error('Upload readback failed');
            }
          });
        });
      });
    });
  });
}).then(function () {
  return manifestFetchSmoke();
}).then(function () {
  return proxySmoke();
}).then(function () {
  serviceLogSmoke();
  finish();
}, finish);

// The log tee on the real runtime: file mode, line format, and rotation.
function serviceLogSmoke() {
  var installServiceLog = require(path.join(buildDir, 'service-log')).installServiceLog;
  var createLogger = require(path.join(buildDir, 'logger')).createLogger;
  var file = path.join(dataDir, 'service.log');
  var target = { log: function () {}, info: function () {}, warn: function () {}, error: function () {} };
  // A strict umask must not keep the developer shell out.
  var umask = process.umask(63);
  installServiceLog(file, target, fs, 120);
  var log = createLogger('smoke', target);
  log.info('one');
  process.umask(umask);
  target.log('[other] not from a logger');
  log.warn('two');
  var text = fs.readFileSync(file, 'utf8');
  if (!/^\d{4}-\d\d-\d\dT[^ ]+Z log \[smoke\] one\n[^ ]+ warn \[smoke\] two\n$/.test(text)) {
    throw new Error('service log lines: ' + JSON.stringify(text));
  }
  if ((fs.statSync(file).mode & 511) !== 420) throw new Error('service log is not 0644');
  log.error(new Array(80).join('x'));
  if (!fs.existsSync(file + '.1')) throw new Error('service log did not rotate');
}

// fetchManifest through its Luna registration: caller check, header
// forwarding, URL credentials, a redirect, and gzip decoding against a
// loopback origin.
function manifestFetchSmoke() {
  var registerManifestFetchService =
    require(path.join(buildDir, 'fetch', 'service')).registerManifestFetchService;
  var handler = null;
  registerManifestFetchService({
    register: function (name, h) { if (name === 'fetchManifest') handler = h; },
  }, 'com.example.app');
  if (!handler) throw new Error('fetchManifest was not registered');
  var playlist = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv1.m3u8\n';
  var origin = http.createServer(function (req, res) {
    if (req.url === '/a') {
      res.writeHead(302, { Location: '/b/master.m3u8' });
      res.end();
      return;
    }
    if (req.headers.referer !== 'http://host/r' || req.headers['user-agent'] !== 'Agent 1' ||
        req.headers.cookie !== 'c=1' || req.headers['x-split'] !== undefined ||
        req.headers.authorization !== 'Basic ' + new Buffer('u1:p1').toString('base64')) {
      res.writeHead(403);
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Encoding': 'gzip' });
    res.end(zlib.gzipSync(playlist));
  });
  function call(sender, payload) {
    return new Promise(function (resolve) {
      handler({ sender: sender, payload: payload, respond: resolve });
    });
  }
  return new Promise(function (resolve) {
    origin.listen(0, '127.0.0.1', resolve);
  }).then(function () {
    var base = 'http://127.0.0.1:' + origin.address().port;
    var payload = {
      url: base.replace('http://', 'http://u1:p1@') + '/a',
      headers: {
        Referer: 'http://host/r',
        'User-Agent': 'Agent 1',
        Cookie: 'c=1',
        'X-Split': 'a\r\nX-Injected: 1',
      },
      maxBytes: 1024,
      timeoutMs: 5000,
    };
    return call('com.example.other', payload).then(function (denied) {
      if (denied.returnValue !== false || denied.errorCode !== 'denied') {
        throw new Error('fetchManifest answered another caller');
      }
      return call('com.example.app 1234', payload);
    }).then(function (result) {
      if (result.returnValue !== true || result.text !== playlist ||
          result.url !== base + '/b/master.m3u8') {
        throw new Error('fetchManifest failed: ' + JSON.stringify(result));
      }
      return call('com.example.app', { url: 'file:///a' });
    }).then(function (rejected) {
      if (rejected.errorCode !== 'bad_url') throw new Error('fetchManifest accepted a file URL');
    });
  }).then(function () {
    origin.close();
  }, function (error) {
    origin.close();
    throw error;
  });
}

function proxyGet(url, headers) {
  return new Promise(function (resolve, reject) {
    var req = http.request(require('url').parse(url), function (res) {
      var chunks = [];
      res.on('data', function (chunk) { chunks.push(chunk); });
      res.on('end', function () {
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
      });
    });
    if (headers) {
      Object.keys(headers).forEach(function (name) { req.setHeader(name, headers[name]); });
    }
    req.on('error', reject);
    req.end();
  });
}

// The loopback proxy through openProxy: a rewritten gzip playlist, a
// segment Range, a cookie from the playlist, keep-alive reuse, a paused
// client, a loopback host name, and a client abort, against an origin that
// refuses a request without the channel's Referer.
function proxySmoke() {
  var registerProxyService = require(path.join(buildDir, 'proxy', 'service')).registerProxyService;
  var createStreamProxy = require(path.join(buildDir, 'proxy', 'server')).createStreamProxy;
  var handlers = {};
  // The origin below listens on loopback, which a real proxy refuses.
  var proxy = registerProxyService({
    register: function (name, h) { handlers[name] = h; },
  }, 'com.example.app', createStreamProxy({ allowLoopback: true, bodyIdleMs: 200 }));
  var strict = createStreamProxy();
  var segment = new Buffer(200000);
  segment.fill(7);
  var big = new Buffer(8 * 1024 * 1024);
  big.fill(3);
  var aborted = false;
  var origin = http.createServer(function (req, res) {
    if (req.headers.referer !== 'http://host/r') {
      res.writeHead(403);
      res.end();
      return;
    }
    if (req.url === '/live/index.m3u8') {
      res.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Content-Encoding': 'gzip',
        'Set-Cookie': 'sid=s1; Path=/live',
      });
      res.end(zlib.gzipSync('#EXTM3U\n#EXTINF:4,\nseg1.ts\n#EXTINF:4,\nslow.ts\n'));
    } else if (req.url === '/live/big.ts') {
      res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': big.length });
      res.end(big);
    } else if (req.url === '/live/seg1.ts') {
      if (req.headers.cookie !== 'sid=s1') {
        res.writeHead(401);
        res.end();
        return;
      }
      var range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
      if (!range) {
        res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': segment.length });
        res.end(segment);
        return;
      }
      res.writeHead(206, {
        'Content-Type': 'video/mp2t',
        'Content-Range': 'bytes ' + range[1] + '-' + range[2] + '/' + segment.length,
      });
      res.end(segment.slice(Number(range[1]), Number(range[2]) + 1));
    } else {
      res.writeHead(200, { 'Content-Type': 'video/mp2t' });
      res.write(segment);
      req.socket.on('close', function () { aborted = true; });
    }
  });
  function call(name, sender, payload) {
    return new Promise(function (resolve) {
      handlers[name]({ sender: sender, payload: payload, respond: resolve });
    });
  }
  var opened = null;
  return new Promise(function (resolve) {
    origin.listen(0, '127.0.0.1', resolve);
  }).then(function () {
    var payload = {
      url: 'http://127.0.0.1:' + origin.address().port + '/live/index.m3u8',
      headers: { Referer: 'http://host/r' },
    };
    return call('openProxy', 'com.example.other', payload).then(function (denied) {
      if (denied.errorCode !== 'denied') throw new Error('openProxy answered another caller');
      return call('openProxy', 'com.example.app 1234', payload);
    });
  }).then(function (result) {
    if (result.returnValue !== true || !/^http:\/\/127\.0\.0\.1:\d+\/p\/[0-9a-f]{32}\/http\//.test(result.url)) {
      throw new Error('openProxy failed: ' + JSON.stringify(result));
    }
    opened = result;
    return proxyGet(result.url);
  }).then(function (playlist) {
    var lines = playlist.body.toString('utf8').split('\n');
    var prefix = opened.url.slice(0, opened.url.lastIndexOf('/') + 1);
    if (playlist.status !== 200 || lines[2] !== prefix + 'seg1.ts' ||
        Number(playlist.headers['content-length']) !== playlist.body.length) {
      throw new Error('proxy playlist: ' + playlist.status + ' ' + JSON.stringify(lines));
    }
    return proxyGet(lines[2]).then(function (full) {
      if (full.status !== 200 || full.body.length !== segment.length) throw new Error('proxy segment failed');
      var chain = Promise.resolve();
      for (var i = 0; i < 20; i++) {
        chain = chain.then(function () { return proxyGet(lines[2]); }).then(function (again) {
          if (again.status !== 200) throw new Error('proxy keep-alive segment: ' + again.status);
        });
      }
      return chain;
    }).then(function () {
      return new Promise(function (resolve, reject) {
        http.get(require('url').parse(prefix + 'big.ts'), function (res) {
          var length = 0;
          res.pause();
          setTimeout(function () {
            res.on('data', function (chunk) { length += chunk.length; });
            res.on('end', function () {
              if (length === big.length) resolve();
              else reject(new Error('paused proxy response cut at ' + length));
            });
            res.resume();
          }, 600);
        }).on('error', reject);
      });
    }).then(function () {
      return call('touchProxy', 'com.example.app', { token: opened.token });
    }).then(function (touched) {
      if (touched.alive !== true || touched.manifestStatus !== 200 || touched.lastStatus !== 200 ||
          !touched.cookies || typeof touched.cookies !== 'object') {
        throw new Error('touchProxy: ' + JSON.stringify(touched));
      }
      return new Promise(function (resolve) {
        strict.open({ url: 'http://localhost:' + origin.address().port + '/live/index.m3u8' }, resolve);
      });
    }).then(function (local) {
      if (local.returnValue !== true) throw new Error('strict proxy open: ' + JSON.stringify(local));
      return proxyGet(local.url);
    }).then(function (refused) {
      if (refused.status !== 403) throw new Error('proxy reached a loopback host name: ' + refused.status);
      return proxyGet(lines[2], { Range: 'bytes=5-14' });
    }).then(function (part) {
      if (part.status !== 206 || part.body.length !== 10 ||
          part.headers['content-range'] !== 'bytes 5-14/' + segment.length) {
        throw new Error('proxy range: ' + part.status);
      }
      return new Promise(function (resolve, reject) {
        var req = http.get(require('url').parse(lines[4]), function (res) {
          res.once('data', function () { req.abort(); });
        });
        req.on('error', function () { /* aborted */ });
        var started = Date.now();
        (function poll() {
          if (aborted) resolve();
          else if (Date.now() - started > 3000) reject(new Error('proxy did not abort upstream'));
          else setTimeout(poll, 20);
        })();
      });
    });
  }).then(function () {
    return call('closeProxy', 'com.example.app', { token: opened.token });
  }).then(function (closed) {
    if (closed.closed !== true || !closed.cookies || typeof closed.cookies !== 'object') {
      throw new Error('closeProxy failed');
    }
    return proxyGet(opened.url);
  }).then(function (gone) {
    if (gone.status !== 404) throw new Error('closed proxy session still served');
  }).then(function () {
    proxy.stop();
    strict.stop();
    origin.close();
  }, function (error) {
    proxy.stop();
    strict.stop();
    origin.close();
    throw error;
  });
}
