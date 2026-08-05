#!/usr/bin/env bash
# Run commands / copy files on the LG webOS TV over SSH.
#
# The tv profile blocks `ares-shell` and `ares-push`, and the TV's SSH key is
# passphrase-protected and only offers a legacy ssh-rsa host key. This pulls the
# connection details (ip, port, user, key, passphrase) from `ares-setup-device`
# at run time — so no secret lives in this file — and drives ssh/scp via expect.
#
# Usage:
#   scripts/tv.sh run '<command>'         # run a shell command on the TV
#   scripts/tv.sh push <local> <remote>   # copy a local file to the TV
#   scripts/tv.sh shell                   # interactive shell
#   scripts/tv.sh logs [--app <id>] ...   # stream the app's DevTools console
#   scripts/tv.sh eval [--app <id>] '<js>'# evaluate JS in the app page (CDP);
#                                         # also: --file <path.js>, or `-` for stdin
#   scripts/tv.sh perf [--app <id>] ...   # CDP perf counters, recordings, GC, snapshots
#   scripts/tv.sh diag [--app <id>] ...   # cold-start redacted diagnostics report
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

info=$(ares-setup-device -F -j 2>/dev/null) || { echo "tv.sh: ares-setup-device failed" >&2; exit 1; }
creds=$(printf '%s' "$info" | TV_DEVICE="${TV_DEVICE:-}" node -e '
let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>{
  const want=process.env.TV_DEVICE||"";
  let a; try { a=JSON.parse(d); } catch { process.exit(2); }
  const t = a.find(x=>want ? x.name===want : x.default) || a[0];
  if(!t){ process.exit(3); }
  const di=t.deviceinfo||{}, de=t.details||{};
  process.stdout.write([di.ip,di.port,di.user,de.privatekey||"",de.passphrase||""].join("\t"));
})') || { echo "tv.sh: no matching device${TV_DEVICE:+ '$TV_DEVICE'}" >&2; exit 1; }
IFS=$'\t' read -r ip port user key pass <<<"$creds"

export TV_KEY="$HOME/.ssh/$key" TV_PORT="$port" TV_HOST="$user@$ip" \
       TV_PASS="$pass" TV_TIMEOUT="${TV_TIMEOUT:-120}"

# Common ssh/scp options; -o LogLevel=ERROR hushes the /dev/null known-hosts note.
# expect word-splits $env(TV_CMD) into argv and ssh re-joins it for the remote
# shell, so `;`, `|`, and quotes in the command run on the TV, not locally.
case "$action" in
  run)
    TV_CMD="${1:-}" expect <<'EOF'
set timeout $env(TV_TIMEOUT)
spawn -noecho ssh -i $env(TV_KEY) -p $env(TV_PORT) -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
  -o HostKeyAlgorithms=+ssh-rsa -o PubkeyAcceptedKeyTypes=+ssh-rsa \
  $env(TV_HOST) $env(TV_CMD)
expect {
  -re {[Pp]assphrase.*:} { send "$env(TV_PASS)\r"; exp_continue }
  -re {[Pp]assword:}     { send "$env(TV_PASS)\r"; exp_continue }
  eof
}
catch wait result
exit [lindex $result 3]
EOF
    ;;
  push)
    [ $# -eq 2 ] || { echo "usage: tv.sh push <local> <remote>" >&2; exit 2; }
    TV_SRC="$1" TV_DST="$2" expect <<'EOF'
set timeout $env(TV_TIMEOUT)
spawn -noecho scp -P $env(TV_PORT) -i $env(TV_KEY) -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
  -o HostKeyAlgorithms=+ssh-rsa -o PubkeyAcceptedKeyTypes=+ssh-rsa \
  $env(TV_SRC) $env(TV_HOST):$env(TV_DST)
expect {
  -re {[Pp]assphrase.*:} { send "$env(TV_PASS)\r"; exp_continue }
  -re {[Pp]assword:}     { send "$env(TV_PASS)\r"; exp_continue }
  eof
}
catch wait result
exit [lindex $result 3]
EOF
    ;;
  shell)
    expect <<'EOF'
set timeout 30
spawn -noecho ssh -i $env(TV_KEY) -p $env(TV_PORT) -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
  -o HostKeyAlgorithms=+ssh-rsa -o PubkeyAcceptedKeyTypes=+ssh-rsa $env(TV_HOST)
expect {
  -re {[Pp]assphrase.*:} { send "$env(TV_PASS)\r"; exp_continue }
  -re {[Pp]assword:}     { send "$env(TV_PASS)\r"; exp_continue }
  -re {[#$] $} {}
}
interact
EOF
    ;;
  *)
    echo "usage: tv.sh {run '<command>' | push <local> <remote> | shell | logs ... | eval '<js>' | perf ... | diag ...}" >&2
    exit 2
    ;;
esac
