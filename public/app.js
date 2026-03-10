/* ──────────────────────────────────────────────────────────────────────────── *
 *  RC Controller – Frontend                                                    *
 *  • Gamepad API: đọc TX RadioMaster (EdgeTX) qua USB / Bluetooth             *
 *  • Video: MJPEG img / HLS video / WebRTC                                     *
 *  • MQTT qua Socket.io                                                        *
 *  ⚠ Điều khiển chỉ qua TX (Gamepad API) – bàn phím đã bị tắt               *
 * ──────────────────────────────────────────────────────────────────────────── */

const socket = io();

// ── State ──────────────────────────────────────────────────────────────────────
const state = {
  direction: 'stop',
  speed: 50,
  // Gamepad (HID)
  gamepadIndex: null,
  gamepadLoopId: null,
  // Serial
  serialPort: null,
  serialReader: null,
  serialConnected: false,
  videoUrl: '',
  videoType: 'mjpeg',
};

// ── DOM refs ───────────────────────────────────────────────────────────────────
const mqttDot    = document.getElementById('mqttDot');
const mqttLabel  = document.getElementById('mqttLabel');
const gamepadDot = document.getElementById('gamepadDot');
const gamepadLbl = document.getElementById('gamepadLabel');
const serialDot  = document.getElementById('serialDot');
const serialLbl  = document.getElementById('serialLabel');
const arrowChev  = document.getElementById('arrowChevron');
const logList    = document.getElementById('logList');
const settingsOverlay = document.getElementById('settingsOverlay');

// Video refs
const imgFeed        = document.getElementById('imgFeed');
const videoFeed      = document.getElementById('videoFeed');
const videoNoSignal  = document.getElementById('videoNoSignal');
const hudDir         = document.getElementById('hudDir');
const hudSpd         = document.getElementById('hudSpd');
const hudMqtt        = document.getElementById('hudMqtt');
const txStatus       = document.getElementById('txStatus');

// Channel value refs
const chRefs = [1,2,3,4,5,6].map(i => document.getElementById(`ch${i}Val`));

// Direction → display config
const DIR_CONFIG = {
  stop:            { label: 'STOP',     arrow: '■',  leds: ['ledStop']                   },
  forward:         { label: 'FORWARD',  arrow: '▲',  leds: ['ledForward']                },
  backward:        { label: 'BACKWARD', arrow: '▼',  leds: ['ledBackward']               },
  left:            { label: 'LEFT',     arrow: '◀',  leds: ['ledLeft']                   },
  right:           { label: 'RIGHT',    arrow: '▶',  leds: ['ledRight']                  },
  'forward-left':  { label: 'FWD-L',    arrow: '↖',  leds: ['ledForward','ledLeft']      },
  'forward-right': { label: 'FWD-R',    arrow: '↗',  leds: ['ledForward','ledRight']     },
  'backward-left': { label: 'BWD-L',    arrow: '↙',  leds: ['ledBackward','ledLeft']     },
  'backward-right':{ label: 'BWD-R',    arrow: '↘',  leds: ['ledBackward','ledRight']    },
};

// ── Utility: log ──────────────────────────────────────────────────────────────
function addLog(type, text, extra = '') {
  const li   = document.createElement('li');
  const ts   = new Date().toLocaleTimeString('vi-VN', { hour12: false });
  li.innerHTML = `<span class="log-ts">${ts}</span>
                  <span class="log-${type}">${text}</span>
                  <span class="log-speed">${extra}</span>`;
  logList.prepend(li);
  while (logList.children.length > 60) logList.removeChild(logList.lastChild);
}

// ── Utility: update direction UI ─────────────────────────────────────────────
function updateDirectionUI(dir) {
  const cfg = DIR_CONFIG[dir] || DIR_CONFIG.stop;
  if (hudDir) hudDir.textContent = cfg.label;
  arrowChev.textContent = cfg.arrow;
  arrowChev.classList.toggle('active', dir !== 'stop');
  document.querySelectorAll('.led').forEach(l => l.classList.remove('active'));
  cfg.leds.forEach(id => document.getElementById(id)?.classList.add('active'));
}

// ── Utility: update speed UI ──────────────────────────────────────────────────
function updateSpeedUI(spd) {
  state.speed = spd;
  if (hudSpd) hudSpd.textContent = spd + '%';
}

// ── Emit control to server ────────────────────────────────────────────────────
let lastEmitKey = '';
function emitControl(direction, speed) {
  const key = `${direction}:${speed}`;
  if (key === lastEmitKey) return;
  lastEmitKey = key;
  state.direction = direction;
  state.speed     = speed;
  socket.emit('control', { direction, speed });
  updateDirectionUI(direction);
  updateSpeedUI(speed);
}

