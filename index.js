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
  this.endpoint = null;
  this.deviceToPcEndpoint = null;

  this._isOpen = false;
  this._isClosing = false;

  if (vid && pid) {
    this.device = usb.findByIds(vid, pid);
  } else if (vid) {
    this.device = vid;
  } else {
    var devices = USB.findPrinter();
    if (devices && devices.length) this.device = devices[0];
  }

  usb.on('detach', function (device) {
    if (device === self.device) {
      self._isOpen = false;
      self.endpoint = null;
      self.deviceToPcEndpoint = null;

      self.emit('detach', device);
      self.emit('disconnect', device);

      self.device = null;
    }
  });

  usb.on('attach', function (device) {
    if (!self.device) {
      var devices = USB.findPrinter();
      if (devices && devices.length) self.device = devices[0];
    }

    if (device === self.device) {
      self.emit('attach', device);
    }
  });

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

  // KLJUČNO: nema device-a → nema open()
  if (!this.device) {
    callback && callback(new Error('No USB printer device found'));
    return this;
  }

  // već otvoren
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

            iface.endpoints.filter(function (endpoint) {
              if (endpoint.direction === 'out' && !self.endpoint) self.endpoint = endpoint;
              if (endpoint.direction === 'in' && !self.deviceToPcEndpoint) self.deviceToPcEndpoint = endpoint;
            });

            if (self.endpoint) {
              self._isOpen = true;
              self._isClosing = false;
              self.emit('connect', self.device);
              callback && callback(null, self);
            } else if (++counter === self.device.interfaces.length && !self.endpoint) {
              callback && callback(new Error('Can not find endpoint from printer'));
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
  if (!this.endpoint) {
    callback && callback(new Error('USB endpoint not ready'));
    return this;
  }
  this.emit('data', data);
  try {
    this.endpoint.transfer(data, callback);
  } catch (e) {
    callback && callback(e);
  }
  return this;
};

USB.prototype.read = function (callback) {
  if (!this.deviceToPcEndpoint) {
    callback && callback(Buffer.alloc(0));
    return this;
  }
  try {
    this.deviceToPcEndpoint.transfer(64, function (_error, data) {
      callback(data || Buffer.alloc(0));
    });
  } catch (e) {
    callback && callback(Buffer.alloc(0));
  }
  return this;
};

USB.prototype.close = function (callback) {
  // idempotent close (sprečava native abort)
  if (this._isClosing) {
    callback && callback(null);
    return this;
  }
  this._isClosing = true;

  if (!this.device || !this._isOpen) {
    this._isOpen = false;
    this.endpoint = null;
    this.deviceToPcEndpoint = null;
    callback && callback(null);
    return this;
  }

  try {
    this.device.close();
  } catch (e) {
    // ignore
  }

  this._isOpen = false;
  this.endpoint = null;
  this.deviceToPcEndpoint = null;

  callback && callback(null);
  this.emit('close', this.device);

  return this;
};

module.exports = USB;
