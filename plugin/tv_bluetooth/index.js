'use strict';

/*
 * TV Bluetooth - shows the Bluetooth A2DP input (TV / phone) in Volumio's "Now Playing"
 * and gives the touch screen a way to end the Bluetooth session.
 *
 * The audio itself is handled outside Volumio by bluetooth-audio-switch.service
 * (BlueZ + BlueALSA). This plugin only talks to its local API on 127.0.0.1:8090:
 *   GET  /api/events   server-sent events with a JSON state snapshot
 *   POST /api/release  end the Bluetooth session, DAC back to Volumio
 *   POST /api/player   AVRCP play/pause/next/previous (phones)
 *   POST /api/pair     open the pairing window
 */

var http = require('http');
var libQ;
try { libQ = require('kew'); } catch (e) { libQ = require('/volumio/node_modules/kew'); }

var SERVICE = 'tv_bluetooth';
var API_HOST = '127.0.0.1';
var API_PORT = 8090;
var BROWSE_URI = 'tvbluetooth';
var ICON_BASE = '/albumart?sourceicon=music_service/' + SERVICE + '/';

// UI texts; language follows Volumio's language setting (Polish or English)
var TEXTS = {
  en: {
    device: 'Device',
    playsToast: ' plays through the DAC. Pause/Stop = back to Volumio.',
    q: ['excellent', 'good', 'fair', 'weak'],
    signal: 'signal ',
    tvArtist: 'TV · Bluetooth',
    backHint: ' · ⏸ = back to Volumio',
    pairToast: 'Pairing open for 2 min. On your TV/phone select "{name}".',
    noService: 'Service bluetooth-audio-switch is not responding',
    playing: 'Playing: ',
    idle: 'DAC is used by Volumio',
    idleConnected: ' (Bluetooth device connected, silent)',
    end: 'End Bluetooth session and return to Volumio',
    take: 'Back to Bluetooth audio from ',
    pairOpen: 'Pairing open - select "{name}" on your device',
    pair: 'Pair a new device (2 min)',
    connected: ' · connected',
    untrusted: ' · not trusted',
    paired: 'Paired devices'
  },
  pl: {
    device: 'Urządzenie',
    playsToast: ' gra przez DAC. Pauza/Stop = powrót do Volumio.',
    q: ['bardzo dobry', 'dobry', 'średni', 'słaby'],
    signal: 'sygnał ',
    tvArtist: 'TV · Bluetooth',
    backHint: ' · ⏸ = powrót do Volumio',
    pairToast: 'Parowanie otwarte na 2 min. Na TV/telefonie wybierz urządzenie „{name}”.',
    noService: 'Usługa bluetooth-audio-switch nie odpowiada',
    playing: 'Gra: ',
    idle: 'DAC używa Volumio',
    idleConnected: ' (urządzenie BT połączone, cisza)',
    end: 'Zakończ sesję Bluetooth i wróć do Volumio',
    take: 'Wróć do dźwięku Bluetooth z: ',
    pairOpen: 'Parowanie otwarte — wybierz „{name}” na urządzeniu',
    pair: 'Sparuj nowe urządzenie (2 min)',
    connected: ' · połączone',
    untrusted: ' · niezaufane',
    paired: 'Sparowane urządzenia'
  }
};
var T = TEXTS.en;

module.exports = TvBluetooth;

function TvBluetooth(context) {
  this.context = context;
  this.commandRouter = context.coreCommand;
  this.logger = context.logger;
  this.snap = null;
  this.active = false;        // Volumio is in volatile mode for us
  this.ending = false;        // we are leaving volatile mode ourselves
  this.lastPushed = '';
  this.req = null;
  this.stopped = true;
}

// ------------------------------------------------------------- lifecycle ---

TvBluetooth.prototype.onVolumioStart = function () {
  return libQ.resolve();
};

TvBluetooth.prototype.getConfigurationFiles = function () {
  return [];
};

