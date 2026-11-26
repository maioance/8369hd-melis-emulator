// Interactive viewer: runs the emulator in real time and serves the screen to a browser canvas.
// Mouse down/drag/up on the canvas become LTSDev touch events.
//   npm run serve -- --dump <extracted-dir> [--fresh] [--port 8133]   then open http://localhost:8133
import { fileURLToPath } from 'node:url';
import { createServer, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { appendFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { Kernel } from './kernel.ts';
import { encodePng, SCREEN_W, SCREEN_H } from './devices.ts';
import { parseArgs, createEmulator } from './boot.ts';
import { BtPhone } from './bt.ts';

const a = parseArgs(process.argv.slice(2));
const port = Number(a.opt('--port', '8133'));
const k = createEmulator(a, { realtime: true });
const logFile = join(resolve(a.opt('--state', fileURLToPath(new URL('../state', import.meta.url)))), 'emu.log');
mkdirSync(dirname(logFile), { recursive: true });
writeFileSync(logFile, '');
k.log = s => appendFileSync(logFile, s + '\n');

let halted = '';
let mips = 0;
// Run guest code in ~40 ms bursts so HTTP requests stay responsive.
function pump(): void {
  if (halted) return;
  const start = Date.now(), s0 = k.cpu.steps;
  let r: 'idle' | 'budget' = 'budget';
  try {
    while (Date.now() - start < 40) { r = k.run(1_000_000); if (r === 'idle') break; }
  } catch (e) {
    halted = (e as Error).message;
    console.error('HALT:', halted, `pc=0x${k.cpu.lastPc.toString(16)}`);
    return;
  }
  const dt = Date.now() - start;
  if (dt > 0) mips = mips * 0.9 + ((k.cpu.steps - s0) / dt / 1000) * 0.1;
  if (r === 'idle') setTimeout(pump, 5); else setImmediate(pump);
}

let png: Buffer = Buffer.alloc(0), pngHash = '';
function frame(): Buffer {
  const img = k.disp.render();
  const h = createHash('sha1').update(img).digest('hex');
  if (h !== pngHash) { pngHash = h; png = encodePng(img, SCREEN_W, SCREEN_H); }
  return png;
}

// --- minimal WebSocket (RFC 6455) for the live view: no PNG encoding, only changed rows are sent
const wsClients = new Set<Duplex>();
function wsSend(sock: Duplex, payload: Buffer, opcode = 2): void {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, n])
    : n < 65536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 255])
    : Buffer.concat([Buffer.from([0x80 | opcode, 127, 0, 0, 0, 0]), Buffer.from([n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255])]);
  sock.write(Buffer.concat([head, payload]));
}
function touchFromViewer(act: string, x: number, y: number): void {
  const action = act === 'down' ? Kernel.TP.DOWN : act === 'move' ? Kernel.TP.MOVE : Kernel.TP.UP;
  if (act !== 'move') k.log(`>>> touch ${act} ${x},${y}`);
  k.touch(action, x, y);
}
function wsAccept(req: IncomingMessage, sock: Duplex): void {
  const key = req.headers['sec-websocket-key'];
  if (req.url !== '/ws' || !key) { sock.destroy(); return; }
  const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  wsClients.add(sock);
  lastFrame = undefined; // new viewer gets a full frame
  let buf = Buffer.alloc(0);
  sock.on('data', (d: Buffer) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 2) {
      const op = buf[0] & 15, masked = buf[1] & 128;
      let len = buf[1] & 127, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const mask = masked ? buf.subarray(off, off + 4) : undefined; if (masked) off += 4;
      if (buf.length < off + len) return;
      const p = Buffer.from(buf.subarray(off, off + len)); buf = buf.subarray(off + len);
      if (mask) for (let i = 0; i < p.length; i++) p[i] ^= mask[i & 3];
      if (op === 8) { wsSend(sock, Buffer.alloc(0), 8); sock.end(); return; }
      if (op === 9) { wsSend(sock, p, 10); continue; }
      if (op === 1) try { const { a: act, x, y } = JSON.parse(p.toString()); touchFromViewer(act, x, y); } catch {}
    }
  });
  const drop = (): void => { wsClients.delete(sock); };
  sock.on('close', drop); sock.on('error', drop);
}
// ~30 fps: compare with the last sent frame, send the band of rows that changed
let lastFrame: Uint32Array | undefined;
setInterval(() => {
  if (!wsClients.size || halted) return;
  const img = k.disp.render(), cur = new Uint32Array(img.buffer, img.byteOffset, SCREEN_W * SCREEN_H);
  let y0 = 0, y1 = SCREEN_H - 1;
  if (lastFrame) {
    const rowSame = (y: number): boolean => { for (let i = y * SCREEN_W, e = i + SCREEN_W; i < e; i++) if (cur[i] !== lastFrame![i]) return false; return true; };
    while (y0 < SCREEN_H && rowSame(y0)) y0++;
    if (y0 === SCREEN_H) return;
    while (y1 > y0 && rowSame(y1)) y1--;
  }
  lastFrame = cur;
  const n = y1 - y0 + 1, msg = Buffer.allocUnsafe(4 + n * SCREEN_W * 4);
  msg.writeUInt16LE(y0, 0); msg.writeUInt16LE(n, 2);
  msg.set(img.subarray(y0 * SCREEN_W * 4, (y1 + 1) * SCREEN_W * 4), 4);
  for (const sock of wsClients) wsSend(sock, msg);
}, 33);

