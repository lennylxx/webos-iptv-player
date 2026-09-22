#!/usr/bin/env bash
# Run commands / copy files on the LG webOS TV over SSH.
#
# The tv profile blocks `ares-shell` and `ares-push`, and the TV's SSH key is
# passphrase-protected and only offers a legacy ssh-rsa host key. This pulls the
# connection details (ip, port, user, key, passphrase, password) from
# `ares-setup-device` at run time — so no secret lives in this file — and drives
# ssh/scp via expect.
#
# Usage:
#   scripts/tv.sh run '<command>'         # run a shell command on the TV
#   scripts/tv.sh push <local> <remote>   # copy a local file to the TV
#   scripts/tv.sh pull <remote> <local>   # copy a TV file to this computer
#   scripts/tv.sh shell                   # interactive shell
#   scripts/tv.sh reboot                  # reboot the TV through Luna
#   scripts/tv.sh logs [--app <id>] ...   # stream the app's DevTools console
#   scripts/tv.sh eval [--app <id>] '<js>'# evaluate JS in the app page (CDP);
#                                         # also: --file <path.js>, or `-` for stdin
#   scripts/tv.sh perf [--app <id>] ...   # CDP perf counters, recordings, GC, snapshots
#   scripts/tv.sh diag [--app <id>] ...   # cold-start redacted diagnostics report
#   scripts/tv.sh capt ...                # screenshot or record the TV display
#
# Pick a non-default device with TV_DEVICE=<name>; override the expect timeout
# with TV_TIMEOUT=<seconds> (default 120).
set -uo pipefail

action="${1:-}"; shift || true

# logs/eval/perf talk CDP over the network, not ssh — hand straight to the node client.
if [ "$action" = "logs" ]; then
  exec node "$(dirname "$0")/tv-logs.mjs" "$@"
fi
if [ "$action" = "eval" ]; then
  exec node "$(dirname "$0")/tv-eval.mjs" "$@"
fi
if [ "$action" = "perf" ]; then
  exec node "$(dirname "$0")/tv-perf.mjs" "$@"
fi
if [ "$action" = "diag" ]; then
  exec node "$(dirname "$0")/tv-diag.mjs" "$@"
fi
if [ "$action" = "capt" ]; then
  exec node "$(dirname "$0")/tv-capt.mjs" "$@"
fi

info=$(ares-setup-device -F -j 2>/dev/null) || { echo "tv.sh: ares-setup-device failed" >&2; exit 1; }
creds=$(printf '%s' "$info" | TV_DEVICE="${TV_DEVICE:-}" node -e '
let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{
  const want=process.env.TV_DEVICE||"";
  let a; try { a=JSON.parse(d); } catch { process.exit(2); }
  const t = a.find(x=>want ? x.name===want : x.default) || a[0];
  if(!t){ process.exit(3); }
  const di=t.deviceinfo||{}, de=t.details||{};
  const values = [
    di.ip||di.host||de.host||"",
    di.port||de.port||"",
    di.user||di.username||de.username||"",
    de.privatekey||"",
    de.passphrase||"",
    de.password||""
  ];
  process.stdout.write(values.map(value =>
    "x"+Buffer.from(String(value),"utf8").toString("base64")
  ).join("\t"));
})') || { echo "tv.sh: no matching device${TV_DEVICE:+ '$TV_DEVICE'}" >&2; exit 1; }
IFS=$'\t' read -r ip_encoded port_encoded user_encoded key_encoded \
  passphrase_encoded password_encoded <<<"$creds"

decode_field() {
  TV_ENCODED="$1" node -e \
    'process.stdout.write(Buffer.from(process.env.TV_ENCODED.slice(1),"base64").toString("utf8"))'
}

ip=$(decode_field "$ip_encoded")
port=$(decode_field "$port_encoded")
user=$(decode_field "$user_encoded")
key=$(decode_field "$key_encoded")
passphrase=$(decode_field "$passphrase_encoded")
password=$(decode_field "$password_encoded")

[ -n "$ip" ] && [ -n "$port" ] && [ -n "$user" ] \
  && { [ -n "$key" ] || [ -n "$password" ]; } \
  || { echo "tv.sh: selected device has incomplete SSH details" >&2; exit 1; }