TvBluetooth.prototype.onStart = function () {
  this.stopped = false;
  try {
    var lang = String(this.commandRouter.sharedVars.get('language_code') || 'en').slice(0, 2);
    T = TEXTS[lang] || TEXTS.en;
  } catch (e) { T = TEXTS.en; }
  this.commandRouter.volumioAddToBrowseSources({
    name: 'Bluetooth audio',
    uri: BROWSE_URI,
    plugin_type: 'music_service',
    plugin_name: SERVICE,
    albumart: ICON_BASE + 'tv.png'
  });
  this.connectEvents();
  return libQ.resolve();
};

TvBluetooth.prototype.onStop = function () {
  this.stopped = true;
  if (this.req) { this.req.destroy(); this.req = null; }
  if (this.active) { this.leaveVolatile(); }
  this.commandRouter.volumioRemoveToBrowseSources('Bluetooth audio');
  return libQ.resolve();
};

// ---------------------------------------------------------------- daemon ---

TvBluetooth.prototype.connectEvents = function () {
  var self = this;
  if (self.stopped) { return; }
  var buf = '';
  var retry = function () {
    self.req = null;
    if (!self.stopped) { setTimeout(self.connectEvents.bind(self), 3000); }
  };
  self.req = http.get({ host: API_HOST, port: API_PORT, path: '/api/events' }, function (res) {
    res.setEncoding('utf8');
    res.on('data', function (chunk) {
      buf += chunk;
      var i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        var block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        block.split('\n').forEach(function (line) {
          if (line.indexOf('data: ') === 0) {
            try { self.onSnapshot(JSON.parse(line.slice(6))); } catch (e) {
              self.logger.error('[tv_bluetooth] bad event: ' + e);
            }
          }
        });
      }
    });
    res.on('end', retry);
    res.on('error', retry);
  });
  self.req.on('error', function (e) {
    if (self.req) { self.req.destroy(); }
    retry();
  });
};

TvBluetooth.prototype.api = function (path) {
  var defer = libQ.defer();
  var req = http.request({ host: API_HOST, port: API_PORT, path: path, method: 'POST', timeout: 15000 },
    function (res) {
      var body = '';
      res.setEncoding('utf8');
      res.on('data', function (c) { body += c; });
      res.on('end', function () {
        try { defer.resolve(JSON.parse(body)); } catch (e) { defer.resolve({}); }
      });
    });
  req.on('error', function (e) { defer.resolve({ ok: false, error: String(e) }); });
  req.on('timeout', function () { req.destroy(); });
  req.end();
  return defer.promise;
};

// ---------------------------------------------------------- state bridge ---

TvBluetooth.prototype.onSnapshot = function (s) {
  this.snap = s;
  if (s.mode === 'bt' && s.device) {
    if (!this.active) { this.enterVolatile(s); }
    this.pushMeta(s);
  } else if (this.active) {
    this.leaveVolatile();
  }
};

TvBluetooth.prototype.enterVolatile = function (s) {
  var self = this;
  var sm = self.commandRouter.stateMachine;
  self.active = true;
  self.lastPushed = '';
  var st = sm.getState();
  if (st && st.service && st.service !== SERVICE) {
    if (sm.isVolatile) { sm.unSetVolatile(); }   // another volatile source (e.g. AirPlay) stops
  }
  sm.setConsumeUpdateService(undefined);
  sm.setVolatile({ service: SERVICE, callback: self.onVolumioTookOver.bind(self) });
  var d = s.device || {};
  self.commandRouter.pushToastMessage('info', 'Bluetooth audio',
    (d.name || T.device) + T.playsToast);
  self.logger.info('[tv_bluetooth] volatile mode ON for ' + d.name);
};

// Volumio left volatile mode on its own: the user picked music or pressed stop
TvBluetooth.prototype.onVolumioTookOver = function () {
  if (this.ending) { return; }
  this.logger.info('[tv_bluetooth] Volumio took over - ending Bluetooth session');
  this.active = false;
  this.api('/api/release?source=volumio');
};

