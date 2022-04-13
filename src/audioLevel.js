function AudioLevelMonitor(stream, handler, changeThreshold) {
    var self = this;
    self._lastLevel = 0.0;
    if (!handler) {
        handler = function(level) {  console.log("audio level change:", level);  };
    }
    self.handler = handler;
    self._changeThreshold = changeThreshold ? changeThreshold : 0.002;
    var ctx = self.audioCtx = new AudioContext();
    if (!ctx) {
        throw new Error("Can't create audio context, maybe maximum number of instances was reached");
    }
    self.source = ctx.createMediaStreamSource(stream);
    var scriptNode = self.scriptNode = ctx.createScriptProcessor(8192, 1, 1);
    scriptNode.onaudioprocess = function(event) {
        if (!self._connected) {
            return;
        }
        var inData = event.inputBuffer.getChannelData(0);
        var level = 0.0;
        // Samples are in float format (0 to 1). Process each n-th sample to save some cpu cycles
        for (var sn = 0; sn < inData.length; sn += 4) {
            var val = Math.abs(inData[sn]);
            if (val > level) {
                level = val;
            }
        }
        var lastLevel = self._lastLevel;
        var smoothFactor = self._smoothingFactor;
        if (smoothFactor) {
            if (level > self._lastLevel) {
                self._lastLevel = level;
            } else {
                self._lastLevel = level = self._lastLevel * smoothFactor;
            }
            if (Math.abs(level - lastLevel) >= self._changeThreshold) {
                handler(level);
            }
        }
        else {
            if (Math.abs(level - lastLevel) >= self._changeThreshold ||
                (level <= 0.0001 && lastLevel >= 0.0005)) { // return to zero
                self._lastLevel = level;
                handler(level);
            }
        }
    };
    self.connect();
}

AudioLevelMonitor.prototype.connect = function() {
    var self = this;
    if (self._connected) {
        return;
    }
    self.source.connect(self.scriptNode);
//    if (!RTC.isFirefox) {
        self.scriptNode.connect(self.audioCtx.destination);
//    }
    self._connected = true;
};

AudioLevelMonitor.prototype.disconnect = function() {
    var self = this;
    if (!self._connected) {
        return;
    }
    self.source.disconnect(self.scriptNode);
//    if (!RTC.isFirefox) {
        self.scriptNode.disconnect(self.audioCtx.destination);
//    }
    delete self._connected;
    if (self._lastLevel >= 0.005) {
        self._lastLevel = 0.0;
        self.handler(0.0);
    }
};

AudioLevelMonitor.prototype.isConnected = function() {
    return this._connected != null;
};

AudioLevelMonitor.prototype.setChangeThreshold = function(val) {
    this._changeThreshold = val / 100;
};

AudioLevelMonitor.prototype.enableSmoothing = function(factor) {
    this._smoothingFactor = 1 - 1 / factor;
    this._changeThreshold = 0;
};

AudioLevelMonitor.prototype.lastLevel = function() {
    return Math.round(this._lastLevel * 100);
};

AudioLevelMonitor.prototype.destroy = function() {
    if (this.audioCtx) {
        this.audioCtx.close();
        delete this.audioCtx;
    }
};
