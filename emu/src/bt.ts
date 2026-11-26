/**
 * Simulated phone + Bluetooth module (IVT-style text protocol, 8369HD).
 *
 * On this board the BT module sits behind the MCU: the app sends "AT#xx..." lines inside MCU frames with
 * command 0xD4 (02 80 d4 len text xor) and the module's replies come back the same way (02 81 d4 ...).
 * Replies are lines "<2-letter code><payload>\r\n"; fields inside a payload end with 0xFF.
 *
 *   module -> app                              app -> module
 *   IS            module ready                 AT#CE         answer
 *   IA / IB       phone disconnected / connected   AT#CF / CG  reject / hang up
 *   ID<number>    incoming call                AT#CW<number> dial
 *   IC<number>    outgoing call (dialing)      AT#MA / MB    play / pause
 *   IG            call active                  AT#MD / ME    next / previous track
 *   IF            call ended                   AT#PA         download phone book
 *   PB<name>ÿ<number>  phone book entry        AT#PH/PI/PJ   download dialed / received / missed calls
 *   PD<name>ÿ<number>  call history entry      AT#MM<name>   set the module name
 *   PC            end of a download
 *   MM<name>      module name (Pair: "Name")
 *   SA<name>      connected phone (Pair: right side)
 *   MB / MA       music playing / paused
 *   MI<title>ÿ<artist>ÿ<album>ÿ  track info
 */

export interface Contact { name: string; number: string }

const PB_STATE = 0xe93232f8;      // init.axf: which download runs (1/2/3 = dialed/received/missed calls)
const PB_COUNT = 0xe93232f4;
const PB_BUSY = 0xe93220bc;

export class BtPhone {
  ready = false;
  name = 'CAR-KIT_0000';          // module name (the app sets it with AT#MM)
  phoneName = 'Test Phone';
  connected = false;
  call: { dir: 'in' | 'out'; number: string; active: boolean } | null = null;
  contacts: Contact[] = [
    { name: 'Alex Example', number: '5550100' },
    { name: 'Sam Sample', number: '5550101' },
    { name: 'Robin Test', number: '5550102' },
    { name: 'Jordan Demo', number: '5550103' },
    { name: 'Car Service', number: '5550104' },
  ];
  history: { dialed: Contact[]; received: Contact[]; missed: Contact[] } = {
    dialed: [{ name: 'Alex Example', number: '5550100' }],
    received: [{ name: 'Sam Sample', number: '5550101' }],
    missed: [{ name: '', number: '5550199' }],
  };
  tracks = [
    { title: 'Bohemian Rhapsody', artist: 'Queen', album: 'A Night at the Opera' },
    { title: 'Hotel California', artist: 'Eagles', album: 'Hotel California' },
    { title: 'Africa', artist: 'Toto', album: 'Toto IV' },
  ];
  track = 0;
  playing = false;
  log: string[] = [];

  private rx: number[] = [];
  private out: string[] = [];
  private sending = false;

  private push: (bytes: number[]) => boolean;
  private poke: (addr: number, value: number) => void;

  constructor(push: (bytes: number[]) => boolean, poke: (addr: number, value: number) => void) {
    this.push = push; this.poke = poke;
  }

  // ---- app -> module ------------------------------------------------------------------------------
  /** Bytes the app wrote to /dev/uart1 (MCU frames); only command 0xD4 is ours. */
  feed(bytes: number[]): void {
    this.rx.push(...bytes);
    for (;;) {
      const s = this.rx.indexOf(0x02);
      if (s < 0) { this.rx = []; return; }
      if (s) this.rx.splice(0, s);
      if (this.rx.length < 5) return;
      const len = this.rx[3];
      if (this.rx.length < 5 + len) return;
      const frame = this.rx.splice(0, 5 + len);
      if (frame[2] !== 0xd4) continue;
      const text = Buffer.from(frame.slice(4, 4 + len)).toString('latin1');
      for (const line of text.split('\r\n')) if (line) this.command(line);
    }
  }

  private command(line: string): void {
    this.note(`→ ${line}`);
    const cmd = line.slice(0, 5), arg = line.slice(5);
    switch (cmd) {
      case 'AT#CE':                                    // answer
        if (this.call?.dir === 'in' && !this.call.active) { this.call.active = true; this.emit('IG'); }
        break;
      case 'AT#CF': case 'AT#CG':                      // reject / hang up
        if (this.call) this.endCall();
        break;
      case 'AT#CW':                                    // dial
        if (!this.connected || !arg) break;
        this.call = { dir: 'out', number: arg, active: false };
        this.remember('dialed', arg);
        this.emit('IC' + arg);
        setTimeout(() => { if (this.call?.dir === 'out' && !this.call.active) { this.call.active = true; this.emit('IG'); } }, 2500);
        break;
      case 'AT#MM': if (arg) this.name = arg; this.emit('MM' + this.name); break;
      case 'AT#MA': this.setPlaying(true); break;
      case 'AT#MB': this.setPlaying(false); break;
      case 'AT#MD': this.skip(1); break;
      case 'AT#ME': this.skip(-1); break;
      case 'AT#PA': this.sendBook(); break;
      case 'AT#PH': this.sendHistory('dialed'); break;
      case 'AT#PI': this.sendHistory('received'); break;
      case 'AT#PJ': this.sendHistory('missed'); break;
    }
  }

