var Module = require("module");
var fs = require("fs");
var originalLoad = Module._load;
var nodeMajor = Number(String(process.versions.node || "0").split(".")[0]);
var temporaryRoot = nodeMajor >= 20 ? "/media/developer/temp" : "/tmp";
var temporaryPrefix = temporaryRoot + "/webos-iptv-capt-";

function noop() {}
function logger() {
  return { log: noop, info: noop, warning: noop, error: noop };
}

var pmloglib = {
  log: noop,
  info: noop,
  warning: noop,
  error: noop,
  Console: logger,
  Context: logger
};

Module._load = function(request, parent, isMain) {
  if (request === "pmloglib") return pmloglib;
  return originalLoad.apply(this, arguments);
};

function fail(message) {
  console.error("tv-capt: " + message);
  process.exit(1);
}

function positiveInteger(value, name) {
  var number = Number(value);
  if (!isFinite(number) || number <= 0 || Math.floor(number) !== number) {
    fail("invalid " + name);
  }
  return number;
}

function safePath(value) {
  if (value.indexOf(temporaryPrefix) !== 0
      || !/^[A-Za-z0-9._/-]+$/.test(value.slice(temporaryRoot.length + 1))
      || value.indexOf("..") !== -1) {
    fail("unsafe output path");
  }
  return value;
}

function createBus() {
  var palmbus = require("palmbus");
  if (nodeMajor >= 20) {
    try {
      return new palmbus.Handle("");
    } catch (singleArgumentError) {
      return new palmbus.Handle("", true);
    }
  }
  return new palmbus.Handle("", true);
}

function capture(bus, request, callback) {
  rpc(bus, "executeOneShot", request, callback);
}

function rpc(bus, method, request, callback) {
  var settled = false;
  var call = bus.call(
    "luna://com.webos.service.capture/" + method,
    JSON.stringify(request)
  );
  var timer = setTimeout(function() {
    if (settled) return;
    settled = true;
    callback(new Error("capture request timed out"));
  }, 15000);

  call.on("response", function(message) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    var response;
    try {
      response = JSON.parse(message.payload());
    } catch (error) {
      callback(new Error("invalid capture response"));
      return;
    }
    if (!response.returnValue) {
      callback(new Error(
        (response.errorText || "capture failed")
          + (response.errorCode == null ? "" : " (" + response.errorCode + ")")
      ));
      return;
    }
    callback(null, response);
  });
  call.on("error", function(error) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    callback(error instanceof Error ? error : new Error(String(error)));
  });
}

function request(path, method, width, height, format) {
  return {
    path: safePath(path),
    method: method,
    width: positiveInteger(width, "width"),
    height: positiveInteger(height, "height"),
    format: format
  };
}

function padFrame(index) {
  var value = String(index);
  while (value.length < 6) value = "0" + value;
  return value;
}

function screenshot(args) {
  if (args.length !== 5) fail("invalid screenshot arguments");
  var bus = createBus();
  capture(bus, request(args[0], args[1], args[2], args[3], args[4]),
    function(error, response) {
      if (error) fail(error.message);
      console.log(JSON.stringify(response));
      process.exit(0);
    });
}