TvBluetooth.prototype.leaveVolatile = function () {
  var self = this;
  var sm = self.commandRouter.stateMachine;
  self.active = false;
  self.ending = true;
  try {
    if (sm.isVolatile && sm.volatileService === SERVICE) {
      sm.unSetVolatile();
      sm.resetVolumioState().then(function () {
        self.commandRouter.volumioStop();
      });
    } else if (sm.isVolatile && sm.volatileCallback) {
      // volatileService is cleared by syncState on 'stop' - still ours if nobody else set it
      sm.unSetVolatile();
      sm.resetVolumioState();
    }
  } finally {
    self.ending = false;
  }
  self.lastPushed = '';
  self.logger.info('[tv_bluetooth] volatile mode OFF - Volumio has the DAC');
};

// sig.rssi: BR/EDR RSSI relative to the golden receive range (0 = optimal, -N dB below it)
// sig.lq:   HCI link quality 0..255
function rssiLabel(sig) {
  if (!sig || sig.rssi === null || sig.rssi === undefined) { return null; }
  var r = sig.rssi;
  var q = T.q[r >= -2 ? 0 : r >= -8 ? 1 : r >= -16 ? 2 : 3];
  return T.signal + q + ' (' + r + ' dB' + (sig.lq !== null && sig.lq !== undefined ? ', LQ ' + sig.lq : '') + ')';
}

TvBluetooth.prototype.pushMeta = function (s) {
  var d = s.device || {};
  var p = s.player || {};
  var sbc = s.sbc || {};
  var rate = s.bt_rate || sbc.rate;
  var kbps = s.kbps || sbc.kbps;
  var quality = [rssiLabel(s.rssi),
    (s.codec || 'BT') + (kbps ? ' ' + kbps + ' kbps' : '')].filter(Boolean).join(' · ');
  var phone = d.kind === 'phone' || d.kind === 'computer';
  var hasTrack = phone && p && p.title;

  var obj = {
    status: phone && p.status === 'paused' ? 'pause' : 'play',
    service: SERVICE,
    title: hasTrack ? p.title : (d.name || 'Bluetooth'),
    artist: hasTrack ? (p.artist || d.name) : (phone ? d.name : T.tvArtist),
    album: hasTrack ? [p.album, d.name + ' · ' + quality].filter(Boolean).join(' — ')
                    : quality + (phone ? '' : T.backHint),
    albumart: hasTrack && (p.artist || p.album) ? this.albumArt(p.artist, p.album)
                                                 : ICON_BASE + (phone ? 'phone.png' : 'tv.png'),
    uri: 'tvbluetooth/now',
    trackType: (s.codec || 'bt').toLowerCase(),
    seek: hasTrack && p.position ? p.position : 0,
    duration: hasTrack && p.duration ? Math.round(p.duration / 1000) : 0,
    samplerate: rate ? (rate / 1000) + ' kHz' : '',
    bitdepth: (s.bits || 16) + ' bit',
    channels: 2,
    stream: !hasTrack,
    disableUiControls: false
  };
  var key = JSON.stringify(obj);
  if (key === this.lastPushed) { return; }
  this.lastPushed = key;
  this.commandRouter.servicePushState(obj, SERVICE);
};

// cover art looked up by Volumio's albumart plugin (web search by artist/album, cached)
TvBluetooth.prototype.albumArt = function (artist, album) {
  if (this.albumArtPlugin === undefined) {
    this.albumArtPlugin = this.commandRouter.pluginManager.getPlugin('miscellanea', 'albumart') || null;
  }
  if (!this.albumArtPlugin) { return ICON_BASE + 'phone.png'; }
  return this.albumArtPlugin.getAlbumArt({ artist: artist || '', album: album || '' }, '', 'fa-bluetooth');
};

// ------------------------------------------------------ playback controls ---

TvBluetooth.prototype.isPhone = function () {
  var d = this.snap && this.snap.device;
  return !!(d && (d.kind === 'phone' || d.kind === 'computer') && this.snap.player);
};

TvBluetooth.prototype.endSession = function (source) {
  this.logger.info('[tv_bluetooth] end session (' + source + ')');
  return this.api('/api/release?source=' + source);
};

TvBluetooth.prototype.stop = function () {
  return this.endSession('stop-button');
};

