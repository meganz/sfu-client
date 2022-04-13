const endl = "\r\n";
class Ssrc {
    id: number;
    cname?: string;
    constructor(id: number) {
        this.id = id;
    }
}
class Track {
    t: string;
    sdp?: string;
    mid?: number;
    id?: string;
    sid?: string;
    dir?: string;
    ssrcs?: Ssrc[];
    ssrcg?: string[];
    constructor(type: string) {
        this.t = type;
    }
    static uncompress(track: Track, template: string) {
        let sdp = template;
        if (track.sdp) {
            sdp += track.sdp + "\r\n";
        }
        sdp += "a=mid:" + track.mid + endl;
        sdp += "a=" + track.dir + endl;
        if (track.id) { // recvonly tracks don't have it
            sdp += "a=msid:" + track.sid + " " + track.id + endl;
        }
        if (track.ssrcs) {
            for (let ssrc of track.ssrcs) {
                let id = ssrc.id;
                sdp += "a=ssrc:" + id + " cname:" + (ssrc.cname ? ssrc.cname : track.sid) + endl;
                sdp += "a=ssrc:" + id + " msid:" + track.sid + " " + track.id + endl;
                // sdp += "a=ssrc:" + id + " mslabel:" + track.sid + endl;
                // sdp += "a=ssrc:" + id + " label:" + track.id + endl;
            }
            if (track.ssrcg) {
                for (let grp of track.ssrcg) {
                    sdp += "a=ssrc-group:" + grp + endl;
                }
            }
        }
        return sdp;
    }

}
class CompressedSdp {
    data: Record<string, any>;
    constructor(sdp: any) {
        if (sdp instanceof Object) {
            this.data = sdp;
            return;
        }
        let data = this.data = {
            cmn: "",
            atpl: "",
            vtpl: "",
            tracks: []
        };

        let lines = sdp.split(/\r\n/);
        let i = 0;
        for (; i < lines.length; i++) {
            let line = lines[i];
            if (line.substr(0, 2) === "m=") {
                break;
            }
            data.cmn += line + endl;
        }
        while (i < lines.length) {
            let line = lines[i];
            let type = line.substr(2, 5);
            if (type === "audio" && !data.atpl) {
                i = this._createTemplate("atpl", lines, i);
                if (data.vtpl) {
                    break;
                }
            } else if (type === "video" && !data.vtpl) {
                i = this._createTemplate("vtpl", lines, i);
                if (data.atpl) {
                    break;
                }
            } else {
                i = nextMline(lines, i + 1);
            }
        }
        for (i = nextMline(lines, 0); i < lines.length;) {
            i = this._addTrack(lines, i);
        }
    }
    protected _createTemplate(tname: string, lines: string[], i: number) {
        let template = lines[i++] + endl;
        for (; i < lines.length; i++) {
            let line = lines[i];
            let ltype = line.charAt(0);
            if (ltype === 'm') {
                break;
            }
            if (ltype !== 'a') {
                template += line + endl;
                continue;
            }
            let name = nextWord(line, 2)[0];
            if (name === "recvonly") { // we don't want to make a template from a recvonly description
                // consume lines till next m-line
                return nextMline(lines, i);
            }
            switch(name) {
                case "sendrecv":
                case "sendonly":
                case "ssrc-group":
                case "ssrc":
                case "mid":
                case "msid":
                    continue;
                default:
                    template += line + endl;
            }
        }
        this.data[tname] = template;
        return i;
    }