// ── Clear log ─────────────────────────────────────────────────────────────────
document.getElementById('btnClear').addEventListener('click', () => { logList.innerHTML = ''; });

// ── Settings panel ────────────────────────────────────────────────────────────
document.getElementById('btnSettings').addEventListener('click', () => {
  settingsOverlay.hidden = false;
});
document.getElementById('btnCancel').addEventListener('click', () => {
  settingsOverlay.hidden = true;
});
document.getElementById('btnApply').addEventListener('click', () => {
  const host = document.getElementById('cfgHost').value.trim() || 'broker.hivemq.com';
  const port = document.getElementById('cfgPort').value.trim() || '1883';
  const user = document.getElementById('cfgUser').value.trim();
  const pass = document.getElementById('cfgPass').value.trim();
  socket.emit('set_broker', { host, port, username: user, password: pass });
  if (hudMqtt) { hudMqtt.textContent = '●'; }
  addLog('pub', `Broker → ${host}:${port}`, '');
  // Video
  const vurl  = document.getElementById('cfgVideoUrl').value.trim();
  const vtype = document.getElementById('cfgVideoType').value;
  if (vurl) applyVideoSource(vurl, vtype);
  settingsOverlay.hidden = true;
});
settingsOverlay.addEventListener('click', e => {
  if (e.target === settingsOverlay) settingsOverlay.hidden = true;
});

// ── Video source ───────────────────────────────────────────────────────────────
function applyVideoSource(url, type) {
  state.videoUrl  = url;
  state.videoType = type;
  imgFeed.style.display       = 'none';
  videoFeed.style.display     = 'none';
  videoNoSignal.style.display = 'none';
  if (type === 'mjpeg') {
    imgFeed.src = url;
    imgFeed.style.display = 'block';
    imgFeed.onerror = () => showNoSignal();
  } else {
    videoFeed.src = url;
    videoFeed.style.display = 'block';
    videoFeed.play().catch(() => showNoSignal());
    videoFeed.onerror = () => showNoSignal();
  }
  addLog('pub', `Video → ${type.toUpperCase()} ${url}`, '');
}

function showNoSignal() {
  imgFeed.style.display       = 'none';
  videoFeed.style.display     = 'none';
  videoNoSignal.style.display = 'flex';
}

// ── Gamepad API (EdgeTX TX via USB HID) ────────────────────────────────────────
// EdgeTX standard HID: axes[0]=Roll, axes[1]=Pitch, axes[2]=Thr, axes[3]=Yaw
const DEADZONE = 0.05;

function startGamepadLoop() {
  if (state.gamepadLoopId) cancelAnimationFrame(state.gamepadLoopId);
  let lastPayloadStr = '';

  function loop() {
    const gamepads = navigator.getGamepads();
    const gp = gamepads[state.gamepadIndex];
    if (!gp) { stopGamepadLoop(); return; }

    const axes    = Array.from(gp.axes).slice(0, 6).map(v => parseFloat(v.toFixed(4)));
    const buttons = Array.from(gp.buttons).slice(0, 12).map(b => (b.pressed ? 1 : 0));
    // Map -1..1 → 1000..2000 (PWM range)
    const channels = axes.map(v => Math.round(((v + 1) / 2) * 1000 + 1000));

    // Update channel strip
    axes.forEach((v, i) => { if (chRefs[i]) chRefs[i].textContent = channels[i]; });

    // Derive direction from Roll(0) and Pitch(1)
    const roll  = axes[0] ?? 0;
    const pitch = axes[1] ?? 0; // -1 = stick forward on TX
    const fwd = pitch < -DEADZONE, bwd = pitch > DEADZONE;
    const lft = roll  < -DEADZONE, rgt = roll  > DEADZONE;
    let dir = 'stop';
    if      (fwd && lft) dir = 'forward-left';
    else if (fwd && rgt) dir = 'forward-right';
    else if (bwd && lft) dir = 'backward-left';
    else if (bwd && rgt) dir = 'backward-right';
    else if (fwd)        dir = 'forward';
    else if (bwd)        dir = 'backward';
    else if (lft)        dir = 'left';
    else if (rgt)        dir = 'right';

    // Throttle from axes[2]: -1..1 → 0..100
    const thr = axes[2] !== undefined
      ? Math.round(((axes[2] + 1) / 2) * 100)
      : state.speed;

    emitControl(dir, thr);

    // Publish to MQTT (only on change)
    const payloadStr = JSON.stringify({ channels, buttons, dir, thr });
    if (payloadStr !== lastPayloadStr) {
      socket.emit('gamepad', { channels, buttons, axes, dir, thr, ts: Date.now() });
      lastPayloadStr = payloadStr;
    }

    state.gamepadLoopId = requestAnimationFrame(loop);
  }
  state.gamepadLoopId = requestAnimationFrame(loop);
}

