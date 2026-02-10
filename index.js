'use strict';
const os            = require('os');
const util          = require('util');
const EventEmitter  = require('events');

let usb = null;

const IFACE_CLASS = {
  AUDIO  : 0x01,
  HID    : 0x03,
  PRINTER: 0x07,
  HUB    : 0x09
};

function USB(vid, pid) {
  if (!usb) usb = require('usb');

  EventEmitter.call(this);

  var self = this;

  this.device = null;
  this.endpoint = null;            // OUT endpoint
  this.deviceToPcEndpoint = null;  // IN endpoint

  this._isOpen = false;
  this._isClosing = false;

  // NEW: flags to prevent deadlocks / parallel ops
  this._isResetting = false;
  this._readInFlight = false;

  // pick device
  if (vid && pid) {
    this.device = usb.findByIds(vid, pid);
  } else if (vid) {
    this.device = vid;
  } else {
    var devices = USB.findPrinter();
    if (devices && devices.length) this.device = devices[0];
  }

  // IMPORTANT: keep references so we can removeListener() later
  this._onDetach = function (device) {
    if (device === self.device) {
      self._isOpen = false;
      self.endpoint = null;
      self.deviceToPcEndpoint = null;

      self.emit('detach', device);
      self.emit('disconnect', device);

      self.device = null;
    }
  };

  this._onAttach = function (device) {
    if (!self.device) {
      var devices = USB.findPrinter();
      if (devices && devices.length) self.device = devices[0];
    }

    if (device === self.device) {
      self.emit('attach', device);
    }
  };

  usb.on('detach', this._onDetach);
  usb.on('attach', this._onAttach);

  return this;
}

USB.findPrinter = function () {
  if (!usb) usb = require('usb');

  return usb.getDeviceList().filter(function (device) {
    try {
      return device.configDescriptor.interfaces.filter(function (iface) {
        return iface.filter(function (conf) {
          return conf.bInterfaceClass === IFACE_CLASS.PRINTER;
        }).length;
      }).length;
    } catch (e) {
      return false;
    }
  });
};

USB.getDevice = function (vid, pid) {
  return new Promise(function (resolve, reject) {
    const device = new USB(vid, pid);
    device.open(function (err) {
      if (err) return reject(err);
      resolve(device);
    });
  });
};

util.inherits(USB, EventEmitter);

USB.prototype.open = function (callback) {
  var self = this;
  var counter = 0;

  if (this._isResetting) {
    callback && callback(new Error('USB is resetting'));
    return this;
  }

  // no device
  if (!this.device) {
    callback && callback(new Error('No USB printer device found'));
    return this;
  }

  // already open
  if (this._isOpen) {
    callback && callback(null, this);
    return this;
  }

  try {
    this.device.open();
  } catch (e) {
    callback && callback(e);
    return this;
  }

  try {
    this.device.interfaces.forEach(function (iface) {
      (function (iface) {
        iface.setAltSetting(iface.altSetting, function () {
          try {
            if ("win32" !== os.platform()) {
              if (iface.isKernelDriverActive()) {
                try { iface.detachKernelDriver(); } catch (e) {}
              }
            }

            iface.claim();

            let outEp = null;
            let inEp = null;

            iface.endpoints.forEach(function (ep) {
              if (ep.direction === 'out' && !outEp) outEp = ep;
              if (ep.direction === 'in' && !inEp) inEp = ep;
            });

            // uzmi endpoint-e samo ako su OBA na ISTOM interfejsu
            if (outEp && inEp && !self.endpoint && !self.deviceToPcEndpoint) {
              self.endpoint = outEp;
              self.deviceToPcEndpoint = inEp;

              // timeouts
              try { self.endpoint.timeout = 15000; } catch (e) {}
              try { self.deviceToPcEndpoint.timeout = 700; } catch (e) {}

              self._isOpen = true;
              self._isClosing = false;
              self.emit('connect', self.device);
              callback && callback(null, self);
              return; // bitno da ne nastavlja dalje
            }

            // ako smo prošli sve iface-ove a nismo našli par
            if (++counter === self.device.interfaces.length && !self.endpoint) {
              callback && callback(new Error('Can not find endpoint pair (in+out) from printer'));
            }
          } catch (e) {
            callback && callback(e);
          }
        });
      })(iface);
    });
  } catch (e) {
    callback && callback(e);
  }

  return this;
};

