class Scroller {
	constructor(canvas, options = {}) {
		this.canvas = canvas;
        this.context = this.canvas.getContext('2d');
        this.fps = options.fps || 15;
        this.text = options.text;
        this.fgColor = options.textColor || "white";
        this.bgColor = options.bgColor || "black";
        this.margin = options.margin || 1;
        this.speed = options.speed || 2;

        this.font = options.font || "Arial";
        this.fontSize = options.fontSize || this.canvas.height / 3;
        this.context.font = this.fontSize + "px " + this.font;
		this.context.textAlign = 'left';
		this.context.textBaseline = 'top';
        this.textWidth = this.context.measureText(this.text).width;
        this.textHeight = this._measureFontHeight();
        this.xLeft = this.margin;
        this.yTop = (this.canvas.height - this.textHeight) / 2;
        this.dirRight = true;
        this.fpsDiv = options.fpsDiv || 2;
        this.frameCtr = this.fpsDiv;
 	}
    _calcNextFrame() {
        if (this.dirRight) {
            let newXleft = this.xLeft + this.speed;
            if (newXleft + this.textWidth + this.margin > this.canvas.width) {
                this.dirRight = false;
                this._calcNextFrame();
                return;
            }
            this.xLeft = newXleft;
        } else {
            let newXleft = this.xLeft - this.speed;
            if (newXleft < this.margin) {
                this.dirRight = true;
                this._calcNextFrame();
                return;
            }
            this.xLeft = newXleft;
        }
    }
    animate() {
        var self = this;
        if (self.frameTimer) {
            return;
        }
        self.frameTimer = setInterval(function() {
            self._calcNextFrame();
            self.context.fillStyle = self.bgColor;
            self.context.fillRect(0, 0, self.canvas.width, self.canvas.height);
            self.context.fillStyle = self.fgColor;
            self.context.fillText(self.text, self.xLeft, self.yTop);
        }, 1000 / self.fps);
    }
    stopAnimation() {
        if (!this.frameTimer) {
            return;
        }
        clearInterval(this.frameTimer);
        delete this.frameTimer;
    }
    _measureFontHeight() {
        this.context.fillStyle = this.bgColor;
        this.context.fillRect(0, 0, this.canvas.width, this.canvas.height);
        this.context.fillStyle = this.fgColor;
		this.context.fillText(this.text, 0, 0);
		const data = this.context.getImageData(0, 0, this.canvas.width, this.canvas.height).data;

		let firstY = -1;
		let lastY = -1;

		// loop through each row
		for (let y = 0; y < this.canvas.height; y++) {
			// loop through each column
			for (let x = 0; x < this.canvas.width; x++) {
                let base = ((this.canvas.width * y) + x) * 4;
                const color = data[base++] << 16 | data[base++] << 8 | data[base++];
				if (color > 0) {
					firstY = y;
					break;
				}
			}

			if (firstY >= 0) break;
		}

		// loop through each row, this time beginning from the last row
		for(var y = this.canvas.height; y > 0; y--) {
			// loop through each column
			for(let x = 0; x < this.canvas.width; x++) {
                let base = ((this.canvas.width * y) + x) * 4;
                const color = data[base++] << 16 | data[base++] << 8 | data[base++];
				if (color > 0) {
					lastY = y;
					// exit the loop
					break;
				}
			}
			if (lastY >= 0) break;
		}
        return lastY - firstY;
	}
}