const page = `<!doctype html><meta charset="utf-8"><title>8369HD head unit &amp; VW CAN-bus simulator</title>
<style>
body{background:#141414;color:#eee;font:13px system-ui;margin:16px}
canvas{border:1px solid #444;cursor:crosshair;image-rendering:pixelated;box-shadow:0 4px 16px rgba(0,0,0,0.6)}
#wrap{display:flex;gap:18px;align-items:flex-start}
#p{width:360px}
#p fieldset{border:1px solid #444;border-radius:6px;margin:0 0 10px;padding:8px 10px;background:#1b1b1b}
#p legend{font-weight:600;color:#61afef;padding:0 4px}
#p button{margin:2px;padding:6px 10px;background:#2a2a2a;color:#eee;border:1px solid #555;border-radius:4px;cursor:pointer;font-weight:500}
#p button:hover{background:#3a3a3a;border-color:#777}
#p button:active{background:#505050}
.btn-primary{background:#1e4b7a !important;border-color:#3498db !important}
.btn-primary:hover{background:#2868a8 !important}
#p label{display:inline-block;width:160px;margin-bottom:4px;font-size:12px;cursor:pointer}
#p input[type=checkbox]{cursor:pointer;vertical-align:middle}
.row{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;font-size:12px}
.row input[type=number]{width:85px;padding:3px 6px;background:#111;color:#61afef;border:1px solid #444;border-radius:3px;font-weight:bold}
.row input[type=range]{flex:1;margin:0 8px}
#log{font:11px 'JetBrains Mono',monospace;white-space:pre;height:120px;overflow:auto;background:#0a0a0a;color:#98c379;padding:6px;border-radius:4px;border:1px solid #333}
</style>
<div id=wrap>
  <div>
    <canvas id=c width=${SCREEN_W} height=${SCREEN_H}></canvas>
    <div id=s style="margin-top:6px;color:#888;font-size:11px"></div>
  </div>
  <div id=p>
    <fieldset><legend>🛞 Steering wheel keys (CAN 0x20)</legend>
      <button onclick="key(1)">🔊 Vol+</button>
      <button onclick="key(2)">🔉 Vol-</button>
      <button onclick="key(3)">⏭️ Next</button>
      <button onclick="key(4)">⏮️ Prev</button>
      <button onclick="key(5)">📞 Tel</button>
      <button onclick="key(6)">🔇 Mute</button>
    </fieldset>

    <fieldset><legend>🚗 Doors &amp; body state (CAN 0x41 sub 01)</legend>
      <div id=doors></div>
    </fieldset>

    <fieldset><legend>📊 Trip computer (speed / odometer / RPM)</legend>
      <div class=row>
        <span>Odometer:</span>
        <input id=in_odo type=number min=0 max=999999 value=125430 onchange="sendCarData()">
        <span style="color:#888;width:35px">km</span>
      </div>
      <div class=row>
        <span>Speed:</span>
        <input id=in_spd type=range min=0 max=250 value=65 oninput="spdv.value=this.value;sendCarData()">
        <input id=spdv type=number min=0 max=250 value=65 onchange="in_spd.value=this.value;sendCarData()">
        <span style="color:#888;width:35px">km/h</span>
      </div>
      <div class=row>
        <span>Engine speed:</span>
        <input id=in_rpm type=range min=0 max=7000 step=50 value=2200 oninput="rpmv.value=this.value;sendCarData()">
        <input id=rpmv type=number min=0 max=7000 value=2200 onchange="in_rpm.value=this.value;sendCarData()">
        <span style="color:#888;width:35px">rpm</span>
      </div>
      <div class=row>
        <span>Battery:</span>
        <input id=in_volt type=range min=10.0 max=16.0 step=0.1 value=13.8 oninput="voltv.value=this.value;sendCarData()">
        <input id=voltv type=number min=10.0 max=16.0 step=0.1 value=13.8 onchange="in_volt.value=this.value;sendCarData()">
        <span style="color:#888;width:35px">V</span>
      </div>
      <div class=row>
        <span>Outside temp.:</span>
        <input id=in_temp type=range min=-20 max=50 step=0.5 value=21.5 oninput="tempv.value=this.value;sendCarData()">
        <input id=tempv type=number min=-20 max=50 step=0.5 value=21.5 onchange="in_temp.value=this.value;sendCarData()">
        <span style="color:#888;width:35px">°C</span>
      </div>
      <div class=row>
        <span>Fuel:</span>
        <input id=in_fuel type=range min=0 max=70 value=45 oninput="fuelv.value=this.value;sendCarData()">
        <input id=fuelv type=number min=0 max=70 value=45 onchange="in_fuel.value=this.value;sendCarData()">
        <span style="color:#888;width:35px">L</span>
      </div>
      <button class=btn-primary style="width:100%;margin-top:6px" onclick="sendCarData()">🔄 Send trip computer data</button>
    </fieldset>

    <fieldset><legend>📻 Radio RDS (MCU 0xB4)</legend>
      <div class=row>
        <span>Station name:</span>
        <input id=rds_ps maxlength=8 value="KISS FM" style="flex:1;margin:0 8px;background:#111;color:#eee;border:1px solid #444;padding:3px;border-radius:3px">
        <select id=rds_pty style="background:#111;color:#eee;border:1px solid #444;padding:2px;border-radius:3px">
          <option value=0>PTY: -</option><option value=1>News</option><option value=3>Info</option><option value=4>Sport</option>
          <option value=10 selected>Pop</option><option value=11>Rock</option><option value=15>Other music</option>
        </select>
      </div>
      <button class=btn-primary style="width:100%" onclick="sendRds()">📡 Send station name</button>
    </fieldset>

    <fieldset><legend>📱 Bluetooth phone (BT module via MCU 0xD4)</legend>
      <style>
        .bt input{background:#111;color:#eee;border:1px solid #444;padding:3px;border-radius:3px}
        .bt .g{display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;margin:6px 0}
        #bt_log{height:110px;overflow:auto;background:#0b0b0b;border:1px solid #333;font:11px monospace;padding:4px;white-space:pre}
      </style>
      <div class=bt>
        <div class=row><span>State:</span><b id=bt_state style="margin-left:8px">—</b></div>
        <div class=row>
          <span>Phone name:</span>
          <input id=bt_phone value="Test Phone" style="flex:1;margin:0 8px">
        </div>
        <div class=g>
          <button onclick="bt('connect',{phone:val('bt_phone')})">🔗 Connect</button>
          <button onclick="bt('disconnect')">⛓️‍💥 Disconnect</button>
          <button onclick="bt('power')">⚡ Module powered (IS)</button>
        </div>
        <div class=row>
          <span>Call from:</span>
          <input id=bt_num value="5550100" style="flex:1;margin:0 8px">
          <button onclick="bt('incoming',{number:document.getElementById('bt_num').value})">📞 Ring</button>
        </div>
        <div class=g>
          <button onclick="bt('remoteAnswer')">✅ Answer on the phone</button>
          <button onclick="bt('remoteHangup')">❌ Hang up on the phone</button>
          <span></span>
        </div>
        <div class=row style="gap:6px">
          <input id=bt_title placeholder="Title" style="flex:1"><input id=bt_artist placeholder="Artist" style="flex:1"><input id=bt_album placeholder="Album" style="flex:1">
        </div>
        <div class=g>
          <button onclick="bt('track',{title:val('bt_title'),artist:val('bt_artist'),album:val('bt_album')})">🎵 Send track</button>
          <button onclick="bt('play')">▶️ Play</button>
          <button onclick="bt('pause')">⏸️ Pause</button>
        </div>
        <div id=bt_log></div>
      </div>
    </fieldset>

    <fieldset><legend>❄️ Climatronic VW (CAN-box 0x21)</legend>
      <style>
        .cl{display:grid;grid-template-columns:1fr 1.2fr 1fr;gap:8px;align-items:start}
        .cl .k{background:#1b1f22;border:1px solid #333;border-radius:10px;padding:6px;text-align:center}
        .cl .disp{font:600 22px system-ui;color:#e6e6e6;margin:2px 0 4px}
        .cl .sub{font-size:10px;color:#888}
        .cl button{min-width:34px}
        .cl button.on{background:#14514f;border-color:#35c8c8;color:#fff}
        .cl .led{display:inline-block;width:14px;height:3px;border-radius:2px;background:#333;vertical-align:middle;margin-left:4px}
        .cl .on .led{background:#f08020}
        .ctop{display:flex;gap:4px;justify-content:center;margin-bottom:8px}
        .ctop button{flex:1}
      </style>
      <div class=ctop>
        <button id=b_ws onclick="cFlow('ws')">💨 Windshield<span class=led></span></button>
        <button id=b_face onclick="cFlow('face')">🧍 Face<span class=led></span></button>
        <button id=b_feet onclick="cFlow('feet')">🦶 Feet<span class=led></span></button>
        <button id=b_recirc onclick="cRecirc()">🚗 <span id=recirc_lbl>Recirc.</span><span class=led></span></button>
      </div>
      <div class=cl>
        <div class=k>
          <div class=sub>Driver</div>
          <div class=disp id=tl_disp>21.0</div>
          <button onclick="cTemp('L',-1)">−</button> <button onclick="cTemp('L',1)">+</button>
          <div style="margin-top:6px;display:flex;gap:4px;justify-content:center">
            <button id=b_max onclick="cMaxDefrost()">MAX ❄<span class=led></span></button>
            <button id=b_rear onclick="cToggle('rear')">▦ Rear window<span class=led></span></button>
          </div>
        </div>
        <div class=k>
          <div class=sub>Fan</div>
          <div class=disp id=fan_disp>3</div>
          <button onclick="cFan(-1)">−</button> <button onclick="cFan(1)">+</button>
          <div style="margin-top:6px;display:flex;gap:4px;justify-content:center">
            <button id=b_off onclick="cOff()">OFF</button>
            <button id=b_auto onclick="cAuto()">AUTO<span class=led></span></button>
            <button id=b_sync onclick="cSync()">SYNC<span class=led></span></button>
          </div>
        </div>
        <div class=k>
          <div class=sub>Passenger</div>
          <div class=disp id=tr_disp>21.0</div>
          <button onclick="cTemp('R',-1)">−</button> <button onclick="cTemp('R',1)">+</button>
          <div style="margin-top:6px;display:flex;gap:4px;justify-content:center">
            <button id=b_maxac onclick="cMaxAc()">MAX A/C</button>
            <button id=b_ac onclick="cToggle('ac')">A/C<span class=led></span></button>
          </div>
        </div>
      </div>
      <div class=sub style="margin-top:6px" id=cl_frame></div>
    </fieldset>

    <fieldset><legend>📐 Steering angle (CAN 0x26)</legend>
      <input id=ang type=range min=-540 max=540 value=0 onchange="angle()" style="width:100%">
    </fieldset>

    <fieldset><legend>✉️ Raw CAN frame (Raise 0x2E)</legend>
      <input id=raw size=24 placeholder="type data... e.g. 41 02 01 80" style="background:#111;color:#eee;border:1px solid #444;padding:4px;border-radius:3px">
      <button onclick="rawSend()">Send</button>
    </fieldset>

    <fieldset><legend>📡 Monitor CAN / Serial</legend>
      <div id=log></div>
    </fieldset>
  </div>
</div>
<script>
const c = document.getElementById('c'), g = c.getContext('2d'), s = document.getElementById('s');
// Screen arrives over a WebSocket as raw RGBA bands: u16 y0, u16 rows, then rows*W*4 bytes.
let ws;
function connect() {
  ws = new WebSocket('ws://' + location.host + '/ws');
  ws.binaryType = 'arraybuffer';
  ws.onmessage = e => {
    const d = new DataView(e.data), y0 = d.getUint16(0, true), n = d.getUint16(2, true);
    g.putImageData(new ImageData(new Uint8ClampedArray(e.data, 4, c.width * n * 4), c.width, n), 0, y0);
  };
  ws.onclose = () => setTimeout(connect, 1000);
}
connect();
setInterval(async () => { try { s.textContent = await (await fetch('/status')).text(); } catch {} }, 500);

// Touch goes over the same socket; moves are coalesced to one per animation frame.
const pos = e => { const b = c.getBoundingClientRect(); return [Math.round((e.clientX - b.left) * c.width / b.width), Math.round((e.clientY - b.top) * c.height / b.height)]; };
const send = (a, [x, y]) => {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ a, x, y }));
  else fetch('/touch', { method: 'POST', body: JSON.stringify({ a, x, y }) });
};
let down = false, pending = null;
c.style.touchAction = 'none';
c.onpointerdown = e => { down = true; c.setPointerCapture(e.pointerId); send('down', pos(e)); };
c.onpointermove = e => {
  if (!down) return;
  if (!pending) requestAnimationFrame(() => { if (down && pending) send('move', pending); pending = null; });
  pending = pos(e);
};
c.onpointerup = c.onpointercancel = e => { if (down) { down = false; pending = null; send('up', pos(e)); } };

const can = (type, data) => fetch('/can', { method: 'POST', body: JSON.stringify({ type, data }) });
const mcu = (cmd, data) => fetch('/mcu', { method: 'POST', body: JSON.stringify({ cmd, data }) });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function key(k) {
  await can(0x20, [k, 1]);
  await sleep(120);
  await can(0x20, [k, 0]);
}

// Bits, checked in the car:
// bit0: front left door (driver)
// bit1: front right door (passenger)
// bit2: rear left door
// bit3: rear right door
// bit4: boot
// bit5: handbrake
// bit6: bit 6 (unused)
// bit7: seat belt
const doorDef = [
  { b: 0, n: 'Driver door (FL)' },
  { b: 1, n: 'Passenger door (FR)' },
  { b: 2, n: 'Rear left door (RL)' },
  { b: 3, n: 'Rear right door (RR)' },
  { b: 4, n: 'Boot' },
  { b: 5, n: 'Handbrake' },
  { b: 7, n: 'Seat belt' },
  { b: 6, n: 'Bit 6 (unused)' }
];

const dEl = document.getElementById('doors');
doorDef.forEach(d => {
  dEl.insertAdjacentHTML('beforeend', '<label><input type=checkbox data-b=' + d.b + '> ' + d.n + '</label>');
});

function getDoorByte() {
  return [...document.querySelectorAll('#doors input')].reduce((v, x) => v | (x.checked ? 1 << +x.dataset.b : 0), 0);
}

dEl.onchange = () => {
  const dByte = getDoorByte();
  can(0x41, [0x01, dByte]);
  sendCarData();
};

function sendCarData() {
  const rpm = +document.getElementById('rpmv').value;
  const spd = Math.round(+document.getElementById('spdv').value * 100); // 0.01 km/h
  const volt = Math.round(+document.getElementById('voltv').value * 100); // 0.01 V
  const temp = Math.round(+document.getElementById('tempv').value * 10); // 0.1 °C
  const odo = +document.getElementById('in_odo').value; // km
  const fuel = +document.getElementById('fuelv').value; // L
  const doors = getDoorByte();

  // 1. CAN 0x41 SubType 0x02 (VW Raise protocol)
  const canSub2 = [
    0x02,
    (rpm >> 8) & 0xff, rpm & 0xff,
    (spd >> 8) & 0xff, spd & 0xff,
    (volt >> 8) & 0xff, volt & 0xff,
    (temp >> 8) & 0xff, temp & 0xff,
    (odo >> 16) & 0xff, (odo >> 8) & 0xff, odo & 0xff,
    fuel & 0xff
  ];
  can(0x41, canSub2);

  // 2. MCU 0xE4 (Vehicle Info direct)
  const mcuData = [
    doors ^ 0x20, // bit 5 inverted in MCU format
    (rpm >> 8) & 0xff, rpm & 0xff,
    (spd >> 8) & 0xff, spd & 0xff,
    (volt >> 8) & 0xff, volt & 0xff,
    (temp >> 8) & 0xff, temp & 0xff,
    (odo >> 16) & 0xff, (odo >> 8) & 0xff, odo & 0xff,
    fuel & 0xff,
    0x00, 0x00
  ];
  mcu(0xe4, mcuData);
}

// RDS from the tuner (MCU 0xB4, subtype 2): 8 ASCII characters of the station name + the programme type (PTY)
function val(id) { return document.getElementById(id).value; }
function bt(action, extra) {
  fetch('/bt', { method: 'POST', body: JSON.stringify({ action, ...(extra || {}) }) }).then(btPoll);
}
async function btPoll() {
  const st = await (await fetch('/bt')).json();
  const c = st.call;
  document.getElementById('bt_state').textContent = !st.connected ? (st.ready ? 'disconnected' : 'module off')
    : c ? (c.dir === 'in' ? (c.active ? 'in a call with ' : 'ringing: ') : (c.active ? 'in a call with ' : 'dialling ')) + c.number
    : 'connected' + (st.playing ? ' · ▶ ' + st.track.title + ' – ' + st.track.artist : '');
  const log = document.getElementById('bt_log');
  const atEnd = log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
  log.textContent = st.log.join('\\n');
  if (atEnd) log.scrollTop = log.scrollHeight;
}
setInterval(btPoll, 1000);
function sendRds() {
  const ps = (document.getElementById('rds_ps').value + '        ').slice(0, 8);
  const chars = Array.from(ps, ch => { const c = ch.charCodeAt(0); return c >= 32 && c < 127 ? c : 32; });
  mcu(0xb4, [2, ...chars, +document.getElementById('rds_pty').value]);
}

// VW Climatronic, as in the car. CAN-box frame 0x21 (checked against the structure init.axf decodes):
// d0: 0x01 rear window, 0x02 MAX windshield, 0x04 DUAL (= SYNC off), 0x08 auto low, 0x10 AUTO, 0x20 recirculation,
//     0x80 A/C
// d1: bits 0..2 fan (0 = OFF), 0x20 feet, 0x40 face, 0x80 windshield
// d2/d3: temperature left / right: 0 = LO, 31 = HI, otherwise 17.5 + 0.5 * v (1 = 18.0 ... 30 = 32.5)
// d4: 0x80 automatic recirculation (A)
const cl = { ac: true, rear: false, max: false, auto: false, sync: true, recirc: 0, fan: 3,
             ws: false, face: true, feet: false, tL: 7, tR: 7 };
const tTxt = v => v === 0 ? 'LO' : v === 31 ? 'HI' : (17.5 + 0.5 * v).toFixed(1);
function clRender() {
  const set = (id, on) => document.getElementById(id).classList.toggle('on', !!on);
  set('b_ws', cl.ws); set('b_face', cl.face); set('b_feet', cl.feet); set('b_recirc', cl.recirc);
  set('b_max', cl.max); set('b_rear', cl.rear); set('b_auto', cl.auto); set('b_sync', cl.sync); set('b_ac', cl.ac);
  document.getElementById('recirc_lbl').textContent = cl.recirc === 2 ? 'Recirc. A' : 'Recirc.';
  document.getElementById('tl_disp').textContent = tTxt(cl.tL);
  document.getElementById('tr_disp').textContent = tTxt(cl.tR);
  document.getElementById('fan_disp').textContent = cl.fan ? cl.fan : 'OFF';
}
function sendClimate() {
  if (cl.sync) cl.tR = cl.tL;
  const d0 = (cl.rear ? 0x01 : 0) | (cl.max ? 0x02 : 0) | (cl.sync ? 0 : 0x04) | (cl.auto ? 0x10 : 0)
           | (cl.recirc ? 0x20 : 0) | (cl.ac ? 0x80 : 0);
  const d1 = (cl.fan & 7) | (cl.feet ? 0x20 : 0) | (cl.face ? 0x40 : 0) | (cl.ws ? 0x80 : 0);
  const d4 = cl.recirc === 2 ? 0x80 : 0;
  const d = [d0, d1, cl.tL, cl.tR, d4];
  can(0x21, d);
  document.getElementById('cl_frame').textContent = 'CAN 0x21: ' + d.map(b => b.toString(16).padStart(2, '0')).join(' ');
  clRender();
}
function cTemp(side, step) {
  const k = side === 'L' ? 'tL' : 'tR';
  cl[k] = Math.max(0, Math.min(31, cl[k] + step));
  if (side === 'R') cl.sync = false;      // the passenger set apart turns SYNC off
  sendClimate();
}
function cFan(step) { cl.fan = Math.max(0, Math.min(7, cl.fan + step)); cl.auto = false; sendClimate(); }
function cFlow(k) { cl[k] = !cl[k]; cl.auto = false; if (k === 'ws' && !cl.ws) cl.max = false; sendClimate(); }
function cToggle(k) { cl[k] = !cl[k]; sendClimate(); }
function cRecirc() { cl.recirc = (cl.recirc + 1) % 3; sendClimate(); }   // off -> manual -> automatic (A)
function cSync() { cl.sync = !cl.sync; sendClimate(); }
function cAuto() {
  cl.auto = !cl.auto;
  if (cl.auto) { cl.ac = true; if (!cl.fan) cl.fan = 3; cl.ws = false; cl.face = true; cl.feet = true; cl.max = false; }
  sendClimate();
}
function cOff() { cl.fan = 0; cl.ac = false; cl.auto = false; cl.max = false; sendClimate(); }
function cMaxDefrost() {
  cl.max = !cl.max;
  if (cl.max) { cl.ws = true; cl.face = false; cl.feet = false; cl.fan = 7; cl.ac = true; cl.auto = false; }
  sendClimate();
}
function cMaxAc() {
  cl.ac = true; cl.recirc = 1; cl.fan = 7; cl.tL = 0; cl.tR = 0; cl.sync = true;
  cl.ws = false; cl.face = true; cl.feet = false; cl.auto = false; cl.max = false;
  sendClimate();
}
clRender();

function angle() {
  const v = (+ang.value * 6) & 0xffff;
  can(0x26, [v & 255, v >> 8]);
}

function rawSend() {
  const b = raw.value.trim().split(/\\s+/).map(x => parseInt(x, 16));
  if (b.length >= 2) can(b[0], b.slice(1));
}

setInterval(async () => {
  try {
    const t = await (await fetch('/canlog')).text();
    const l = document.getElementById('log');
    if (l.textContent !== t) { l.textContent = t; l.scrollTop = 1e9; }
  } catch {}
}, 500);
</script>`;