function stopGamepadLoop() {
  if (state.gamepadLoopId) { cancelAnimationFrame(state.gamepadLoopId); state.gamepadLoopId = null; }
  state.gamepadIndex = null;
  gamepadDot.classList.remove('online');
  gamepadLbl.textContent = 'TX: –';
  if (txStatus) { txStatus.textContent = 'NOT CONNECTED'; txStatus.classList.remove('tx-ok'); }
  addLog('err', 'TX Disconnected', '');
}

window.addEventListener('gamepadconnected', (e) => {
  state.gamepadIndex = e.gamepad.index;
  gamepadDot.classList.add('online');
  gamepadLbl.textContent = `TX: ${e.gamepad.id.substring(0, 22)}`;
  if (txStatus) { txStatus.textContent = 'CONNECTED'; txStatus.classList.add('tx-ok'); }
  addLog('pub', `TX Connected: ${e.gamepad.id}`,
         `axes:${e.gamepad.axes.length} btns:${e.gamepad.buttons.length}`);
  startGamepadLoop();
});

window.addEventListener('gamepaddisconnected', (e) => {
  if (e.gamepad.index === state.gamepadIndex) stopGamepadLoop();
});

// ── Web Serial API – TX via USB Serial (CRSF / EdgeTX) ────────────────────────
// CRSF frame: [0xC8][len][type 0x16][22 bytes packed channels][CRC8]
// 16 ch × 11-bit packed → 22 bytes. Range: 172(min)–992(ctr)–1811(max)

const CRSF_SYNC    = 0xC8;
const CRSF_CH_TYPE = 0x16;
const CRC8_POLY    = 0xD5;

function crc8(buf, offset, len) {
  let crc = 0;
  for (let i = offset; i < offset + len; i++) {
    crc ^= buf[i];
    for (let b = 0; b < 8; b++)
      crc = (crc & 0x80) ? ((crc << 1) ^ CRC8_POLY) & 0xFF : (crc << 1) & 0xFF;
  }
  return crc;
}

function parseCRSFChannels(data, frameStart) {
  // data[frameStart]   = CRSF_SYNC (0xC8)
  // data[frameStart+1] = payload len (includes type+crc, so 24 for RC frame)
  // data[frameStart+2] = type (0x16)
  // data[frameStart+3..24] = 22 bytes packed channels
  // data[frameStart+25] = CRC8 over bytes [type..last_channel]
  const payloadLen = data[frameStart + 1]; // e.g. 24
  const frameLen   = 2 + payloadLen;       // sync + len + payload
  if (frameStart + frameLen > data.length) return null; // incomplete

  const crcCalc = crc8(data, frameStart + 2, payloadLen - 1);
  const crcRecv = data[frameStart + 2 + payloadLen - 1];
  if (crcCalc !== crcRecv) return null; // bad CRC

  const p = frameStart + 3; // start of channel bytes
  // Unpack 16 × 11-bit values (little-endian bit order)
  const ch = new Array(16);
  let bitPos = 0;
  for (let i = 0; i < 16; i++) {
    const byteIdx = Math.floor(bitPos / 8);
    const bitIdx  = bitPos % 8;
    let val = (data[p + byteIdx] >> bitIdx) | (data[p + byteIdx + 1] << (8 - bitIdx));
    if (bitIdx > 5) val |= (data[p + byteIdx + 2] << (16 - bitIdx));
    ch[i] = val & 0x7FF;
    bitPos += 11;
  }
  return { ch, frameLen };
}

function crsfToMicros(v) { return Math.round(((v - 172) / (1811 - 172)) * 1000 + 1000); }
function crsfToPct(v)    { return Math.round(((v - 172) / (1811 - 172)) * 100); }