    _addTrack(lines: string[], i: number) {
        let type = lines[i++].substr(2, 5);
        if (type === "audio") {
            type = "a";
        } else if (type === "video") {
            type = "v"
        };
        let track = new Track(type);
        let ssrcIds = new Set;
        for (; i < lines.length; i++) {
            let line = lines[i];
            let ltype = line.charAt(0);
            if (ltype === 'm') {
                break;
            }
            if (ltype !== 'a') {
                continue;
            }
            let name = nextWord(line, 2)[0];
            switch (name) {
                case "sendrecv":
                case "recvonly":
                case "sendonly": {
                    track.dir = name;
                    break;
                }
                case "mid": {
                    track.mid = parseInt(line.substr(6));
                    break;
                }
                case "msid": {
                    let parts = line.substr(7).split(' ');
                    track.sid = parts[0];
                    track.id = parts[1];
                    break;
                }
                case "ssrc-group": {
                    if (!track.ssrcg) {
                        track.ssrcg = [];
                    }
                    track.ssrcg.push(line.substr(13));
                    break;
                }
                case "ssrc": {
                    let ret = nextWord(line, 7);
                    let id = parseInt(ret[0]);
                    if (ssrcIds.has(id)) {
                        break;
                    }
                    ssrcIds.add(id);
                    ret = nextWord(line, ret[1] + 1);
                    let cname = nextWord(line, ret[1] + 1)[0];
                    let ssrc = new Ssrc(id);
                    if (cname !== track.sid) {
                        ssrc.cname = cname;
                    }
                    if (!track.ssrcs) {
                        track.ssrcs = [ssrc];
                    } else {
                        track.ssrcs.push(ssrc);
                    }
                    break;
                }
            }
        }
        this.data.tracks.push(track);
        return i;
    }
    uncompress() {
        let sdp = this.data.cmn;
        for (let track of this.data.tracks) {
            if (track.t === "a") {
                sdp += Track.uncompress(track, this.data.atpl);
            } else if (track.t === "v") {
                sdp += Track.uncompress(track, this.data.vtpl);
            }
        }
        return sdp;
    }
}

function nextWord(line: string, start: number): [string, number] {
    let i;
    for (i = start; i < line.length; i++) {
        let ch = line.charCodeAt(i);
        if ((ch >= 97 && ch <= 122) || // a - z
            (ch >= 65 && ch <= 90) ||  // A - Z
            (ch >= 48 && ch <= 57) ||  // 0 - 9
            (ch === 45) || (ch === 43) || (ch === 47) || (ch === 95)) { // - + /
            continue;
        }
        break;
    }
    return [line.substr(start, i - start), i];
}

function nextMline(lines: string[], i: number) {
    for(; i < lines.length; i++) {
        if (lines[i].charAt(0) === "m") {
            return i;
        }
    }
    return i;
}

export function sdpCompress(sdp: string) {
    /*
    console.log("original:\n", sdp);
    let csdp = (new CompressedSdp(sdp)).uncompress();
    console.log("compressed:\n", csdp);
    */
//  return sdp;
    return (new CompressedSdp(sdp)).data;
}
export function sdpUncompress(sdp: any) {
//  return sdp;
    return (new CompressedSdp(sdp)).uncompress();
}

function trackSummary(tracks: any) {
    let summary = "";
    if (tracks.tx) {
        summary += tracks.tx + " send";
    } else {
        summary += tracks.rx + " recv";
    }
    if (tracks.txrx) {
        summary += ", " + tracks.txrx + " sendrecv";
    }
    return summary;
}
export function compressedSdpToString(sdp: any) {
    let video = {rx: 0, tx: 0, txrx: 0, svc: 0};
    let audio = {rx: 0, tx: 0, txrx: 0};
    for (let track of sdp.tracks) {
        let type = track.t;
        let dir = track.dir;
        let info;
        if (type === "v") {
            info = video;
            if (track.ssrcg) {
                for (let ssrcg of track.ssrcg) {
                    if (ssrcg.substr(0, 3) === "SIM") {
                        video.svc++;
                    }
                }
            }
        } else {
            info = audio;
        }
        if (dir === "recvonly") {
            info.rx++;
        } else if (dir === "sendrecv") {
            info.txrx++;
        } else if (dir === "sendonly") {
            info.tx++;
        }
    }
    let summary = "<vtracks: " + trackSummary(video);
    if (video.svc) {
        summary += ", " + video.svc + " SVC";
    }
    summary += "; atracks: " + trackSummary(audio) + ">";
    return summary;
}

