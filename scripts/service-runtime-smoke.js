'use strict';

var fs = require('fs');
var http = require('http');
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
  ['alpha.m3u', 'alpha.json'].forEach(function (name) {
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
  epgUrl: '',
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
          JSON.stringify({ type: 'epg', url: 'http://host/b' })
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
  finish();
}, finish);