TvBluetooth.prototype.pause = function () {
  if (this.isPhone()) { return this.api('/api/player?cmd=pause'); }
  return this.endSession('pause-button');
};

TvBluetooth.prototype.play = function () {
  if (this.isPhone()) { return this.api('/api/player?cmd=play'); }
  return libQ.resolve();
};

TvBluetooth.prototype.resume = TvBluetooth.prototype.play;

TvBluetooth.prototype.next = function () {
  if (this.isPhone()) { return this.api('/api/player?cmd=next'); }
  return libQ.resolve();
};

TvBluetooth.prototype.previous = function () {
  if (this.isPhone()) { return this.api('/api/player?cmd=previous'); }
  return libQ.resolve();
};

TvBluetooth.prototype.seek = function () {
  return libQ.resolve();
};

// ----------------------------------------------------------- browse menu ---

function item(title, uri, icon, type) {
  return { service: SERVICE, type: type || 'folder', title: title, uri: uri, icon: icon };
}

TvBluetooth.prototype.handleBrowseUri = function (uri) {
  var self = this;
  var action = libQ.resolve();
  if (uri === BROWSE_URI + '/end') {
    action = self.endSession('browse-menu');
  } else if (uri === BROWSE_URI + '/pair') {
    action = self.api('/api/pair?sec=120').then(function () {
      self.commandRouter.pushToastMessage('success', 'Bluetooth audio',
        T.pairToast.replace('{name}', (self.snap && self.snap.adapter_name) || 'volumio'));
    });
  } else if (uri === BROWSE_URI + '/take') {
    action = self.api('/api/take');
  }
  return action.then(function () {
    return libQ.delay(uri === BROWSE_URI ? 0 : 600);
  }).then(function () {
    return self.browseRoot();
  });
};

TvBluetooth.prototype.browseRoot = function () {
  var s = this.snap || {};
  var d = s.device || {};
  var status;
  if (!this.snap) {
    status = T.noService;
  } else if (s.mode === 'bt') {
    status = T.playing + (d.name || '?') + ' · ' + (s.codec || '') +
      (s.bt_rate ? ' ' + s.bt_rate / 1000 + ' kHz' : '') + (rssiLabel(s.rssi) ? ' · ' + rssiLabel(s.rssi) : '');
  } else {
    status = T.idle + (s.tv_connected_idle ? T.idleConnected : '');
  }
  var actions = [item(status, BROWSE_URI, 'fa fa-info-circle', 'item-no-menu')];
  if (s.mode === 'bt') {
    actions.push(item(T.end, BROWSE_URI + '/end', 'fa fa-stop-circle'));
  }
  if (s.suppressed && s.suppressed.length) {
    actions.push(item(T.take + s.suppressed.join(', '), BROWSE_URI + '/take', 'fa fa-television'));
  }
  var name = s.adapter_name || 'volumio';
  actions.push(item(s.pairing_open ? T.pairOpen.replace('{name}', name) : T.pair, BROWSE_URI + '/pair', 'fa fa-bluetooth'));

  var devices = (s.devices || []).map(function (v) {
    return item(v.name + ' — ' + v.address + (v.connected ? T.connected : '') +
      (v.trusted ? '' : T.untrusted), BROWSE_URI, v.connected ? 'fa fa-link' : 'fa fa-bluetooth-b', 'item-no-menu');
  });
  var lists = [{ title: 'Bluetooth audio', icon: 'fa fa-bluetooth', availableListViews: ['list'], items: actions }];
  if (devices.length) {
    lists.push({ title: T.paired, icon: 'fa fa-list', availableListViews: ['list'], items: devices });
  }
  return libQ.resolve({ navigation: { prev: { uri: '/' }, lists: lists } });
};

// not a library source: nothing to explode/search
TvBluetooth.prototype.explodeUri = function () { return libQ.resolve([]); };
TvBluetooth.prototype.search = function () { return libQ.resolve([]); };
TvBluetooth.prototype.clearAddPlayTrack = function () { return libQ.resolve(); };