function record(args) {
  if (args.length !== 7 && args.length !== 8) fail("invalid record arguments");
  var directory = safePath(args[0]);
  var method = args[1];
  var width = positiveInteger(args[2], "width");
  var height = positiveInteger(args[3], "height");
  var fps = positiveInteger(args[4], "fps");
  var durationMs = positiveInteger(args[5], "duration");
  var quality = positiveInteger(args[6], "JPEG quality");
  var delivery = args[7] || "stream";
  if (delivery !== "stream" && delivery !== "memory"
      && delivery !== "discard") {
    fail("invalid delivery mode");
  }
  var bus = createBus();
  var captureHandle = null;
  var capturePath = directory + "/current.jpg";
  var startedAt = Date.now();
  var capturedAt = [];
  var index = 0;
  var captureMs = 0;
  var readMs = 0;
  var base64Ms = 0;
  var writeMs = 0;
  var drainMs = 0;
  var frameBytes = 0;
  var outputBlocked = false;
  var outputWaiter = null;

  try {
    fs.mkdirSync(directory);
  } catch (error) {
    if (error.code !== "EEXIST") fail(error.message);
  }

  function whenOutputReady(callback) {
    if (!outputBlocked) callback();
    else outputWaiter = callback;
  }

  function finish() {
    whenOutputReady(function() {
      var timing = {
        requestedFps: fps,
        frameCount: index,
        elapsedMs: Date.now() - startedAt,
        capturedAtMs: capturedAt,
        profile: {
          delivery: delivery,
          captureMs: captureMs,
          readMs: readMs,
          base64Ms: base64Ms,
          writeMs: writeMs,
          drainMs: drainMs,
          frameBytes: frameBytes
        }
      };
      rpc(bus, "destroyHandle", { handle: captureHandle }, function(error) {
        if (error) fail(error.message);
        process.stdout.write("@done|" + JSON.stringify(timing) + "\n", function() {
          process.exit(0);
        });
      });
    });
  }

  function next() {
    if (index > 0 && Date.now() - startedAt >= durationMs) {
      finish();
      return;
    }
    var captureStartedAt = Date.now();
    rpc(bus, "execute", { handle: captureHandle }, function(error) {
      if (error) fail("frame " + (index + 1) + ": " + error.message);
      captureMs += Date.now() - captureStartedAt;
      var capturedMs = Date.now() - startedAt;
      whenOutputReady(function() {
        var continueCapture = function() {
          capturedAt.push(capturedMs);
          index += 1;
          var target = startedAt + Math.round(index * 1000 / fps);
          setTimeout(next, Math.max(0, target - Date.now()));
        };
        if (delivery === "discard") {
          continueCapture();
          return;
        }
        var readStartedAt = Date.now();
        var buffer = fs.readFileSync(capturePath);
        readMs += Date.now() - readStartedAt;
        frameBytes += buffer.length;
        var base64StartedAt = Date.now();
        var data = buffer.toString("base64");
        base64Ms += Date.now() - base64StartedAt;
        if (delivery === "memory") {
          continueCapture();
          return;
        }
        var line = "@frame|" + (index + 1) + "|" + capturedMs + "|" + data + "\n";
        var writeStartedAt = Date.now();
        outputBlocked = !process.stdout.write(line);
        writeMs += Date.now() - writeStartedAt;
        if (outputBlocked) {
          var drainStartedAt = Date.now();
          process.stdout.once("drain", function() {
            var waiter = outputWaiter;
            outputBlocked = false;
            outputWaiter = null;
            drainMs += Date.now() - drainStartedAt;
            if (waiter) waiter();
          });
        }
        continueCapture();
      });
    });
  }

  rpc(bus, "createHandle", {}, function(error, response) {
    if (error) fail(error.message);
    captureHandle = response.handle;
    rpc(bus, "setProperties", {
      handle: captureHandle,
      properties: {
        method: method,
        width: width,
        height: height,
        format: "JPEG"
      }
    }, function(error) {
      if (error) fail(error.message);
      rpc(bus, "setOptions", {
        handle: captureHandle,
        options: { jpegQuality: quality }
      }, function(error) {
        if (error) fail(error.message);
        rpc(bus, "setOutput", {
          handle: captureHandle,
          file: { path: capturePath }
        }, function(error) {
          if (error) fail(error.message);
          next();
        });
      });
    });
  });
}

function cleanup(args) {
  if (args.length !== 1) fail("invalid cleanup arguments");
  var directory = safePath(args[0]);
  var names;
  try {
    names = fs.readdirSync(directory);
  } catch (error) {
    if (error.code === "ENOENT") process.exit(0);
    fail(error.message);
  }
  for (var index = 0; index < names.length; index += 1) {
    var name = names[index];
    if (name === "." || name === ".." || name.indexOf("/") !== -1) {
      fail("unsafe temporary filename");
    }
    fs.unlinkSync(directory + "/" + name);
  }
  fs.rmdirSync(directory);
  process.exit(0);
}

var mode = process.argv[2];
var args = process.argv.slice(3);
if (mode === "screenshot") screenshot(args);
else if (mode === "record") record(args);
else if (mode === "cleanup") cleanup(args);
else fail("mode must be screenshot, record, or cleanup");