async function serialConnect() {
  if (!('serial' in navigator)) {
    addLog('err', 'Web Serial API không được hỗ trợ', 'Dùng Chrome/Edge ≥ 89');
    return;
  }
  // If already connected – disconnect
  if (state.serialConnected) {
    await serialDisconnect();
    return;
  }
  try {
    const port = await navigator.serial.requestPort();
    await port.open({ baudRate: 420000 }); // EdgeTX USB serial default
    state.serialPort = port;
    state.serialConnected = true;

    serialDot.classList.add('online');
    serialLbl.textContent = 'Disconnect';
    document.getElementById('btnSerial').classList.add('connected');
    addLog('pub', 'Serial kết nối', `baud:420000`);

    // Read loop
    const reader = port.readable.getReader();
    state.serialReader = reader;
    const buf = [];

    (async () => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const byte of value) buf.push(byte);

          // Scan buffer for CRSF frames
          let i = 0;
          while (i < buf.length - 2) {
            if (buf[i] !== CRSF_SYNC) { i++; continue; }
            if (buf[i + 2] !== CRSF_CH_TYPE) { i++; continue; }
            const payLen = buf[i + 1];
            if (i + 2 + payLen > buf.length) break; // wait for more data

            const arr  = new Uint8Array(buf.slice(i, i + 2 + payLen));
            const result = parseCRSFChannels(arr, 0);
            if (result) {
              const { ch } = result;
              // Update channel strip (first 6 channels)
              ch.slice(0, 6).forEach((v, idx) => {
                if (chRefs[idx]) chRefs[idx].textContent = crsfToMicros(v);
              });

              // Derive direction from CH1(Roll) CH2(Pitch) - AETR layout
              const roll  = crsfToPct(ch[0]) - 50; // -50..+50
              const pitch = crsfToPct(ch[1]) - 50; // negative = forward
              const thr   = crsfToPct(ch[2]);       // 0..100

              const DZ = 15;
              const fwd = pitch < -DZ, bwd = pitch > DZ;
              const lft = roll  < -DZ, rgt = roll  > DZ;
              let dir = 'stop';
              if      (fwd && lft) dir = 'forward-left';
              else if (fwd && rgt) dir = 'forward-right';
              else if (bwd && lft) dir = 'backward-left';
              else if (bwd && rgt) dir = 'backward-right';
              else if (fwd)        dir = 'forward';
              else if (bwd)        dir = 'backward';
              else if (lft)        dir = 'left';
              else if (rgt)        dir = 'right';

              emitControl(dir, thr);

              const channels = ch.slice(0, 16).map(crsfToMicros);
              socket.emit('gamepad', {
                channels, axes: ch.slice(0, 6).map(v => ((v - 992) / 819).toFixed(4)),
                dir, thr, source: 'serial', ts: Date.now(),
              });

              i += 2 + payLen;
            } else {
              i++; // bad CRC, skip
            }
            buf.splice(0, i);
            i = 0;
          }
        }
      } catch (err) {
        if (state.serialConnected) addLog('err', 'Serial read error', err.message);
      } finally {
        serialDisconnect();
      }
    })();

  } catch (err) {
    if (err.name !== 'NotFoundError') // user cancelled
      addLog('err', 'Serial error', err.message);
  }
}

async function serialDisconnect() {
  state.serialConnected = false;
  try { await state.serialReader?.cancel(); } catch (_) {}
  try { await state.serialPort?.close();   } catch (_) {}
  state.serialReader = null;
  state.serialPort   = null;
  serialDot.classList.remove('online');
  serialLbl.textContent = 'Serial';
  document.getElementById('btnSerial').classList.remove('connected');
  addLog('err', 'Serial ngắt kết nối', '');
}

document.getElementById('btnSerial').addEventListener('click', serialConnect);

// ── Socket.io events ──────────────────────────────────────────────────────────
socket.on('mqtt_status', ({ connected, broker, error }) => {
  mqttDot.classList.toggle('online', connected);
  mqttLabel.textContent = connected
    ? `Connected – ${broker}`
    : error ? `Error: ${error}` : 'Disconnected';
  if (hudMqtt) {
    hudMqtt.textContent = connected ? '●' : '○';
    hudMqtt.style.color = connected ? '#00e676' : '#ff3d71';
  }
  addLog(connected ? 'pub' : 'err',
         connected ? `MQTT OK – ${broker}` : `MQTT DISC`,
         error || '');
});

socket.on('control_echo', ({ direction, speed, timestamp }) => {
  addLog('dir',
    `→ ${(direction || 'stop').toUpperCase()}`,
    `spd=${speed}%  ts=${timestamp}`
  );
});

socket.on('mqtt_message', ({ topic, payload }) => {
  let txt = typeof payload === 'object' ? JSON.stringify(payload) : payload;
  addLog('pub', `[${topic}]`, txt);
});

// ── Init ──────────────────────────────────────────────────────────────────────
updateDirectionUI('stop');
updateSpeedUI(50);