key_path=""
if [ -n "$key" ]; then
  case "$key" in
    /*) key_path="$key" ;;
    *) key_path="$HOME/.ssh/$key" ;;
  esac
fi

export TV_KEY="$key_path" TV_PORT="$port" TV_HOST="$user@$ip" \
       TV_PASSPHRASE="$passphrase" TV_PASSWORD="$password" \
       TV_TIMEOUT="${TV_TIMEOUT:-120}" \
       TV_EXPECT_DISCONNECT="${TV_EXPECT_DISCONNECT:-0}" \
       TV_CONTROL_PATH="/tmp/webos-tv-%C"

run_transport() {
  expect <<'EOF'
set timeout $env(TV_TIMEOUT)
set mode $env(TV_MODE)
set interactive [expr {$mode eq "shell"}]
set expected_disconnect 0
if {$interactive} { set timeout 30 }

if {$mode eq "push" || $mode eq "pull"} {
  set args [list scp -P $env(TV_PORT)]
} else {
  set args [list ssh -p $env(TV_PORT)]
}
if {[string length $env(TV_KEY)] > 0} { lappend args -i $env(TV_KEY) }
lappend args -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null \
  -o LogLevel=ERROR -o ControlMaster=auto -o ControlPersist=60 \
  -o ControlPath=$env(TV_CONTROL_PATH) -o HostKeyAlgorithms=+ssh-rsa \
  -o PubkeyAcceptedKeyTypes=+ssh-rsa

switch -- $mode {
  run {
    lappend args $env(TV_HOST) $env(TV_CMD)
  }
  push {
    lappend args $env(TV_SRC) "$env(TV_HOST):$env(TV_DST)"
  }
  pull {
    lappend args "$env(TV_HOST):$env(TV_SRC)" $env(TV_DST)
  }
  shell {
    lappend args $env(TV_HOST)
  }
}
spawn -noecho {*}$args
set ready 0
expect {
  -re {[Pp]assphrase.*:} {
    if {[string length $env(TV_PASSPHRASE)] == 0} {
      puts stderr "tv.sh: private key passphrase required"
      exit 1
    }
    log_user 0
    send "$env(TV_PASSPHRASE)\r"
    expect -re {\r?\n}
    log_user 1
    exp_continue
  }
  -re {[Pp]assword:} {
    if {[string length $env(TV_PASSWORD)] == 0} {
      puts stderr "tv.sh: login password required"
      exit 1
    }
    log_user 0
    send "$env(TV_PASSWORD)\r"
    expect -re {\r?\n}
    log_user 1
    exp_continue
  }
  -re {[#$] $} {
    if {$interactive} {
      set ready 1
    } else {
      exp_continue
    }
  }
  -re {__TV_REBOOT_REQUESTED__} {
    if {$env(TV_EXPECT_DISCONNECT) eq "1"} {
      set expected_disconnect 1
    }
    exp_continue
  }
  timeout {
    if {$interactive} {
      set ready 1
    } else {
      puts stderr "tv.sh: connection timed out"
      exit 1
    }
  }
  eof {}
}

if {$ready} {
  interact
}
catch wait result
set status [lindex $result 3]
if {$expected_disconnect && $status == 255} {
  exit 0
}
exit $status
EOF
}

# Common ssh/scp options hush known-hosts notices and retain a short-lived
# control connection. ssh re-joins TV_CMD for the remote shell.
case "$action" in
  run)
    export TV_MODE="run" TV_CMD="${1:-}"
    run_transport
    ;;
  push)
    [ $# -eq 2 ] || { echo "usage: tv.sh push <local> <remote>" >&2; exit 2; }
    export TV_MODE="push" TV_SRC="$1" TV_DST="$2"
    run_transport
    ;;
  pull)
    [ $# -eq 2 ] || { echo "usage: tv.sh pull <remote> <local>" >&2; exit 2; }
    export TV_MODE="pull" TV_SRC="$1" TV_DST="$2"
    run_transport
    ;;
  shell)
    export TV_MODE="shell"
    run_transport
    ;;
  reboot)
    [ $# -eq 0 ] || { echo "usage: tv.sh reboot" >&2; exit 2; }
    export TV_MODE="run" TV_EXPECT_DISCONNECT="1"
    TV_CMD=$(cat <<'EOF'
NODE_PATH=/usr/lib/node_modules:/usr/lib/nodejs node -e '
var Module=require("module"),originalLoad=Module._load;
function noop(){}
function logger(){return{log:noop,info:noop,warning:noop,error:noop};}
var pmloglib={log:noop,info:noop,warning:noop,error:noop,Console:logger,Context:logger};
Module._load=function(request,parent,isMain){
  if(request==="pmloglib")return pmloglib;
  return originalLoad.apply(this,arguments);
};
function createHandle(pb){
  try{return new pb.Handle("");}
  catch(singleArgumentError){return new pb.Handle("",true);}
}
var pb=require("palmbus"),handle=createHandle(pb);
handle.call(
  "luna://com.webos.service.sleep/shutdown/machineReboot",
  JSON.stringify({reason:"remoteKey"})
);
console.log("__TV_REBOOT_REQUESTED__");
setTimeout(function(){process.exit(0);},3000);'
EOF
)
    export TV_CMD
    echo "Rebooting TV..."
    run_transport
    ;;
  *)
    echo "usage: tv.sh {run '<command>' | push <local> <remote> | pull <remote> <local> | shell | reboot | logs ... | eval '<js>' | perf ... | diag ... | capt ...}" >&2
    exit 2
    ;;
esac