USB.prototype.write = function (data, callback) {
  if (this._isResetting || this._isClosing) {
    callback && callback(new Error('USB busy (reset/close)'));
    return this;
  }

  if (!this.endpoint) {
    callback && callback(new Error('USB endpoint not ready'));
    return this;
  }

  this.emit('data', data);

  try {
    this.endpoint.transfer(data, (err) => {
      if (err) {
        try { this.emit('error', err); } catch (e) {}
      }
      callback && callback(err);
    });
    
  } catch (e) {
    callback && callback(e);
  }

  return this;
};

/**
 * READ FIX:
 * - read small amount (8 bytes) because statuses are 1-4 bytes
 * - hard timeout to avoid forever-wait in JS
 * - no parallel reads
 */
USB.prototype.read = function (callback) {
  // Guard: device is resetting or closing – same as write()
  if (this._isResetting || this._isClosing) {
    callback && callback(new Error('USB busy (reset/close)'));
    return this;
  }

  if (!this.deviceToPcEndpoint) {
    callback && callback(null, Buffer.alloc(0));
    return this;
  }

  // Guard: prevent parallel IN transfers (deadlock / corruption)
  if (this._readInFlight) {
    callback && callback(new Error('USB read already in progress'));
    return this;
  }

  this._readInFlight = true;
  var self = this;

  try {
    this.deviceToPcEndpoint.transfer(8, function (err, data) {
      self._readInFlight = false;
      if (err) {
        return callback && callback(err, Buffer.alloc(0));
      }
      var buf = (data && Buffer.isBuffer(data)) ? data : Buffer.alloc(0);
      callback && callback(null, buf);
    });
  } catch (e) {
    this._readInFlight = false;
    callback && callback(e, Buffer.alloc(0));
  }
  return this;
};

/**
 * HARD USB RESET (software "pull the cable")
 * - sets _isResetting so read/write won't run
 * - clears endpoints so upper layer must reopen
 */
USB.prototype.reset = function (callback) {
  if (!this.device) {
    callback && callback(new Error('No device to reset'));
    return this;
  }

  if (this._isResetting) {
    callback && callback(null);
    return this;
  }

  this._isResetting = true;

  try {
    this.device.reset((err) => {
      this._isResetting = false;
      this._readInFlight = false;

      // After reset, endpoints are not reliable -> force reopen later
      this._isOpen = false;
      this.endpoint = null;
      this.deviceToPcEndpoint = null;

      callback && callback(err || null);
    });
  } catch (e) {
    this._isResetting = false;
    this._readInFlight = false;
    callback && callback(e);
  }

  return this;
};

USB.prototype.close = function (callback) {
  // idempotent close (prevents native abort)
  if (this._isClosing) {
    callback && callback(null);
    return this;
  }
  this._isClosing = true;

  if (!this.device || !this._isOpen) {
    this._isOpen = false;
    this.endpoint = null;
    this.deviceToPcEndpoint = null;
    this._isClosing = false;
    callback && callback(null);
    return this;
  }

  try {
    this.device.close();
  } catch (e) {
    // ignore
  }

  this._isOpen = false;
  this._readInFlight = false;
  this.endpoint = null;
  this.deviceToPcEndpoint = null;
  this._isClosing = false;

  callback && callback(null);
  this.emit('close', this.device);

  return this;
};

/**
 * IMPORTANT for "new instance" strategy:
 * - removes global usb attach/detach listeners to avoid leaks + double events
 * - best effort close
 */
USB.prototype.destroy = function () {
  try {
    if (usb && this._onDetach) usb.removeListener('detach', this._onDetach);
    if (usb && this._onAttach) usb.removeListener('attach', this._onAttach);
  } catch (e) {}

  this._onDetach = null;
  this._onAttach = null;

  try {
    this.close(() => {});
  } catch (e) {}

  this.device = null;
  this.endpoint = null;
  this.deviceToPcEndpoint = null;
};

module.exports = USB;
