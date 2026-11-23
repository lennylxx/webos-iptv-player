// Expands the LUNA_HANDLE macro in a TV-side script into an anonymous palmbus
// handle, like a C macro. Run directly, it reads a script on stdin and prints
// the shell command, for tv.sh.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REMOTE_NODE_PATH = '/usr/lib/node_modules:/usr/lib/nodejs';

// ES5 for webOS 4's Node.js 0.12. pmloglib only loads inside a registered
// service, and webOS 26's palmbus throws on the two-argument form that older
// ones need.
const LUNA_HANDLE = `(function(){
var Module=require("module"),load=Module._load;
function noop(){}
function logger(){return{log:noop,info:noop,warning:noop,error:noop};}
Module._load=function(request){
  if(request==="pmloglib")return{log:noop,info:noop,warning:noop,error:noop,Console:logger,Context:logger};
  return load.apply(this,arguments);
};
var palmbus=require("palmbus");
try{return new palmbus.Handle("",true);}
catch(twoArgumentError){return new palmbus.Handle("");}
})()`;

export const expandPalmbus = (source) => source.replace(/\bLUNA_HANDLE\b/g, LUNA_HANDLE);

const shellQuote = (value) => `'${String(value).replace(/'/g, "'\\''")}'`;

export const palmbusCommand = (source, args = []) =>
  [`NODE_PATH=${REMOTE_NODE_PATH} node -e`, shellQuote(expandPalmbus(source.trim())), ...args].join(' ');

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.stdout.write(palmbusCommand(readFileSync(0, 'utf8')));
}