const canLog: string[] = [];
function canFrame(type: number, data: number[]): number[] {
  const body = [type & 0xff, data.length & 0xff, ...data.map(b => b & 0xff)];
  const cks = (body.reduce((a, b) => a + b, 0) & 0xff) ^ 0xff;
  return [0x2e, ...body, cks];
}
/** MCU protocol on /dev/uart1: 02 81 cmd len data.. xor(81..data) */
function mcuFrame(cmd: number, data: number[]): number[] {
  const body = [0x81, cmd & 0xff, data.length & 0xff, ...data.map(b => b & 0xff)];
  return [0x02, ...body, body.reduce((a, b) => a ^ b, 0)];
}

// simulated phone + BT module behind the MCU (see bt.ts)
const phone = new BtPhone(b => k.uartPush('/dev/uart1', b),
  (addr, v) => { const b = Buffer.alloc(4); b.writeInt32LE(v); k.mem.write(addr, b); });
k.onUartTx = (name, bytes) => { if (name === '/dev/uart1') phone.feed(bytes); };

const server = createServer((req, res) => {
  if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end(page); return; }
  if (req.url === '/frame.png') {
    const body = frame();
    if (req.headers['if-none-match'] === pngHash) { res.statusCode = 304; res.end(); return; }
    res.setHeader('content-type', 'image/png'); res.setHeader('etag', pngHash); res.end(body); return;
  }
  if (req.url === '/status') {
    res.end(halted ? `HALTED: ${halted}` : `tick ${k.ticks} (${(k.ticks / 100).toFixed(1)} s guest) · ${(k.cpu.steps / 1e6).toFixed(0)}M instructions · ${mips.toFixed(1)} MIPS · log: ${logFile}`);
    return;
  }
  if (req.url === '/touch' && req.method === 'POST') {
    let body = '';
    req.on('data', d => (body += d));
    req.on('end', () => {
      const { a: act, x, y } = JSON.parse(body);
      const action = act === 'down' ? Kernel.TP.DOWN : act === 'move' ? Kernel.TP.MOVE : Kernel.TP.UP;
      k.log(`>>> touch ${act} ${x},${y}`);
      k.touch(action, x, y);
      res.end('ok');
    });
    return;
  }
  if (req.url === '/bt' && req.method === 'GET') {
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(phone.state())); return;
  }
  if (req.url === '/bt' && req.method === 'POST') {
    let body = '';
    req.on('data', d => (body += d));
    req.on('end', () => {
      try {
        const q = JSON.parse(body);
        switch (q.action) {
          case 'power': phone.power(); break;
          case 'connect': if (q.phone) phone.phoneName = String(q.phone); phone.connect(); break;
          case 'disconnect': phone.disconnect(); break;
          case 'incoming': phone.incoming(String(q.number || '')); break;
          case 'remoteAnswer': phone.remoteAnswer(); break;
          case 'remoteHangup': phone.remoteHangup(); break;
          case 'play': phone.setPlaying(true); break;
          case 'pause': phone.setPlaying(false); break;
          case 'track': phone.setTrack({ title: q.title || '', artist: q.artist || '', album: q.album || '' }); break;
          case 'line': phone.emit(String(q.line || '')); break;        // raw module line, for experiments
          default: throw new Error('unknown action ' + q.action);
        }
        res.end('ok');
      } catch (e) { res.statusCode = 400; res.end(String(e)); }
    });
    return;
  }
  if (req.url === '/mcu' && req.method === 'POST') {
    let body = '';
    req.on('data', d => (body += d));
    req.on('end', () => {
      try {
        const { cmd, data } = JSON.parse(body);
        const f = mcuFrame(cmd, data ?? []);
        const hex = f.map(b => b.toString(16).padStart(2, '0')).join(' ');
        const ok = k.uartPush('/dev/uart1', f);
        k.log(`>>> MCU inject ${hex}`);
        canLog.push(`MCU RX ${hex}${ok ? '' : '  (uart1 not open!)'}`); if (canLog.length > 60) canLog.shift();
        res.end(ok ? 'ok' : 'uart1 not open');
      } catch (e) { res.statusCode = 400; res.end(String(e)); }
    });
    return;
  }
  if (req.url === '/can' && req.method === 'POST') {
    let body = '';
    req.on('data', d => (body += d));
    req.on('end', () => {
      try {
        const { type, data } = JSON.parse(body);
        const f = canFrame(type, data ?? []);
        const hex = f.map(b => b.toString(16).padStart(2, '0')).join(' ');
        const ok = k.uartPush('/dev/uart3', f);
        k.log(`>>> CAN inject ${hex}${ok ? '' : ' (uart3 not open yet)'}`);
        canLog.push(`RX ${hex}${ok ? '' : '  (uart3 not open!)'}`); if (canLog.length > 60) canLog.shift();
        res.end(ok ? 'ok' : 'uart3 not open');
      } catch (e) { res.statusCode = 400; res.end(String(e)); }
    });
    return;
  }
  // Module side of Android Auto / CarPlay: {link: 6, status: 4} sends opcode 12 (status change),
  // {link, words: [opcode, ...]} sends a raw event to the callback init.axf registered.
  if (req.url === '/link' && req.method === 'POST') {
    let body = '';
    req.on('data', d => (body += d));
    req.on('end', () => {
      try {
        const { link, status, words } = JSON.parse(body);
        const ev: number[] = words ?? [12, status];
        const ok = k.linkEvent(link, ev);
        k.log(`>>> link ${link} event [${ev.join(', ')}]${ok ? '' : ' (no callback registered)'}`);
        res.end(ok ? 'ok' : `no callback for link_type ${link} (registered: ${[...k.linkCbs.keys()].join(', ') || 'none'})`);
      } catch (e) { res.statusCode = 400; res.end(String(e)); }
    });
    return;
  }
  // Debug: guest heap use (live allocations, highest address ever used)
  if (req.url === '/mem') {
    const kk = k as unknown as { allocs: Map<number, number>; heapTop: number };
    let live = 0; for (const v of kk.allocs.values()) live += v;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ live, peak: kk.heapTop - 0x4a000000, count: kk.allocs.size }));
    return;
  }
  if (req.url === '/linklog') { res.end(k.linkTx.join('\n')); return; }
  // Debug: read guest memory, e.g. /peek?addr=0xe932b210&len=8 (hex dump)
  if (req.url?.startsWith('/peek?')) {
    const q = new URLSearchParams(req.url.slice(6));
    try {
      const addr = Number(q.get('addr')), len = Math.min(Number(q.get('len') ?? 16), 4096);
      res.end(Buffer.from(k.mem.read(addr, len)).toString('hex'));
    } catch (e) { res.statusCode = 400; res.end(String(e)); }
    return;
  }
  // Debug: write guest memory, e.g. /poke?addr=0xe931da7c&hex=01000000
  if (req.url?.startsWith('/poke?') && req.method === 'POST') {
    const q = new URLSearchParams(req.url.slice(6));
    try {
      k.mem.write(Number(q.get('addr')), Buffer.from(q.get('hex') ?? '', 'hex'));
      k.cpu.invalidate();                       // the write may patch code
      res.end('ok');
    } catch (e) { res.statusCode = 400; res.end(String(e)); }
    return;
  }
  if (req.url === '/canlog') {
    const u = k.uarts.get('/dev/uart3');
    const tx = u ? u.dev.txLog.splice(0) : [];
    for (const t of tx) { canLog.push(`TX ${t}`); if (canLog.length > 60) canLog.shift(); }
    res.end(canLog.join('\n'));
    return;
  }
  res.statusCode = 404; res.end();
}).listen(port, '127.0.0.1', () => console.log(`EKIY emulator: http://localhost:${port}  (log: ${logFile})`));
server.on('upgrade', wsAccept);

pump();