  // ---- phone actions (simulator panel) -----------------------------------------------------------------
  power(): void { this.ready = true; this.emit('IS'); }

  connect(): void {
    if (!this.ready) this.power();
    this.connected = true;
    this.emit('IB');
    this.emit('SA' + this.phoneName);
    // the call lists come after connecting (the app asks for received / missed itself); the phone book only
    // when the app asks for it (AT#PA, sent when searching in Contacts)
    setTimeout(() => {
      this.poke(PB_STATE, 1); this.poke(PB_COUNT, 0); this.poke(PB_BUSY, 0);
      this.sendHistory('dialed');
    }, 1500);
  }

  disconnect(): void {
    if (this.call) this.endCall();
    this.connected = false; this.playing = false;
    this.emit('MY'); this.emit('IA'); this.emit('SA');
  }

  incoming(number: string): void {
    if (!this.connected || this.call) return;
    this.call = { dir: 'in', number, active: false };
    this.emit('ID' + number);
  }

  /** answered / hung up on the phone itself */
  remoteAnswer(): void { if (this.call && !this.call.active) { this.call.active = true; this.emit('IG'); } }
  remoteHangup(): void { if (this.call) this.endCall(); }

  setPlaying(on: boolean): void {
    if (!this.connected) return;
    this.playing = on;
    this.emit(on ? 'MB' : 'MA');
    if (on) this.sendTrack();
  }

  skip(d: number): void {
    if (!this.connected) return;
    this.track = (this.track + d + this.tracks.length) % this.tracks.length;
    this.sendTrack();
  }

  setTrack(t: { title: string; artist: string; album: string }): void {
    this.tracks[this.track] = t;
    if (this.connected) this.sendTrack();
  }

  // ---- module -> app --------------------------------------------------------------------------------
  private endCall(): void {
    const c = this.call!;
    if (c.dir === 'in') this.remember(c.active ? 'received' : 'missed', c.number);
    this.call = null;
    this.emit('IF');
  }

  private remember(list: 'dialed' | 'received' | 'missed', number: string): void {
    const name = this.contacts.find(c => c.number === number)?.name ?? '';
    this.history[list].unshift({ name, number });
  }

  private sendTrack(): void {
    const t = this.tracks[this.track];
    this.emit(`MI${t.title}\xff${t.artist}\xff${t.album}\xff`);
  }

  private sendBook(): void {
    for (const c of this.contacts) this.emit(`PB${c.name}\xff${c.number}`);
    this.emit('PC');
  }

  private sendHistory(list: 'dialed' | 'received' | 'missed'): void {
    for (const c of this.history[list]) this.emit(`PD${c.name}\xff${c.number}`);
    this.emit('PC');
  }

  /** queue a reply line; lines go out ~60 ms apart like a real module */
  emit(line: string): void {
    this.out.push(line);
    if (!this.sending) this.drain();
  }

  private drain(): void {
    const line = this.out.shift();
    if (line === undefined) { this.sending = false; return; }
    this.sending = true;
    // text in UTF-8 like a phone sends it; the 0xFF field separators stay single raw bytes
    const data = [...Buffer.concat(line.split('\xff').flatMap((part, i) => i ? [Buffer.from([0xff]), Buffer.from(part)] : [Buffer.from(part)])),
                  0x0d, 0x0a];
    if (data.length > 250) data.splice(248, data.length - 250);   // one length byte per MCU frame
    const body = [0x81, 0xd4, data.length, ...data];
    this.push([0x02, ...body, body.reduce((a, b) => a ^ b, 0)]);
    this.note(`← ${line.replace(/\xff/g, '|')}`);
    setTimeout(() => this.drain(), 60);
  }

  private note(s: string): void { this.log.push(s); if (this.log.length > 80) this.log.shift(); }

  state() {
    return { ready: this.ready, connected: this.connected, name: this.name, phoneName: this.phoneName, call: this.call, playing: this.playing,
             track: this.tracks[this.track], contacts: this.contacts, history: this.history, log: this.log };
  }
}
