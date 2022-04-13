/* Mega SFU Client library */
import TermCode from "../shared/termCodes";
import Av from "../shared/av";
import {sdpCompress, sdpUncompress, compressedSdpToString} from "../shared/sdpCompress";
import COMMIT_ID from '../shared/commitId';

type Dict = Record<string, any>;

function assert(cond: any) {
    if (!cond) {
        throw new Error("Assertion failed");
    }
}

enum SpeakerState {
    kNoSpeaker = 0,
    kPending = 1,
    kActive = 2
}
enum ConnState {
    kDisconnected = 0,
    kDisconnectedRetrying = 1,
    kConnecting = 2,
    kJoining = 3,
    kJoined = 4
}
enum ScreenShareType {
    kInvalid = 0,
    kWholeScreen = 1,
    kWindow = 2,
    kBrowserTab = 3
}

interface PromiseWithKeyId extends PromiseWithResolveMethods {
    keyId: number;
}
interface MyRtcPeerConnection extends RTCPeerConnection {
    onaddstream: Function
}
interface IPeerEventListener {
    onPeerJoined(peer: Peer): void;
    onPeerSpeakReq(peer: Peer): void;
    onPeerSpeakReqDel(peer: Peer): void;
    onPeerLeft(peer: Peer): void;
    onPeerSpeaker(peer: Peer): void;
    onPeerNoSpeaker(peer: Peer): void;
    onPeerModerator(peer: Peer): void;
    onPeerAvChange(peer: Peer, av: number): void;
}
interface IVideoPlayerGui {
    onAttachedToTrack(): void;
    onDestroy(): void;
    onVthumbAttach(): void;
    onVthumbDetach(): void;
    onRxStats(stats: Dict): void;
}
interface IClientEventListener extends IPeerEventListener{
    onConnecting(): void;
    onConnected(): void;
    onJoined(): void;
    onDisconnect(termCode: number, willReconnect: boolean): void;
    decryptKeyFrom(key: string, userid: string): Promise<ArrayBuffer>;
    encryptKeyTo(key: any, userid: string): Promise<string>;
    onSpeaker(): void;
    onNoSpeaker(): void;
    onOwnSpeakRequestDel(): void;
    onLocalMediaError(errAv: number): void;
    onLocalMediaChange(changeAv: number): void;
    onScreenshare(enabled: boolean, ssType?: ScreenShareType): void;
    onModerator(isModerator: boolean): void;
    onOwnSpeakRequest(): void;
    onNoMicInput(): void;
    onVideoTxStat(isHiRes: boolean|null, info?: Dict, stat?: any): void;
    onNewPlayer(player: VideoPlayer): IVideoPlayerGui;
    onActiveSpeakerChange(newSpeaker: Peer|null, prev: Peer|null|undefined): void;
}
export class SfuClient {
    static debugSdp = localStorage.debugSdp ? 1 : 0;
    static kMaxActiveSpeakers = 20;
    static kMaxInputVideoTracks = 20;
    static kSpatialLayerCount = 3;
    static kVideoCaptureOptions = { width: 960, height: 540 };
    static kScreenCaptureOptions = { video: { height: { max: 1440 }}};
    static kVthumbHeight = 90;
    static kRotateKeyUseDelay = 100;
    static kPeerReconnNoKeyRotationPeriod = 1000;
    static kAudioMonTickPeriod = 200;
    static kSpeakerVolThreshold = 0.001;
    static kWorkerUrl = '/worker.sfuClient.bundle.js';
    static kStatServerUrl = "https://stats.sfu.mega.co.nz";
    static kSpeakerChangeMinInterval = 4000;
    static SpeakerState = SpeakerState;
    static ConnState = ConnState;
    static TermCode = TermCode;
    static ScreenShareType = ScreenShareType;
    static Av = Av;
    cid?: number;
    userId: string;
    callId?: string;
    isGroup?: boolean;
    app: IClientEventListener;
    protected _reqBarrier: RequestBarrier;
    protected _speakerState: SpeakerState;
    protected _connState: ConnState;
    options: Dict;
    url: string;
    cryptoWorker: Worker;
    protected _svcDriver: SvcDriver;
    _speakerDetector: SpeakerDetector;
    protected _statsRecorder: StatsRecorder;
    protected _sendKeyIdGen: number;
    _newestSendKey?: any; // last generated send key, may not yet be in use
    protected currKey?: any; // send key currently being used
    protected callKey?: Uint32Array; // the optional shared call key that authenticates us to participate in the call
    protected _lastPeerJoinLeave?: any;
    protected keySetPromise?: PromiseWithKeyId;
    peers: Map<number, Peer> = new Map<number, Peer>();
    conn?: WebSocket;
    inputPacketQueue?: Dict[];
    rtcConn?: MyRtcPeerConnection;
    outVSpeakerTrack: VideoSlot;
    outASpeakerTrack: Slot;
    outVThumbTrack: VideoSlot;
    inAudioTracks: Map<number, Slot>;
    inVideoTracks: Map<number, VideoSlot>;
    initialVthumbCount?: number;
    protected _isModerator: boolean = false;
    protected _isSharingScreen: boolean = false;
    protected _muteCamera: boolean = false;
    protected _muteAudio: boolean = false;
    protected _sendVthumb: boolean = false;
    protected _sendHires: boolean = false;
    fakeLocalVideoCanvas?: any;
    screenAspectRatio?: number;
    protected _cameraTrack: MediaStreamTrack|null = null;
    protected _screenTrack: MediaStreamTrack|null = null;
    protected _audioTrack: MediaStreamTrack|null = null;
    protected _onHold?: Dict;
    protected _availAv: number = 0;
    protected _sentAv: number = 0;
    termCode?: any;
    protected _joinRetries: number = 0;
    protected _forcedDisconnect: boolean = false;
    protected _tsCallJoin: number = 0;
    protected _tsCallStart: number = 0;
    joinToffs: number = 0;

    protected statTimer?: ReturnType<typeof setTimeout>;
    // these need to be accessible from VideoSlot
    rtcStats?: Dict;
    statCtx: Dict = {};
    hasConnStats: boolean = false;
    maxPeers: number = 0;
    micAudioLevel: number = 0;
    tsMicAudioLevel: number = 0;
    protected micMuteMonitor: MicMuteMonitor;
    get micInputSeen() { return this.micMuteMonitor.micInputSeen; }
    static platformHasSupport() {
        return window.RTCRtpSender &&
        !!(RTCRtpSender.prototype as any).createEncodedStreams;
    }
    logError(...args: any) {
        console.error.apply(console, args);
        let msg = args.join(' ');
        let url = `${SfuClient.kStatServerUrl}/msglog?userid=${this.userId}&t=e`;
        if (this.callId) {
            url += `&callid=${this.callId}`;
        }
        fetch(url, { method: "POST", body: msg });
    }
    constructor(userId: string, app: any, callKey: ArrayBuffer|string|null, options: Dict, url: string) {
        if (!SfuClient.platformHasSupport()) {
            throw new Error("This browser does not support insertable streams");
        }
        assert(options);
        this.userId = userId;
        this.app = app;
        this._reqBarrier = new RequestBarrier;
        this._speakerState = SpeakerState.kNoSpeaker;
        this._connState = ConnState.kDisconnected;
        this.options = options;
        if (callKey) {
            this.setCallKey(callKey);
        }
        this.url = url;
        this.cryptoWorker = new Worker(SfuClient.kWorkerUrl);
        this.cryptoWorker.addEventListener("message", this.onCryptoWorkerEvent.bind(this));
        this._svcDriver = new SvcDriver(this);
        this._speakerDetector = new SpeakerDetector(this);
        this._statsRecorder = new StatsRecorder(this);
        this.micMuteMonitor = new MicMuteMonitor(this);
    }
    reinit() {
        this._sendKeyIdGen = -1;
        this.peers.clear();
        delete this._lastPeerJoinLeave;
        this.cryptoWorker.postMessage(['r']); // reset crypto
        this.statCtx = {};
        this._statsRecorder.reset();
    }
    onCryptoWorkerEvent(event: any) {
        let msg = event.data;
        console.debug("Message from crypto worker:", msg);
        if ((msg.op === "keyset") && (this.keySetPromise && msg.keyId === this.keySetPromise.keyId)) {
            this.keySetPromise.resolve();
            delete this.keySetPromise;
        }
    }
    isJoining() {
        return this._connState < ConnState.kJoined;
    }
    get connState() {
        return this._connState;
    }
    protected shouldReconnect() {
        if (this._forcedDisconnect) {
            return false;
        }
        return SfuClient.isTermCodeRetriable(this.termCode);
    }
    static isTermCodeRetriable(termCode: TermCode) {
        return termCode === TermCode.kRtcDisconn ||
               termCode === TermCode.kSigDisconn; // || termCode === TermCode.kSfuShuttingDown;
               // TODO: handle SFU shutdown gracefully and reconnect
    }
    async onWsClose(event?: CloseEvent) {
        if (event && event.target !== this.conn) {
            console.warn("onWsClose: ignoring stale event for a previous websocket instance");
            return;
        }
        console.warn("SfuClient: Signaling connection closed");
        delete this.conn;
        if (this.termCode == null) {
            this.termCode = TermCode.kSigDisconn;
        }
        if (this.statTimer) {
            clearTimeout(this.statTimer);
        }
        let shouldReconnect = this.shouldReconnect();
        let prevState = this._connState;
        this._setConnState(shouldReconnect ? ConnState.kDisconnectedRetrying : ConnState.kDisconnected);
        this.disableStats();
        if (prevState == ConnState.kJoined) {
            this._statsRecorder.submit(this.termCode);
        }
        this._closeMediaConnection();
        this._destroyAllPeers(this.termCode);
        this._fire("onDisconnect", this.termCode, shouldReconnect);
        if (shouldReconnect) {
            this.scheduleReconnect();
            return;
        }
        this._stopLocalTracks();
    }
    async scheduleReconnect() {
        let delay = this._joinRetries++ * 500;
        if (delay > 2000) {
            delay = 2000;
        }
        console.warn("Reconnecting in", delay, "ms....");
        await msDelay(delay);
        if (!this._forcedDisconnect) {
            this.connect();
        }
    }
    _closeMediaConnection() {
        if (this.rtcConn) {
            this.rtcConn.close();
            delete this.rtcConn;
        }
    }
    _destroyAllPeers(reason?: TermCode) {
        for (let peer of this.peers.values()) {
            peer.destroy(reason);
        }
        this.peers.clear();
    }
    _fire(evName: string, ...args: any[]) {
        let method = (this.app as any)[evName];
        if (!method) {
            console.warn(`Unhandled event: ${evName}(${args.join(",")})`);
            return;
        }
        console.log("fire [" + evName + "]");
        try {
            method.call(this.app, ...args);
        } catch(ex) {
            this.logError("Event handler for", evName, "threw exception:", ex.stack);
        }
    }
    async generateKey() {
        let keyObj: CryptoKey = await window.crypto.subtle.generateKey({ name: "AES-GCM", length: 128 },
            true, ["encrypt", "decrypt"]);
        let tsStart = Date.now();
        let key: ArrayBuffer = await crypto.subtle.exportKey("raw", keyObj);
        console.warn(`exportKey completed in ${Date.now() - tsStart} ms`);

        this.xorWithCallKeyIfNeeded(key);
        let keyId = ++this._sendKeyIdGen;
        this._newestSendKey = {
            keyObj: keyObj,
            key: key,
            id: keyId
        };
        return this._newestSendKey;
    }
    /* If we set a key for the first time, we must wait for the operation to complete on the
    crypto thread. That's why we implement this method with feedback notification
    */
    async newKeyImmediate() {
        let key = this.currKey = await this.generateKey();
        assert(!this.keySetPromise); // previous calls must await for completion as well, which deletes the promise
        let pms = this.keySetPromise = createPromiseWithResolveMethods() as PromiseWithKeyId;
        pms.keyId = key.id;
        this.cryptoWorker.postMessage(['ek', key.id, key.keyObj, true]);
        return pms;
    }
    /** If we have a key and want to rotate it, some delay is introduced between broadcasting the key
    and using it. If multiple calls to this function overlap in time, we should not wait for
    the last to finish in order to set the key, as this may present a vulnerability to prevent
    actual key rotation with a flood of reconnects (or other rotation-triggering events)

    @returns Resolve as soon as key is generated
    */
    async rotateKey() {
        var self = this;
        console.warn("Rotate key");
        let key = await self.generateKey();
        self.encryptAndSendLastKeyToAllPeers()
        .then(async () => {
            await msDelay(SfuClient.kRotateKeyUseDelay);
            if (key.id > self.currKey.id) {
                self.currKey = key;
                self.cryptoWorker.postMessage(['ek', key.id, key.keyObj]);
            }
        });
    }
    setCallKey(key: ArrayBuffer|string) {
        assert(key);
        var callKey = key instanceof ArrayBuffer ?
            new Uint32Array(key) :
            new Uint32Array(hexToBin(key).buffer);

        if (callKey.byteLength !== 16) {
            this.logError("Invalid format of call key: length is not 16 bytes");
            return;
        }
        assert(callKey.length === 4);
        this.callKey = callKey;
    }
    xorWithCallKeyIfNeeded(key: ArrayBuffer) {
        if (!this.callKey) {
            return;
        }
        assert(key.byteLength === 16);
        let arr = new Uint32Array(key);
        let callKey = this.callKey;
        arr[0] ^= callKey[0];
        arr[1] ^= callKey[1];
        arr[2] ^= callKey[2];
        arr[3] ^= callKey[3];
    }

    async encryptAndSendLastKeyToAllPeers() {
        if (!this.peers!.size) {
            return;
        }
        let key = this._newestSendKey;
        if (!key) {
            this.logError("No send key");
            return;
        }
        let keyData = key.key;
        let promises = [];
        for (let peer of this.peers.values()) {
            promises.push(peer.encryptKey(keyData));
        }
        let results = await Promise.all(promises);
        this.send({ a: "KEY", id: key.id & 0xff, data: results });
    }

    async msgKey(msg: Dict) {
        var self = this;
        let peer = self.peers.get(msg.from);
        if (!peer) {
            console.warn("msgKey: Unknown peer cid", msg.from);
            return;
        }
        let id = msg.id;
        assert(!isNaN(id) && (id >= 0) && (id < 256));
        self.app.decryptKeyFrom(msg.key, peer.userId)
        .then(function(key: ArrayBuffer) {
            self.xorWithCallKeyIfNeeded(key);
            self.cryptoWorker.postMessage(['dk', msg.from, id, key]);
        });
    }

    async connect(url?: string, callId?: string, isGroup?: boolean) {
        if (url) { // for reconnect, we don't pass any parameters to connect()
            this.url = url;
            assert(callId);
            this.callId = callId;
            this.isGroup = isGroup;
            this._joinRetries = 0;
            this._forcedDisconnect = false;
        } else {
            // this is reconnect - cancel it if user explicitly requested disconnect
            assert(!this._forcedDisconnect);
        }
        delete this.termCode;
        this.micMuteMonitor.reinit();
        this._setConnState(ConnState.kConnecting);
        this._fire("onConnecting");
        this.reinit();
        let pc = this.rtcConn = new RTCPeerConnection({
            encodedInsertableStreams: true,
            sdpSemantics: 'unified-plan'
        } as any) as MyRtcPeerConnection;
        this.createAllTransceivers();
        pc.ontrack = (e) => {
            let xponder = e.transceiver;
            let track = e.track;
            let slot = (xponder as any).slot;
            console.log(`onTrack: mid: ${xponder.mid}, kind: ${track.kind}, dir: ${xponder.direction}, slot: ${
                slot ? "has" : "none-yet"}`);
            if (track.kind === "video") {
                if (!slot) {
                    assert(xponder.direction === "recvonly");
                    slot = new VideoSlot(this, xponder);
                    slot.createDecryptor();
                }
                // use slot.mid instead of xponder.mid because it's a numeric value, parsed from xponder.mid
                this.inVideoTracks.set(slot.mid, slot);
            }
            else {
                assert(track.kind === "audio");
                if (!slot) {
                    assert(xponder.direction === "recvonly");
                    slot = new Slot(this, xponder);
                    slot.createDecryptor();
                }
                this.inAudioTracks.set(slot.mid, slot);
            }
        };
        pc.onaddstream = (event: any) => {
            console.debug("onAddStream");
            this.outVSpeakerTrack.createEncryptor();
            this.outVSpeakerTrack.createDecryptor();
            this.outASpeakerTrack.createEncryptor();
            this.outASpeakerTrack.createDecryptor();
            this.outVThumbTrack.createEncryptor();
            this.outVThumbTrack.createDecryptor();
        };
        pc.oniceconnectionstatechange = (ev) => {
            console.log("onIceConnState:", pc.iceConnectionState);
        };
        pc.onconnectionstatechange = (ev) => {
            console.log("onConnState:", pc.connectionState);
            if (pc.connectionState === "failed") {
                this.handleRtcDisconnect();
            }
        }

        let ws = this.conn = new WebSocket(this.url, "svc");
        ws.onopen = this.onConnect.bind(this);
        ws.onmessage = this.onPacket.bind(this);
        ws.onclose = this.onWsClose.bind(this);
    }

    hasConnection() {
        return this.conn != null;
    }
    async handleRtcDisconnect() {
        let statsRec = this._statsRecorder;
        if (statsRec && statsRec.arrays.t.length === 0 && statsRec.tsStart && (Date.now() - statsRec.tsStart! > 6000)) {
            console.warn("WebRTC connection failed, looks like no UDP connectivity");
            this.disconnect(TermCode.kNoMediaPath);
        } else {
            console.warn("WebRTC connection failed, forcing full reconnect of client");
            this.disconnect(TermCode.kRtcDisconn, true);
        }
    }
    _stopLocalTracks() {
        this._stopAndDelLocalTrack("_audioTrack");
        this._stopAndDelLocalTrack("_cameraTrack");
        this._stopAndDelLocalTrack("_screenTrack");
    }
    /**
    * @param _supportRetry This is for internal use and must not be specified by the application
    * @returns false if we were already disconnected and no onDisconnect event was fired, true oherwise
    */
    disconnect(termCode: number, _supportRetry?: boolean) {
        if (!_supportRetry) {
            this._forcedDisconnect = true;
        }
        if (this._connState === ConnState.kDisconnected) {
            return false;
        }
        termCode = this.termCode = (termCode != null) ? termCode : TermCode.kUserHangup;
        if (!this.conn) { // should be in kDisconnectedRetrying state - abort retrying
            this._stopLocalTracks();
            return false;
        }
        if (this.conn.readyState === WebSocket.OPEN) {
            try {
                this.send({a: "BYE", rsn: termCode});
            } catch(ex) {}
        }
        // In some cases when there is no network but that is not detected by browser,
        // conn.close() doesn't fire onclose until all queued data (i.e. the BYE command)
        // has been sent (which would happen when we are back online), so we do it manually and synchronously
        this.conn.onclose = null;
        this.conn.close();
        this.onWsClose();
        return true;
    }
    modEndCall(anon: boolean) {
        let cmd: Dict = {a: "MOD_ENDCALL"};
        if (anon) {
            cmd.anon = 1;
        }
        this.send(cmd);
    }
    async createAllTransceivers() {
        /* uplink track map:
        mid=0: uplink video thumbnail track
        mid=1: uplink video speaker track
        mid=2: uplink audio speaker track
        */
        this.inAudioTracks = new Map<number, Slot>();
        this.inVideoTracks = new Map<number, VideoSlot>();
        let pc = this.rtcConn!;
        this.outVThumbTrack = new VideoSlot(this, pc.addTransceiver("video", { direction: "sendrecv" }), true);
        this.outVSpeakerTrack = new VideoSlot(this, pc.addTransceiver("video", { direction: "sendrecv"}), true);
        this.outASpeakerTrack = new Slot(this, pc.addTransceiver("audio", { direction: "sendrecv" }), true);

        for (let i = 1; i < SfuClient.kMaxActiveSpeakers; i++) {
            pc.addTransceiver("audio", {direction: "recvonly"});
        }
        for (let i = 2; i < SfuClient.kMaxInputVideoTracks; i++) {
            pc.addTransceiver("video", {direction: "recvonly"});
        }
    }

    send(msg: Dict) {
        if (!this.conn) {
            return;
        }
        let strMsg = JSON.stringify(msg);
        this.conn.send(strMsg);
        console.log("tx:\n", JSON.stringify(msg, logReplacerFunc));
    }

    async onConnect() {
        console.log("ws opened");
        this._setConnState(ConnState.kJoining);
        this._fire("onConnected");
        //this._sendVthumb = true;
        await this._updateSentTracks();
        let pc = this.rtcConn!;
        let offer = await pc.createOffer();
        let sdp = sdpCompress(offer.sdp!);
        // hack to enable SVC
        this.mungeSdpForSvc(sdp.tracks[1]);
        //  sdp.tracks[0].sdp = "a=fmtp:98 x-google-max-bitrate=150";
        // Set it
        offer.sdp = sdpUncompress(sdp);
        await pc.setLocalDescription(offer);
        let ivs = {
            0: binToHex(this.outVThumbTrack.iv.buffer),
            1: binToHex(this.outVSpeakerTrack.iv.buffer),
            2: binToHex(this.outASpeakerTrack.iv.buffer)
        };
        let options = this.options;
        this._speakerState = options && options.moderator && options.speak ? SpeakerState.kPending : SpeakerState.kNoSpeaker;
        let offerCmd: Dict = {
            a: "JOIN",
            sdp: sdp,
            ivs: ivs,
            av: this.availAv
        };
        if (this.cid) { // when reconnecting, tell the SFU the CID of the previous connection, so it can kill it instantly
            offerCmd.cid = this.cid;
        }
        if (this.initialVthumbCount) {
            offerCmd.vthumbs = this.initialVthumbCount;
        }
        /*
        if (this.options.moderator) {
            offerCmd.mod = 1;
        }
        */
        if (this.options.speak) {
            offerCmd.spk = 1;
        }
        this.send(offerCmd);
    }

    _stopAndDelLocalTrack(name: string) {
        let track = (this as Dict)[name];
        if (!track) {
            return;
        }
        track.stop();
        delete (this as Dict)[name];
    }

    async _doGetLocalTracks() {
        var self = this;

        // first, determine which tracks we need
        let screen = self._isSharingScreen;
        let camera = !self._muteCamera;
        // get audio track when active speaker, even if muted. This will spedd up unmuting
        let audio = (this._speakerState > SpeakerState.kNoSpeaker) ? true : false;

        // then, check what we have and what needs to change
        var camChange = camera != (!!self._cameraTrack);
        var screenChange = screen != (!!self._screenTrack);
        var audioChange = audio != (!!self._audioTrack);
        if (!(camChange || audioChange || screenChange)) {
            console.log("getLocalTracks: nothing to change");
            return false;
        }
        let errAv = 0;

        // delete the tracks we disable, and prepare options for getting the ones we enable
        let promises = [];
        if (audioChange && !audio) {
            self._stopAndDelLocalTrack("_audioTrack");
        }
        if (camChange) {
            if (camera) {
                if (self.fakeLocalVideoCanvas) {
                    self._cameraTrack = self.getFakeCamTrack();
                }
            } else { // !camera
                self._stopAndDelLocalTrack("_cameraTrack");
            }
        }
        if (screenChange && !screen) {
            self._stopAndDelLocalTrack("_screenTrack");
        }

        let gettingAudio = audioChange && audio;
        let gettingCam = camChange && camera && !self.fakeLocalVideoCanvas;
        let gettingScreen = screenChange && screen;
        if (gettingAudio) {
            promises.push(navigator.mediaDevices.getUserMedia({ audio: true })
            .then(function(stream) {
                let atrack = self._audioTrack = stream.getAudioTracks()[0];
                if (!atrack) {
                    return Promise.reject("Error getting audio track");
                }
            })
            .catch(function(err) {
                errAv |= Av.Audio;
                console.error("Error getting local mic:", err);
                return Promise.reject(err);
            }));
        }
        if (gettingCam) {
            promises.push(navigator.mediaDevices.getUserMedia({ video: SfuClient.kVideoCaptureOptions })
            .then(function(stream) {
                let vtrack = self._cameraTrack = stream.getVideoTracks()[0];
                if (!vtrack) {
                    return Promise.reject("Error getting camera video track");
                }
            })
            .catch(function(err) {
                errAv |= Av.Camera;
                console.error("Error getting local camera:", err);
                return Promise.reject(err);
            }));
        }
        if (gettingScreen) {
            promises.push((navigator.mediaDevices as any).getDisplayMedia(SfuClient.kScreenCaptureOptions)
            .then(function(stream: MediaStream) {
                let strack = self._screenTrack = stream.getVideoTracks()[0];
                assert(strack);
                strack.onended = function() {
                    self.onScreenSharingStoppedByUser();
                }
            })
            .catch(function(err: any) {
                self._isSharingScreen = false;
                errAv |= Av.Screen;
                console.error("Error getting screen video track:", err);
                return Promise.reject(err);
            }));
        }
        await Promise.allSettled(promises);
        if (errAv) {
            self._fire("onLocalMediaError", errAv);
        }
        return true;
    }

    _getLocalTracks() {
        return this._reqBarrier.callFunc(this, this._doGetLocalTracks);
    }
    _updateSentTracks(pre?: Function) {
        if (pre) {
            return this._reqBarrier.callFunc(this, () => {
                pre.call(this);
                return this._doUpdateSentTracks();
            });
        } else {
            return this._reqBarrier.callFunc(this, this._doUpdateSentTracks);
        }
    }

    getFakeCamTrack() {
        return this.fakeLocalVideoCanvas.captureStream(15).getVideoTracks()[0];
    }
    /* Action is determined by:
    - SfuClient._muteAudio
    - SfuClient._muteCamera
    - SfuClient._isSharingScreen
    - SfuClient._sendHiRes and SfuClient._sendVthumb
    Sets SfuClient._localAudio/Video/ScreenTrack
    During the process sets SfuClient._isChangingLocalTracks
    */
    async _doUpdateSentTracks() {
        var self = this;
        let oldAv = this.availAv;
        let wasSendingHiRes = this.outVSpeakerTrack.isSendingTrack();
        try {
            await self._doGetLocalTracks();
            let promises: any[] = [];
            // first, determine which tracks we want to obtain, and null sender tracks that we want disabled
            if (self._speakerState === SpeakerState.kActive) {
                if (!self._muteAudio && self._audioTrack) {
                    promises.push(self.outASpeakerTrack.sendTrack(self._audioTrack));
                    this.micMuteMonitor.restart();
                } else {
                    promises.push(self.outASpeakerTrack.sendTrack(null));
                    this.micMuteMonitor.stop();
                }
            } else {
                promises.push(self.outASpeakerTrack.sendTrack(null));
            }
            let hiresTrack: MediaStreamTrack|null = null;
            let vthumbTrack: MediaStreamTrack|null = null;
            if (!self._cameraTrack) {
                if (self._isSharingScreen) { // if no camera and sharing screen - both tracks are screen
                    hiresTrack = vthumbTrack = this._screenTrack;
                }
                // otherwise no cam and no screen
            } else {
                if (self._isSharingScreen) { // both cam and screen: hires is screen, vthumb is camera
                    self._sendVthumb = true; // force sending vthumb - we must always send it when sending cam+screen
                    hiresTrack = self._screenTrack;
                    vthumbTrack = self._cameraTrack;
                } else { // only camera - both tracks are camera
                    hiresTrack = vthumbTrack = self._cameraTrack;
                }
            }
            promises.push(self.outVSpeakerTrack.sendTrack(this._sendHires ? hiresTrack : null));
            promises.push(self.outVThumbTrack.sendTrack(this._sendVthumb ? vthumbTrack : null));
            let tsStart = Date.now();
            await Promise.all(promises);
            console.log("sendTrack changes took", Date.now() - tsStart, "ms");
            // hook the svc driver init here, so that it is always executed
            if (this.outVSpeakerTrack.isSendingTrack() && !wasSendingHiRes) {
                this._svcDriver.initTx();
            }
        } finally {
            self._updateAvailAndSentAv();
            let av = self.availAv;
            if (av !== oldAv) {
                self._sendAvState();
                self._fire("onLocalMediaChange", av ^ oldAv);
            }
        }
    }
    /** Returns not what tracks are actually sent, but what are available for sending. This is because
    * sending a track may be disabled if nobody has requested it (reference counting)
    */
    _updateAvailAndSentAv() {
        if (this._onHold) {
            return;
        }
        let availAv = this.outASpeakerTrack.outTrack ? Av.Audio : 0;
        let sentAv = availAv;
        if (this._screenTrack) {
            if (this._cameraTrack) {
                availAv |= Av.ScreenHiRes | Av.CameraLowRes;
            } else {
                availAv |= Av.ScreenHiRes | Av.ScreenLowRes;
            }
        } else {
            if (this._cameraTrack) {
                availAv |= Av.Camera; // both high-res and low-res
            }
        }
        this._availAv = availAv;

        let track = this.outVThumbTrack.outTrack;
        if (track) {
            sentAv |= ((track === this._cameraTrack) ? Av.CameraLowRes : Av.ScreenLowRes);
        }
        track = this.outVSpeakerTrack.outTrack;
        if (track) {
            sentAv |= ((track === this._cameraTrack) ? Av.CameraHiRes : Av.ScreenHiRes);
        }
        this._sentAv = sentAv;
    }
    get availAv() {
        return this._availAv;
    }
    get sentAv() {
        return this._sentAv;
    }
    get rxQuality() {
        return this._svcDriver ? this._svcDriver.currRxQuality : -1;
    }
    get txQuality() {
        return this._svcDriver ? this._svcDriver.currTxQuality : -1;
    }
    sentTracksString() {
        let result = "";
        if (this.outASpeakerTrack.outTrack) {
            result += "A";
        }
        if (this.outVSpeakerTrack.outTrack) {
            result += "H";
        }
        if (this.outVThumbTrack.outTrack) {
            result += "L";
        }
        return result;
    }

    obtainedAv() {
        let av = this._audioTrack ? Av.Audio : 0;
        if (this._cameraTrack) {
            av |= Av.Camera;
        }
        if (this._screenTrack) {
            av |= Av.Screen;
        }
        return av;
    }
    mainSentVtrack() {
        return this._cameraTrack || this._screenTrack;
    }

    localCameraTrack() {
        return this._cameraTrack;
    }

    localScreenTrack() {
        return this._screenTrack;
    }

    localAudioTrack() {
        return this._audioTrack;
    }

    localAudioMuted() {
        if (!this._speakerState) {
            return false;
        }
        return this._onHold ? this._onHold.muteAudio : this._muteAudio;
    }
    localCameraMuted() {
        return this._onHold ? this._onHold.muteCamera : this._muteCamera;
    }
    speakerState() {
        return this._speakerState;
    }

    _sendAvState() {
        if (this._connState !== ConnState.kJoined) {
            return;
        }
        this.send({a: "AV", av: this.availAv});
    }

    muteCamera(mute: boolean) {
        if (this._onHold) {
            this._onHold.muteCamera = mute;
            return;
        }
        if (this._connState === ConnState.kDisconnected || this._connState === ConnState.kDisconnectedRetrying) {
            this._muteCamera = mute;
            return;
        }

        if (mute === this._muteCamera) {
            console.warn("muteCamera: No change");
            return Promise.resolve();
        }
        return this._updateSentTracks(() => this._muteCamera = mute);
    }
    muteAudio(mute: boolean) {
        if (this._onHold) {
            this._onHold.muteAudio = mute;
            return;
        }
        if (this._connState === ConnState.kDisconnected || this._connState === ConnState.kDisconnectedRetrying) {
            this._muteAudio = mute;
            return;
        }
        if (mute === this._muteAudio) {
            console.warn("muteAudio: No change");
            return Promise.resolve();
        }
        return this._updateSentTracks(() => this._muteAudio = mute);
    }
    async putOnHold() {
        await this._updateSentTracks(() => {
            if (this._onHold) {
                return;
            }
            this._availAv |= Av.onHold;
            this._sentAv = Av.onHold;
            this._onHold = {
                muteCamera: this._muteCamera,
                muteAudio: this._muteAudio,
                sendHires: this._sendHires,
                sendVthumb: this._sendVthumb,
                isSharingScreen: this._isSharingScreen
            }
            this._muteCamera = this._muteAudio = true;
            this._isSharingScreen = this._sendHires = this._sendVthumb = false;
        });
        // updateSentTracks() does not register avflags and local media change because it sees the on-hold availAv,
        // which is constant before and after the media change. So, we have to fire the event manually
        this._sendAvState();
        this._fire("onLocalMediaChange", Av.onHold);
    }
    async releaseHold() {
        await this._updateSentTracks(() => {
            if (!this._onHold) {
                return;
            }
            assert(this._availAv & Av.onHold);
            let oh = this._onHold;
            this._muteCamera = oh.muteCamera;
            this._muteAudio = oh.muteAudio;
            this._isSharingScreen = oh.isSharingScreen;
            this._sendHires = oh.sendHires;
            this._sendVthumb = oh.sendVthumb;
            delete this._onHold;
            // reflect the actual state of the sent tracks, so that the actual delta is seen correctly
            this._availAv = Av.onHold;
        });
    }
    isOnHold() {
        return this._onHold != null;
    }
    async enableScreenshare(enable: boolean) {
        if (this._onHold) {
            this._onHold.enableScreenshare = enable;
            return;
        }
        if (enable === this._isSharingScreen) {
            console.warn("enableScreenshare: No change");
            return Promise.resolve();
        }
        await this._updateSentTracks(() => this._isSharingScreen = enable );
        if (this._isSharingScreen !== enable) { // failed to enable/disable or something interfered
            return;
        }
        if (this._isSharingScreen) {
            this._fire("onScreenshare", true, this.screenShareType());
        } else {
            this._fire("onScreenshare", false);
        }
    }
    screenShareType() {
        let ssTrack = this._screenTrack;
        if (!ssTrack) {
            return ScreenShareType.kInvalid;
        }
        let label = ssTrack.label;
        if (label.startsWith("screen:")) {
            return ScreenShareType.kWholeScreen;
        } else if (label.startsWith("window:")) {
            return ScreenShareType.kWindow;
        } else if (label.startsWith("web-contents-media-stream")) {
            return ScreenShareType.kBrowserTab;
        } else {
            console.warn("Could not determine screensharing type from track label", label);
            return ScreenShareType.kInvalid;
        }
    }
    onScreenSharingStoppedByUser() {
        console.warn("Screen sharing stopped by user");
        // In theory this may be called immediately from within _getLocalTracks when the track onended
        // handle is attached. In that case, we need to go through the message loop to avoid recursion
        var self = this;
        setTimeout(function() {
            self._updateSentTracks(() => {
                self._isSharingScreen = false;
                self._fire("onScreenshare", false);
            });
        }, 0);
    }
    _setConnState(state: ConnState) {
        this._connState = state;
    }
    async onPacket(event: any){
        //Get protocol message
        const msg = JSON.parse(event.data);
        if (this.inputPacketQueue) {
            this.inputPacketQueue.push(msg);
        } else {
            this.processMessage(msg);
        }
    }

    processMessage(msg: Dict) {
        if (msg.err != null) {
            if (msg.err !== TermCode.kUserHangup) {
                let strError = TermCode[msg.err];
                let logMsg = "Server closed connection with error ";
                logMsg += strError ? strError : `(${msg.err})`;
                if (msg.msg) {
                    logMsg += ": " + msg.msg;
                }
                console.warn(logMsg);
            } else {
                console.warn(`Call was ended by moderator ${msg.by || "<anonymous>"}`);
            }
            this.disconnect(msg.err, true); // may be retriable, i.e. kSvrShuttingDown
            return;
        }
        if (msg.warn != null) {
            console.warn("SFU server WARNING:", msg.warn);
            return;
        }
        let handler = SfuClient.msgHandlerMap[msg.a];
        if (handler) {
            handler.call(this, msg);
        } else {
            console.warn("Ingoring unknown packet", msg.a);
        }
    }

    processInputQueue() {
        assert(this.inputPacketQueue);
        for(;;) {
            let msg = this.inputPacketQueue!.shift();
            if (!msg) {
                break;
            }
            this.processMessage(msg);
        }
        delete this.inputPacketQueue;
    }

    assignCid(cid: number) {
        this.cid = cid;
        this.cryptoWorker.postMessage(['cid', this.cid]);
    }
    _addPeer(peer: Peer) {
        this.peers.set(peer.cid, peer);
        if (this.maxPeers < this.peers.size) {
            this.maxPeers = this.peers.size;
        }
    }
    _removePeer(peer: Peer) {
        this._speakerDetector.unregisterPeer(peer);
        this.peers.delete(peer.cid);
        this.cryptoWorker.postMessage(['dpk', this.cid]);
    }
    async msgAnswer(msg: Dict) {
        this.inputPacketQueue = [];
        assert(msg.cid);
        this.assignCid(msg.cid);
        if (msg.mod) {
            this._isModerator = true;
            this._fire("onModerator", this._isModerator);
        }
        this._tsCallJoin = Date.now();
        this._tsCallStart = this._tsCallJoin - msg.t;
        this.joinToffs = msg.t;
        this._statsRecorder.start();
        await this.newKeyImmediate();
        if (msg.peers) {
            for (let peerCid of msg.peers) {
                new Peer(this, peerCid, true);
            }
            this.encryptAndSendLastKeyToAllPeers();
        }
        let sdp;
        try {
            let tsStart = Date.now();
            sdp = sdpUncompress(msg.sdp);
            console.log("Setting answer SDP...");
            await this.rtcConn!.setRemoteDescription(new RTCSessionDescription({
                type:'answer',
                sdp: sdp
            }));
            console.warn("setRemoteDescription completed in %d ms", Date.now() - tsStart);
        } catch(ex) {
            this.logError("setRemoteDescrition failed:", ex, "\nsdp:\n" + sdp);
            return;
        }

        // fire onJoined before any requests for tracks, otherwise - stream data is received BEFORE the client app even
        // knows that this user had joined
        this._joinRetries = 0;
        this._setConnState(ConnState.kJoined);
        this._fire("onJoined");
        this.enableStats();

        this.setThumbVtrackResScale();
        if (msg.vthumbs) {
            this.handleIncomingVideoTracks(msg.vthumbs, false);
        }

        let speakers = msg.speakers;
        if (speakers) {
            for (let strCid in speakers) {
                let info = speakers[strCid];
                let cid = parseInt(strCid);
                assert(!isNaN(cid));
                this.addPeerSpeaker(cid, info);
            }
        }
        setTimeout(() => this.processInputQueue(), 0);
    }

    setThumbVtrackResScale() {
        let height;
        if (this._isSharingScreen) {
            height = SfuClient.kScreenCaptureOptions.video.height.max;
        } else {
            if (!this._cameraTrack || !(height = this._cameraTrack.getSettings().height)) {
                height = SfuClient.kVideoCaptureOptions.height;
            }
        }
        assert(height);
        let scale = height / SfuClient.kVthumbHeight;
        this.outVThumbTrack.setEncoderParams((params: RTCRtpEncodingParameters) => {
            params.scaleResolutionDownBy = scale;
            params.maxBitrate = 100 * 1024;
        });
    }
    get tsCallStart() {
        return this._tsCallStart;
    }
    get tsCallJoin() {
        return this._tsCallJoin;
    }
    msgPeerJoin(msg: Dict) {
        if (!msg.cid || !msg.userId || msg.av == null) {
            console.warn("Invalid PEERJOIN packet");
            return;
        }
        let peer = new Peer(this, msg);
        // rotate only if peer is not the first one to see our most recent key
        if (!this._lastPeerJoinLeave || (
            (this._lastPeerJoinLeave.userId === msg.userId) &&
            (Date.now() - this._lastPeerJoinLeave.ts <= SfuClient.kPeerReconnNoKeyRotationPeriod))
        ) {
            console.warn("This is the first peer, or they just reconnected, NOT rotating key");
            peer.encryptAndSendLastKey();
        } else {
            this.rotateKey();
        }
        this._lastPeerJoinLeave = { userId: msg.userId, ts: Date.now() };
    }

    async msgPeerLeft(msg: Dict) {
        let cid = msg.cid;
        let peer = this.peers.get(cid);
        if (!peer) {
            console.warn("PEERLEFT: Unknown peer cid", cid);
            return;
        }
        this._lastPeerJoinLeave = { userId: peer.userId, ts: Date.now() };
        // removes peer from peer list, destroys players, fires onPeerLeft
        peer.destroy(msg.rsn !== null ? msg.rsn : TermCode.kSigDisconn);
        this.rotateKey();
    }

    handleIncomingVideoTracks(tracks: Dict, isHiRes:  boolean) {
        for (let strCid in tracks) {
            let cid = parseInt(strCid);
            let peer = this.peers.get(cid);
            if (!peer) {
                console.warn("Unknown peer cid", cid);
                continue;
            }
            let info = tracks[cid];
            if (isHiRes) {
                peer.incomingHiResVideoTrack(info);
            } else {
                peer.incomingVthumbTrack(info);
            }
        }
    }

    msgVthumbTracks(msg: Dict) {
        this.handleIncomingVideoTracks(msg.tracks, false);
    }

    msgHiresTracks(msg: Dict) {
        this.handleIncomingVideoTracks(msg.tracks, true);
    }

    requestSvcLayers(spt: number, tmp: number, screenTmp: number) {
        this.send({
            a : "LAYER",
            spt: spt,
            tmp: tmp,
            stmp: screenTmp
        });
    }
    isSpeaker() {
        return this._speakerState === SpeakerState.kActive;
    }
    enableSpeakerDetector(enable: boolean) {
        this._speakerDetector.enable(enable);
    }
    isSharingScreen() {
        return this._onHold ? this._onHold.isSharingScreen : this._isSharingScreen;
    }
    isSendingScreenHiRes() {
        return this._screenTrack && this.outVSpeakerTrack.sentTrack === this._screenTrack;
    }
    sendSpeakRequest(cid?: number) {
        let cmd: Dict = {a: "SPEAK_RQ"};
        if (cid) {
            cmd.cid = cid;
        } else {
            cmd.av = this.obtainedAv();
        }
        this.send(cmd);
    }

    cancelSpeakRequest(cid: number) {
        let cmd: Dict = {a: "SPEAK_RQ_DEL"};
        if (cid) {
            cmd.cid = cid;
        }
        this.send(cmd);
    }

    async requestStartSpeaking() {
        if (this._speakerState) {
            return;
        }
        this._speakerState = SpeakerState.kPending;
        await this._getLocalTracks();
        this.sendSpeakRequest();
    }

    stopSpeaking() {
        this.send({a: "SPEAKER_DEL"});
    }

    async onStartSpeaking() {
        if (this._speakerState !== SpeakerState.kPending) {
            return; // we should have just sent a cancel message, which will stop the SFU from treating us as speaker
        }

        await this._updateSentTracks(() => this._speakerState = SpeakerState.kActive);
        this._fire("onSpeaker");
    }

    async onStopSpeaking() {
        if (!this._speakerState) {
            return;
        }
        await this._updateSentTracks(() => this._speakerState = SpeakerState.kNoSpeaker);
        this._fire("onNoSpeaker");
    }

    addPeerSpeaker(cid: number, info: Dict) {
        assert(cid !== this.cid);
        let peer = this.peers.get(cid);
        if (!peer) {
            this.logError("addPeerSpeaker: Unknown cid", cid);
            debugger;
            return null;
        }
        let audio = info.audio;
        if (!audio) {
            this.logError("addPeerSpeaker: Missing audio track in track info");
            return null;
        }
        let slot = this.inAudioTracks.get(audio.mid);
        if (!slot) {
            this.logError("addPeerSpeaker: Unknown audio track mid", audio.mid);
            return null;
        }
        slot.reassign(cid, audio.iv);
        peer.onSpeaker(slot);

        let video = info.video;
        if (!video) {
            return peer;
        }
        peer.incomingHiResVideoTrack(video);
        //  this.send({a: "LAYER", mid: video.mid, spt: 2, tmp: 2});
        return peer;
    }

    msgSpeakRequestDel(msg: Dict) {
        if (msg.cid === this.cid) {
            this._fire("onOwnSpeakRequestDel");
            if (this._speakerState === SpeakerState.kActive) { // we were approved
                return;
            }
            this._speakerState = SpeakerState.kNoSpeaker;
            this._getLocalTracks();
        } else {
            let peer = this.peers.get(msg.cid);
            if (!peer) {
                console.warn("Unknown peer cid", msg.cid);
                return;
            }
            peer.delSpeakReq();
        }
    }

    msgHiresStart(msg: Dict) {
        if (this._onHold) {
            this._onHold.sendHires = true;
            return;
        }
        this._updateSentTracks(() => this._sendHires = true );
    }

    msgHiresStop(msg: Dict) {
        if (this._onHold) {
            this._onHold.sendHires = false;
            return;
        }
        this._updateSentTracks(() => this._sendHires = false );
    }

    msgVthumbStart(msg: Dict) {
        if (this._onHold) {
            this._onHold.sendVthumb = true;
            return;
        }
        this._updateSentTracks(() => this._sendVthumb = true );
    }

    msgVthumbStop(msg: Dict) {
        if (this._onHold) {
            this._onHold.sendVthumb = false;
            return;
        }
        this._updateSentTracks(() => this._sendVthumb = false );
    }

    msgSpeakOn(msg: Dict) {
        if (!msg.cid) {
            this.onStartSpeaking();
        } else {
            this.addPeerSpeaker(msg.cid, msg);
        }
    }
    async msgSpeakOff(msg: Dict) {
        if (!msg.cid) {
            this.onStopSpeaking();
        } else {
            this.delPeerSpeaker(msg.cid);
        }
    }
    delPeerSpeaker(cid: number) {
        let peer = this.peers.get(cid);
        if (!peer) {
            console.warn("delPeerSpeaker: Unknown peer cid", cid);
            return null;
        }
        peer.onNoSpeaker();
        return peer;
    }

    msgAv(msg: Dict) {
        let cid = msg.cid;
        assert(cid);
        if (cid === this.cid) {
            console.warn("msgAv: Received our own av flags");
            return;
        }
        let peer = this.peers.get(msg.cid);
        if (!peer) {
            console.warn("msgAv: Unknown peer with cid", msg.cid);
            return;
        }
        peer.onAvChange(msg.av);
    }

    msgSpeakReqs(msg: Dict) {
        for (let cid of msg.cids) {
            if (cid === this.cid) {
                this._fire("onOwnSpeakRequest"); //TODO: maintain a flag if we are requesting to speak?
                continue;
            }

            let peer = this.peers.get(cid);
            if (!peer) {
                console.warn("Unknown cid", cid);
                continue;
            }
            peer.setSpeakReq();
        }
    }

    msgMod(msg: Dict) {
        if (!msg.cid) {
            this._isModerator = msg.mod;
            this._fire("onModerator", msg.mod);
        } else {
            let peer = this.peers.get(msg.cid);
            if (!peer) {
                console.warn("msgMod: Unknown peer cid", msg.cid);
                return;
            }
            peer._fire("onPeerModerator", msg.mod);
        }
    }
    enableStats() {
        if (this.statTimer) {
            return;
        }
        this.statCtx = {};
        this.statTimer = setInterval(this.pollStats.bind(this), 1000);
    }
    disableStats() {
        if (!this.statTimer) {
            return;
        }
        clearInterval(this.statTimer);
        delete this.statTimer;
    }
    async pollTxVideoStats() {
        let isHiRes;
        let sender = this.outVSpeakerTrack.xponder.sender;
        if (sender.track) {
            isHiRes = true;
        } else {
            sender = this.outVThumbTrack.xponder.sender;
            isHiRes = false;
        }
        if (!sender.track) {
            if (this.app.onVideoTxStat) {
                this.app.onVideoTxStat(null);
            }
            return;
        }
        let stats = await sender.getStats();
        this.parseTxVideoStats(stats, isHiRes);
    }
    async pollMicAudioLevel() {
        let sender = this.outASpeakerTrack.xponder.sender;
        if (!sender.track) {
            return;
        }
        let stats = await sender.getStats();
        for (let item of stats.values()) {
            if (item.type === "media-source") {
                this.micMuteMonitor.onLevel(this.micAudioLevel = item.audioLevel);
                return;
            }
        }
    }
    async pollStats() {
        if (this._connState !== ConnState.kJoined) {
            console.warn("pollStats called while not in kJoined state");
            return;
        }
        let stats: Dict = this.rtcStats = {pl: 0, jtr: 1000000};
        this.hasConnStats = false;
        let promises = [this.pollTxVideoStats(), this.pollMicAudioLevel()];

        for (let rxTrack of this.inVideoTracks.values()) {
            if (!rxTrack.active) {
                continue;
            }
            promises.push(rxTrack.pollRxStats());
        }
        for (let rxTrack of this.inAudioTracks.values()) {
            if (!rxTrack.active) {
                continue;
            }
            promises.push(rxTrack.pollRxStats());
        }

        if (promises.length) {
            await Promise.allSettled(promises);
        }
        if (!this.hasConnStats) {
            await this.getConnStatsFromPeerConn();
        }
        if (stats.rx == null && stats.tx == null) {
            return;
        }
        this.addNonRtcStats();
        if (stats.jtr === 1000000) {
            stats.jtr = -1;
        }
        if (stats.pl != null) {
            stats.pl = Math.round(stats.pl * 10) / 10; // truncate to single decimal
        }
        this._statsRecorder.onStats(this.rtcStats);
        this._svcDriver.onStats();
    }
    addNonRtcStats() {
        let stats: Dict = this.rtcStats!;
        stats.q = this._svcDriver.currRxQuality | (this._svcDriver.currTxQuality << 8);
        stats.av = this._sentAv;
        let nrxa = 0;
        let nrxl = 0;
        let nrxh = 0;
        for (let peer of this.peers.values()) {
            if (peer.isSpeaker) {
                nrxa++;
            }
            if ((peer.av & Av.onHold) === 0) {
                let player: any = peer.hiResPlayer;
                if (player && player.slot) {
                    nrxh++;
                }
                player = peer.vThumbPlayer;
                if (player) {
                    let slot = player.slot;
                    if (slot && !slot.isHiRes) {
                        nrxl++;
                    }
                }
            }
        }
        stats.nrxh = nrxh;
        stats.nrxl = nrxl;
        stats.nrxa = nrxa;
    }
    parseTxVideoStats(stats: Dict, isHiRes: boolean) {
        let getConnTotals = !this.hasConnStats;
        let rtcStats = this.rtcStats!;
        let txStat;
        for (let stat of stats.values()) {
            let type = stat.type;
            if (type === "outbound-rtp") {
                let tag;
                if (isHiRes) {
                    tag = (this.outVSpeakerTrack.sentTrack === this._screenTrack) ? "hi-scr" : "hi-cam";
                } else {
                    tag = "vthumb";
                }
                let ctx = this.statCtx[tag];
                if (!ctx) {
                    ctx = this.statCtx[tag] = {};
                }
                if (!ctx.prev) {
                    ctx.prev = stat;
                } else {
                    let prev = ctx.prev;
                    ctx.prev = stat;
                    let period = (stat.timestamp - prev.timestamp) / 1000;
                    rtcStats._vtxIsHiRes = isHiRes;
                    if (isNaN((rtcStats._vtxkbps = ((stat.bytesSent - prev.bytesSent) / 128) / period))) {
                        rtcStats._vtxkbps = 0;
                    }
                    rtcStats.vtxfps = stat.framesPerSecond;
                    rtcStats.vtxw = stat.frameWidth;
                    rtcStats.vtxh = stat.frameHeight;
                    rtcStats._vtxkfps = (stat.keyFramesEncoded - prev.keyFramesEncoded) / period;
                    txStat = stat;
                //  console.log("tag:", tag, "nacks:", stat.nackCount, "pli:", stat.pliCount, "fir", stat.firCount, "vtxh:", rtcStats.vtxh);
                }
                if (!getConnTotals) {
                    break;
                }
            } else if (getConnTotals && type === "candidate-pair" && stat.nominated) {
                this.parseConnStats(stat);
                getConnTotals = false;
            }
        }
        if (this.app.onVideoTxStat) {
            if (txStat) {
                // we may not have conn totals yet, so do the callback after returning
                this.app.onVideoTxStat(isHiRes, rtcStats, txStat);
            } else {
                this.app.onVideoTxStat(null);
            }
        }
    }
    parseConnStats(stat: Dict) {
        let s = this.rtcStats!;
        s.rtt = stat.currentRoundTripTime * 1000;
        let txBwe = stat.availableOutgoingBitrate;
        if (txBwe != null) {
            s.txBwe = Math.round(txBwe / 1024);
        }
        let ctx = this.statCtx;
        this.hasConnStats = true;
        if (!ctx.prevTx) {
            ctx.prevTx = stat;
            return;
        }
        let prev = ctx.prevTx;
        ctx.prevTx = stat;
        let per = (stat.timestamp - prev.timestamp) / 1000;
        s.rx = Math.round(((stat.bytesReceived - prev.bytesReceived) / 128) / per);
        s.tx = Math.round(((stat.bytesSent - prev.bytesSent) / 128) / per);
    }
    async getConnStatsFromPeerConn() {
        if (!this.rtcConn) {
            return;
        }
        let stats = await this.rtcConn.getStats();
        for (let stat of stats.values()) {
            if (stat.type === "candidate-pair" && stat.nominated === true) {
                this.parseConnStats(stat);
            }
        }
    }
    mungeSdpForSvc(media: Dict) {
        let ssrcs = media.ssrcs;
        let vidSsrc1 = ssrcs[0];
        let fidSsrc1 = ssrcs[1];
        let id = vidSsrc1.id;
        let vidSsrc2 = {id: ++id, cname: vidSsrc1.cname};
        let vidSsrc3 = {id: ++id, cname: vidSsrc1.cname};

        id = fidSsrc1.id;
        let fidSsrc2 = {id: ++id, cname: fidSsrc1.cname};
        let fidSsrc3 = {id: ++id, cname: fidSsrc1.cname};
        media.ssrcs = [vidSsrc1, vidSsrc2, vidSsrc3, fidSsrc1, fidSsrc2, fidSsrc3];
        media.ssrcg = [
            "SIM " + vidSsrc1.id + " " + vidSsrc2.id + " " + vidSsrc3.id,
            media.ssrcg[0],
            "FID " + vidSsrc2.id + " " + fidSsrc2.id,
            "FID " + vidSsrc3.id + " " + fidSsrc3.id
        ];
    }
    static msgHandlerMap: Dict = {
        "AV": SfuClient.prototype.msgAv, // someone changed what they send (audio, camera, screen)
        "ANSWER": SfuClient.prototype.msgAnswer, // SFU answer t our join
        "PEERJOIN": SfuClient.prototype.msgPeerJoin, // someone joined
        "PEERLEFT": SfuClient.prototype.msgPeerLeft, // someone left
        "VTHUMBS": SfuClient.prototype.msgVthumbTracks, // video thumbnail tracks, in response to GET_VTHUMBS
        "HIRES": SfuClient.prototype.msgHiresTracks, // hi-res video tracks, in response to GET_HIRES
        "HIRES_START": SfuClient.prototype.msgHiresStart, // we are requested to start sendind hires video
        "HIRES_STOP": SfuClient.prototype.msgHiresStop, // we are requested to stop sending hires video
        "VTHUMB_START": SfuClient.prototype.msgVthumbStart, // we are requested to start sendind hires video
        "VTHUMB_STOP": SfuClient.prototype.msgVthumbStop, // we are requested to stop sending hires video
        "SPEAK_REQS": SfuClient.prototype.msgSpeakReqs, // list of pending speaker requests
        "SPEAK_RQ_DEL": SfuClient.prototype.msgSpeakRequestDel, // delete speaker request
        "SPEAK_ON": SfuClient.prototype.msgSpeakOn, // we or a peer became a speaker
        "SPEAK_OFF": SfuClient.prototype.msgSpeakOff, // we or a peer are no longer a speaker
        "KEY": SfuClient.prototype.msgKey, // encryption keys of peers
        "MOD": SfuClient.prototype.msgMod, // moderator flag for our client was changed
    };
}

class Slot {
    client: SfuClient;
    xponder: RTCRtpTransceiver;
    sentTrack: MediaStreamTrack | null;
    iv: Uint8Array;
    active: boolean = false;
    protected rxStatCtx: Dict = {};
    // needs to be accessed by VideoPlayer
    rxStatsCallbacks: Map<any, Function> = new Map; // key is a VideoPlayer object that receives the stats
    protected _mid?: number;
    cid: number;
    tsStart: number;
    isVideo?: boolean;
    constructor(client: SfuClient, xponder: RTCRtpTransceiver, generateIv?: boolean) {
        this.client = client;
        this.xponder = xponder;
        (xponder as any).slot = this;
        this.sentTrack = null;
        if (generateIv) {
            this.iv = randomBuf(8);
        }
    }
    get mid() {
        if (this._mid != null) {
            return this._mid;
        }
        return this._mid = parseInt(this.xponder.mid!);
    }
    createDecryptor() {
        let receiver = this.xponder.receiver;
        let rxStreams = (receiver as any).createEncodedStreams();
        this.client.cryptoWorker.postMessage(['cd', rxStreams.readable, rxStreams.writable, this.mid],
            [rxStreams.readable, rxStreams.writable]);
    }
    createEncryptor() {
        let sender = this.xponder.sender;
        let txStreams = (sender as any).createEncodedStreams();
        this.client.cryptoWorker.postMessage(['ce', txStreams.readable, txStreams.writable, this.mid,
            this.iv], [txStreams.readable, txStreams.writable]);
    }
    reassign(fromCid: number, iv: string) {
        this.cid = fromCid;
        // TODO: was parseInt(fromCid)
        this.client.cryptoWorker.postMessage(['dt', this.mid, fromCid, hexToBin(iv)]);
        this.active = true;
    }
    sendTrack(track: MediaStreamTrack|null) {
        if (track === this.sentTrack) {
            return Promise.resolve();
        }
        this.sentTrack = track;
        return this.xponder.sender.replaceTrack(track)
        .then(() => this.tsStart = Date.now());
    }
    get outTrack() {
        return this.sentTrack;
    }
    get inTrack() {
        return this.xponder.receiver.track;
    }
    isSendingTrack() {
        return this.sentTrack != null;
    }
    async pollRxStats() {
        let client = this.client;
        let commonStats = client.rtcStats!;
        let ctx = this.rxStatCtx;
        let rtpParsed;

        let stats = await this.xponder.receiver.getStats();
        let parseConnStats = !client.hasConnStats;
        for (let stat of stats.values()) {
            if (stat.type === "inbound-rtp") {
                rtpParsed = true;
                if (!ctx.prev) {
                    ctx.prev = stat;
                } else {
                    let prev = ctx.prev;
                    ctx.prev = stat;
                    let period = (stat.timestamp - prev.timestamp) / 1000;

                    let plostPerSecond = (stat.packetsLost - prev.packetsLost) / period;
                    commonStats.pl += plostPerSecond;

                    if (!this.isVideo) {
                        if (stat.jitter != null) {
                            let jtr = Math.round(stat.jitter * 1000);
                            if (commonStats.jtr > jtr) {
                                commonStats.jtr = jtr;
                            }
                        }
                    } else { // video stats
                        if (commonStats.mrxw == null || commonStats.mrxw < stat.frameWidth) {
                            commonStats.mrxw = stat.frameWidth;
                            commonStats.mrxfps = stat.framesPerSecond;
                        }
                        let cbs = this.rxStatsCallbacks;
                        if (cbs.size) {
                            // more detailed stats for app
                            let info = {
                                plost: plostPerSecond,
                                nacktx: (stat.nackCount - prev.nackCount) / period,
                                kbps: ((stat.bytesReceived - prev.bytesReceived) / 128) / period,
                                keyfps: (stat.keyFramesDecoded - prev.keyFramesDecoded) / period
                            };
                            for (let cb of cbs.values()) { // may get unassigned while getting stats
                                cb(this, info, stat);
                            }
                        }
                    }
                }
                if (!parseConnStats) {
                    return;
                }
            } else if (parseConnStats && stat.type === "candidate-pair" && stat.nominated) {
                this.client.parseConnStats(stat);
                parseConnStats = false;
                if (rtpParsed) {
                    return;
                }
            }
        }
    }
}

class VideoSlot extends Slot {
    players: Set<VideoPlayer> = new Set<VideoPlayer>();
    protected _releaseTrackCb?: Function;
    isHiRes: boolean = false;
    sentLayers: number = SfuClient.kSpatialLayerCount;
    constructor(client: SfuClient, xponder: RTCRtpTransceiver, generateIv?: boolean) {
        super(client, xponder, generateIv);
        this.isVideo = true;
    }
    reassignV(fromCid: number, iv: string, isHiRes: boolean, noDetach: boolean, releaseCb: Function) {
        this.isHiRes = isHiRes;
        if (!noDetach) {
            this._detachAllPlayers();
        } else { // track reusing can be done only for the same cid, for hires<->lowres interchange
            assert(fromCid === this.cid);
        }
        this._releaseTrackCb = releaseCb;
        super.reassign(fromCid, iv);
    }
    setEncoderParams(cb: Function) {
        let sender = this.xponder.sender;
        let params: any = sender.getParameters(); // this may block for > 1000ms!
        var encodings = params.encodings;
        if (!encodings) {
            params.encodings = [{}]; // firefox kludge
        } else if (!encodings.length) {
            encodings.push({});
        }
        var enc0 = params.encodings[0];
        if (cb(enc0) === false) {
            return Promise.resolve();
        }
        return sender.setParameters(params);
    }
    /*
    setTxSvcLayerCount(count: number) {
        this.sentLayers = count;
        let sender = this.xponder.sender;
        if (!sender) {
            console.warn(`setTxSvcLayerCount: Currently not sending track, will only record value`);
            return Promise.resolve();
        }
        let params: any = sender.getParameters();
        let encs = params.encodings;
        if (!encs || encs.length < 2) {
            console.warn("setTxSvcLayerCount: There is no SVC enabled for this sender");
            return Promise.resolve();
        }
        for (let i = 0; i < encs.length; i++) {
            encs[i].active = i < count;
        }
        console.warn(`setTxSvcLayerCount: Enabling only first ${count} layers`);
        return sender.setParameters(params);
    }
    */
    _detachAllPlayers() {
        if (!this.players.size) {
            return;
        }
        for (let player of this.players) {
            player._onTrackGone(this);
        }
        if (this.players.size) debugger;
    }
    _onDetachedFromPlayer(player: VideoPlayer) {
        if (!this.players.has(player)) {
            console.warn("Slot.detachFromPlayer: Was not attached to that player");
            return;
        }
        this.players.delete(player);
        //console.warn("slot %s detach from player -> refcnt = ", this.isHiRes ? "hires":"lores", this.players.size);
        if (!this.players.size && this._releaseTrackCb) {
            this.active = false;
            this._releaseTrackCb();
        }
    }
    _onAttachedToPlayer(player: VideoPlayer) {
        if (this.players.has(player)) {
            console.warn("Slot.attachToPlayer: Already attached to that player");
            return;
        }
        this.players.add(player);
        //console.warn("slot %s attach to player -> refcnt = ", this.isHiRes ? "hires":"lores", this.players.size);
    }
}

class VideoPlayer {
    peer: Peer;
    _isHiRes: boolean;
    slot?: VideoSlot; // supports detaching
    player: HTMLVideoElement;
    gui: IVideoPlayerGui;
    constructor(peer: Peer, isHiRes?: boolean) {
        this.peer = peer;
        this._isHiRes = !!isHiRes;
        this.player = document.createElement("video");
        this.gui = peer.client.app.onNewPlayer(this);
    }
    get isHiRes() {
        return this._isHiRes;
    }
    get userId() {
        return this.peer.userId;
    }
    attachToTrack(slot: VideoSlot) {
        assert(slot);
        if (slot === this.slot) {
            console.warn("VideoPlayer.attachToTrack: Already attached to that slot");
            return;
        }
        let prevSlot = this.slot;
        if (this._detachFromCurrentTrack()) {
            console.warn("VideoPlayer: replacing slot %d with %d", prevSlot ? prevSlot.mid : "(null)", slot.mid);
        }

        this.slot = slot;
        slot._onAttachedToPlayer(this);
        this.gui.onAttachedToTrack();
        playerPlay(this.player, slot.inTrack);
        if (this.gui.onRxStats) {
            slot.rxStatsCallbacks.set(this, this.gui.onRxStats.bind(this.gui));
        }
    }
    _onTrackGone(slot: VideoSlot) { // called by slot when track is gone, i.e. the slot is unassigned/reassigned
        assert(slot === this.slot);
        this.destroy(); //TODO: Maybe not destroy even if track is gone
    }
    _detachFromCurrentTrack() {
        let slot = this.slot;
        if (!slot) {
            return;
        }
        playerStop(this.player);
        slot.rxStatsCallbacks.delete(this);
        slot._onDetachedFromPlayer(this);
        delete this.slot;
        return true;
    }
    destroy() {
        this._detachFromCurrentTrack();
        delete (this as any).player;
        this.gui.onDestroy();
    }
}

class ThumbPlayer extends VideoPlayer {
    constructor(peer: Peer) {
        super(peer);
        peer.vThumbPlayer = this;
    }
    destroy() {
        if (!this.player) {
            console.warn("ThumbPlayer.destroy: already destroyed");
            return;
        }
        assert(this.peer.vThumbPlayer === this);
        super.destroy();
        this.peer.onVthumbPlayerDestroy();
    }
}

class HiResPlayer extends VideoPlayer {
    resDivider: number;
    vThumbSlot?: VideoSlot;
    vThumbPlayer?: HTMLVideoElement;
    constructor(peer: Peer, resDivider?: number) {
        super(peer, true);
        this.resDivider = resDivider || 0;
        peer.hiResPlayer = this;
    }
    attachToVThumbTrack(slot: VideoSlot) {
        assert(slot);
        assert(!this.vThumbSlot);
        this.vThumbSlot = slot;
        slot._onAttachedToPlayer(this);
        this.vThumbPlayer = document.createElement("video");
        this.gui.onVthumbAttach();
        playerPlay(this.vThumbPlayer, slot.inTrack);
    }
    detachFromVthumbTrack() {
        if (!this.vThumbSlot) {
            return;
        }
        this.vThumbSlot._onDetachedFromPlayer(this);
        this._onVthumbTrackGone();
    }
    _onTrackGone(slot: VideoSlot) { // called when track is gone, i.e. slot is unassigned/reassigned
        if (slot === this.vThumbSlot) {
            this._onVthumbTrackGone();
        } else {
            super._onTrackGone(slot);
        }
    }
    _onVthumbTrackGone() {
        assert(this.vThumbPlayer);
        playerStop(this.vThumbPlayer!);
        delete this.vThumbSlot;
        this.gui.onVthumbDetach();
        delete this.vThumbPlayer;
    }
    destroy() {
        if (!this.player) {
            console.warn("HiResPlayer.destroy: already destroyed");
            return;
        }
        this.detachFromVthumbTrack();
        super.destroy();
        assert(this.peer.hiResPlayer === this);
        this.peer.onHiResPlayerDestroy();
    }
}

function playerPlay(player: HTMLVideoElement|HTMLAudioElement, track: MediaStreamTrack) {
    player.srcObject = new MediaStream([track]);
    let ts = Date.now();
    player.play()
    .then(()=>console.debug("play() returned after %d ms", Date.now() - ts))
    .catch(function(err) {});
}

function playerStop(player: HTMLVideoElement|HTMLAudioElement) {
    player.pause();
    try {
        player.srcObject = null;
    } catch(ex) {}
}

function logReplacerFunc(name: string, val: any) {
    if (name === "av") {
        return `${val}(${Av.toString(val)})`;
    } else if (name === "sdp") {
        return SfuClient.debugSdp ? val : compressedSdpToString(val);
    } else {
        return val;
    }
}

class Peer {
    client: SfuClient;
    handler: any;
    cid: number;
    userId: string;
    av: number;
    data: Dict = {};
    encryptKeyTo: Function;
    isLeaving?: boolean;
    protected _isSpeaker: boolean = false;
    protected _audioLevel: number = 0;
    protected _speakReq: boolean = false;
    vThumbPlayer?: VideoPlayer;
    hiResPlayer?: HiResPlayer;
    vThumbSlot?: VideoSlot;
    hiResSlot?: VideoSlot;
    audioReceiver?: RTCRtpReceiver;
    audioPlayer?: HTMLAudioElement;
    protected slowAudioLevel: number = 0;
    protected _onAudioLevel?: Function;
    constructor(client: SfuClient, info: Dict, isInitialDump?: boolean) {
        assert(info.cid);
        assert(info.userId);
        assert(info.av != null);
        this.client = client;
        this.handler = client.app;
        this.cid = info.cid;
        this.userId = info.userId;
        this.av = info.av;
        this.encryptKeyTo = client.app.encryptKeyTo.bind(client.app); // performance optimization

        client._addPeer(this);
        if (!isInitialDump) {
            this._fire("onPeerJoined");
        }
    }
    get isSpeaker() { return this._isSpeaker; }
    get audioLevel() { return this._audioLevel; }
    get speakRequested() { return this._speakReq; }
    setSpeakReq() {
        if (this._speakReq) {
            return;
        }
        this._speakReq = true;
        this._fire("onPeerSpeakReq");
    }
    delSpeakReq() {
        if (!this._speakReq) {
            return;
        }
        this._speakReq = false;
        this._fire("onPeerSpeakReqDel");
    }
    async encryptKey(key: any) {
        let encKey = await this.encryptKeyTo(key, this.userId);
        return [ this.cid, encKey ];
    }
    encryptAndSendLastKey() {
        var self = this;
        let key = self.client._newestSendKey;
        if (!key) {
            return null;
        }
        this.encryptKeyTo(key.key, this.userId)
        .then(function(encKey: any) {
            if (encKey) {
                self.client.send({a: "KEY", id: key.id & 0xff, data: [[self.cid, encKey]]});
            }
        });
    }
    onVthumbPlayerDestroy() {
        delete this.vThumbPlayer;
    }
    onHiResPlayerDestroy() {
        delete this.hiResPlayer;
        if (!this.isLeaving) {
            let vtp = this.vThumbPlayer;
            if (vtp && vtp.slot && vtp.slot.isHiRes) {
                this.client.send({a: "GET_VTHUMBS", cids: [this.cid]});
            }
        }
    }
    destroy(reason?: TermCode) {
        this.isLeaving = true;
        this.delSpeakReq();
        this.client._removePeer(this);
        if (this.hiResPlayer) {
            this.hiResPlayer.destroy();
            assert(!this.hiResPlayer);
        }
        if (this.vThumbPlayer) {
            this.vThumbPlayer.destroy();
            assert(!this.vThumbPlayer);
        }
        if (this.audioPlayer) {
            this.client._speakerDetector.unregisterPeer(this);
            playerStop(this.audioPlayer);
            delete this.audioPlayer;
        }
        this._fire("onPeerLeft", reason);
    }
    get hasThumbnailVideo() { return this.vThumbPlayer != null; }
    get hasHiresVideo() { return this.hiResPlayer != null; }

    requestThumbnailVideo() {
        if (this.vThumbPlayer) {
            console.warn("Peer.requestThumbnailVideo: Already requested (player exists)");
            return this.vThumbPlayer.gui;
        }
        let player = new ThumbPlayer(this);
        this.client.send({a: "GET_VTHUMBS", cids: [this.cid]});
        return player.gui;
    }
    requestHiResVideo(resDivider: number) {
        let player = this.hiResPlayer;
        if (player) {
            if (player.resDivider != resDivider) {
                console.warn("Peer.requestHiResVideo: Already requested, but with different res divider, updating it");
                this.setHiResDivider(resDivider || 0);
            } else {
                console.warn("Peer.requestHiResVideo: Already requested (player exists)");
            }
            return player.gui;
        }
        player = new HiResPlayer(this, resDivider);
        let cmd: Dict = {a: "GET_HIRES", cid: this.cid, r: 1 };
        if (resDivider) {
            cmd.lo = resDivider;
        }
        this.client.send(cmd);
        return player.gui;
    }
    incomingVthumbTrack(info: Dict) {
        let slot = this.client.inVideoTracks.get(info.mid);
        if (!slot) {
            this.client.logError("Unknown vtrack mid", info.mid);
            return;
        }
        this.vThumbSlot = slot;
        slot.reassignV(this.cid, info.iv, false, info.r, () => {
            if (slot === this.vThumbSlot) {
                delete this.vThumbSlot;
            }
            if (!this.isLeaving) {
                this.client.send({a: "DEL_VTHUMBS", cids: [this.cid]});
            }
        });

        if (!this.vThumbPlayer) {
            new ThumbPlayer(this);
            assert(this.vThumbPlayer);
        }
        this.vThumbPlayer!.attachToTrack(slot);
        this.handleSpecialCases();
    }
    incomingHiResVideoTrack(info: Dict) {
        let slot = this.client.inVideoTracks.get(info.mid);
        if (!slot) {
            this.client.logError("Unknown vtrack mid", info.mid);
            return;
        }
        this.hiResSlot = slot;
        if (this.vThumbSlot === slot) {
            assert(info.r);
            delete this.vThumbSlot;
        }
        slot.reassignV(this.cid, info.iv, true, info.r, () => {
            if (this.hiResSlot === slot) {
                delete this.hiResSlot;
            }
            if (!this.isLeaving) {
                this.client.send({a: "DEL_HIRES", cids: [this.cid]});
            }
        });
        if (!this.hiResPlayer) {
            new HiResPlayer(this);
            assert(this.hiResPlayer);
        }
        this.hiResPlayer!.attachToTrack(slot);
        this.handleSpecialCases();
    }
    setHiResDivider(divider: number) {
        if (!this.hiResPlayer) {
            console.warn("setHiResDivider: Currently not receiving a hi-res stream for this peer");
            return;
        }
        if (divider < 0 || divider > 2) {
            console.warn(`setHiResDivider: invalid resolution divider value (spatial layer offset) ${divider}, must be 0, 1 or 2`);
            return;
        }
        this.hiResPlayer.resDivider = divider;
        this.client.send({a: "HIRES_SET_LO", cid: this.cid, lo: divider});
    }
    onAvChange(av: number) {
        if (av === this.av) {
            console.warn("Peer.onAvChange: No actual change in av flags");
            return;
        }
        this.av = av;
        this.handleSpecialCases();
        this._fire("onPeerAvChange", av);
        this._notifyPlayers("onAvChange", av);
    }
    _notifyPlayers(event: string, ...args: any[]) {
        if (this.vThumbPlayer) {
            let playerGui = this.vThumbPlayer.gui;
            let handler = (playerGui as any)[event];
            if (handler) {
                handler.call(playerGui, ...args);
            }
        }
        if (this.hiResPlayer) {
            let playerGui = this.hiResPlayer.gui;
            let handler = (playerGui as any)[event];
            if (handler) {
                handler.call(playerGui, ...args);
            }
        }
    }
    handleSpecialCases() {
        if (this.sendsCameraAndScreen()) {
            if (this.hiResPlayer && this.vThumbSlot && !this.hiResPlayer.vThumbSlot) {
                this.hiResPlayer.attachToVThumbTrack(this.vThumbSlot);
            }
        } else {
            if (this.hiResPlayer && this.hiResPlayer.vThumbPlayer) {
                // peer doesn't send cam + screen, but we have a vthumb in the hi-res player, remove it
                this.hiResPlayer.detachFromVthumbTrack();
            }
            if (this.vThumbPlayer && this.hiResSlot && this.vThumbPlayer.slot !== this.hiResSlot) {
                this.vThumbPlayer.attachToTrack(this.hiResSlot);
            }
        }
    }
    sendsCameraAndScreen() {
        return Av.hasCamAndScreen(this.av);
    }
    onSpeaker(slot: Slot) {
        if (this._isSpeaker) {
            this.client.logError("Peer.onSpeaker: Peer %d is already a speaker",  this.cid);
            return;
        }
        this._isSpeaker = true;
        let rx = this.audioReceiver = slot.xponder.receiver;
        let player = this.audioPlayer = document.createElement("audio");
        this._fire("onPeerSpeaker");
        this._notifyPlayers("onSpeaker", true);
        playerPlay(player, rx.track);
        this.slowAudioLevel = 0.0;
        this.client._speakerDetector.registerPeer(this);
    }
    onNoSpeaker() {
        if (!this._isSpeaker) {
            console.warn("Peer.onNoSpeaker: Peer %d was not a speaker", this.cid);
            return;
        }
        this._isSpeaker = false;
        playerStop(this.audioPlayer!);
        this.client._speakerDetector.unregisterPeer(this);
        this._fire("onPeerNoSpeaker");
        this._notifyPlayers("onSpeaker", false);
        delete this.audioPlayer;
    }
    requestAudioLevel(cb: Function) {
        this._onAudioLevel = cb;
    }
    pollAudioLevel(trackSlow?: boolean) {
        if (!this.audioReceiver) {
            return 0.0;
        }
        let info = this.audioReceiver.getSynchronizationSources()[0];
        if (!info) {
            return 0.0;
        }
        let currLevel = info.audioLevel;
        if (currLevel == null) {
            currLevel = 0.0;
        }
        if (this._onAudioLevel) {
            this._onAudioLevel(currLevel);
        }
        return trackSlow
            ? this.slowAudioLevel = (this.slowAudioLevel * 9 + currLevel) / 10
            : undefined;
    }
    _fire(evName: string, ...args: any[]) {
        let method = this.handler[evName];
        if (!method) {
            console.warn(`Peer: Unhandled event: ${evName}(${args.join(",")})`);
            return;
        }
        console.log("fire [" + evName + "]");
        try {
            if (args) {
                method.call(this.handler, this, ...args);
            } else {
                method.call(this.handler, this);
            }
        } catch(ex) {
            this.client.logError("Event handler for", evName, "threw exception:", ex.stack);
        }
    }
}
interface PromiseWithResolveMethods extends Promise<any> {
    resolve(val?: any): void;
    reject(err?: any): void;
    done: boolean;
}
function createPromiseWithResolveMethods(): PromiseWithResolveMethods {
    let cbResolve: Function;
    let cbReject: Function;
    var pms: any = new Promise(function(resolve, reject) {
        cbResolve = resolve;
        cbReject = reject;
    });
    pms.resolve = function(val: any) {
        if (pms.done) {
            return;
        }
        pms.done = true;
        cbResolve(val);
    };
    pms.reject = function(err: any) {
        if (pms.done) {
            return;
        }
        pms.done = true;
        cbReject(err);
    };
    return pms;
}

function randomBuf(binLen: number) {
    var bin = new Uint8Array(binLen);
    crypto.getRandomValues(bin);
    return bin;
}

const hexDigits = "0123456789abcdef";
function binToHex(arr: any) {
    var result = "";
    arr = new DataView(arr.buffer || arr);
    for (let i=0; i<arr.byteLength; i++) {
        let val = arr.getUint8(i);
        result += hexDigits.charAt(val >>> 4);
        result += hexDigits.charAt(val & 0x0f);
    }
    return result;
}
function hexDigitVal(chCode: number) {
    if (chCode <= 57) { // ascii code if '9'
        return chCode - 48; // ascii code of '0'
    } else if (chCode >= 97) { // 'a'
        return 10 + chCode - 97;
    } else {
        return 10 + chCode - 65; // 'A'
    }
}
function hexToBin(hexStr: string) {
    let bin = new Uint8Array(hexStr.length >>> 1);
    for (let pos = 0, binPos = 0; pos < hexStr.length; binPos++) {
        bin[binPos] = (hexDigitVal(hexStr.charCodeAt(pos++)) << 4) | hexDigitVal(hexStr.charCodeAt(pos++));
    }
    return bin;
}

class RequestBarrier {
    protected _busy?: Promise<any>;
    async callFunc(thisObj: any, func: Function, ...args: any[]) {
        while (this._busy) {
            await this._busy;
        }
        this._busy = func.call(thisObj, ...args);
        let result = await this._busy;
        delete this._busy;
        return result;
    }
}

class SvcDriver {
    client: SfuClient;
    lowestRttSeen: number;
    static kPlostUpper: number = 20;
    static kPlostLower: number = 14;
    static kPlostCap: number = 10;
    currRxQuality: number;
    currTxQuality: number;
    maRtt?: number;
    maPlost?: number;
    maTxKbps?: number;
    rttLower: number;
    rttUpper: number;
    tsLastSwitch: number;
    constructor(client: SfuClient) {
        this.client = client;
        this.lowestRttSeen = 10000; // force recalculation on first stat sample
        this.currRxQuality = SvcDriver.kMaxRxQualityIndex - 1; // start a little lower
        this.currTxQuality = SvcDriver.kDefaultTxQuality;
    }
    static kRttLowerHeadroom = 30;
    static kRttUpperHeadroom = 250;
    static kMinTimeBetweenSwitches = 6000;
    async onStats() {
        let stats = this.client.rtcStats!;
        let plost = stats.pl;
        let rtt = stats.rtt;
        if (rtt == null) {
            return;
        }
        if (plost == null) {
            plost = 0;
        } else if (plost > SvcDriver.kPlostCap) { // we shouldn't care so much about the magnitude of loss bursts, only about their occurrence
            plost = SvcDriver.kPlostCap;
        }
        if (this.maRtt == null) {
           this.maRtt = rtt;
           this.maPlost = plost;
           return; // intentionally skip first sample for lower/upper range calculation
        }
        if (rtt < this.lowestRttSeen) {
            this.lowestRttSeen = rtt;
            this.rttLower = rtt + SvcDriver.kRttLowerHeadroom;
            this.rttUpper = rtt + SvcDriver.kRttUpperHeadroom;
        }
        rtt = this.maRtt = (this.maRtt * 3 + rtt) / 4;
        plost = this.maPlost = (this.maPlost! * 3 + plost) / 4;

        let tsNow = Date.now();
        if (!this.tsLastSwitch) {
            this.tsLastSwitch = tsNow - SvcDriver.kMinTimeBetweenSwitches;
            return;
        }
        let maTxKbps;
        let adaptScrnTx = stats._vtxIsHiRes && this.client.isSendingScreenHiRes();
        if (adaptScrnTx) { // calculate tx average kbps
            if (this.maTxKbps == null) {
                maTxKbps = this.maTxKbps = stats._vtxkbps;
            } else {
                maTxKbps = this.maTxKbps = (this.maTxKbps * 5 + stats._vtxkbps) / 6;
            }
            console.log("maTxKbps:", maTxKbps, "mom:", stats._vtxkbps);
        }
        if (tsNow - this.tsLastSwitch < SvcDriver.kMinTimeBetweenSwitches) {
            return; // too early
        }
        if (rtt > this.rttUpper || plost > SvcDriver.kPlostUpper) { // rtt or packet loss increased above thresholds
            this.switchRxQuality(-1);
        } else if (rtt < this.rttLower && plost < SvcDriver.kPlostLower) {
            this.switchRxQuality(+1);
        }
        let txQs = SvcDriver.TxQuality;
        if (adaptScrnTx) {
            let currTxQ = SvcDriver.TxQuality[this.currTxQuality];
            if (maTxKbps < currTxQ.minKbps) {
                let q = this.currTxQuality;
                while (maTxKbps < txQs[q].minKbps) {
                    q--;
                    if (q < 0) {
                        q = 0;
                        break;
                    }
                }
                let delta = q - this.currTxQuality;
                if (delta < 0) {
                    this.switchTxQuality(delta, "scr");
                }
            } else {
                let q = this.currTxQuality;
                while (maTxKbps > txQs[q].maxKbps) {
                    q++;
                    if (q >= txQs.length) {
                        q--;
                        break;
                    }
                }
                let delta = q - this.currTxQuality;
                if (delta > 0) {
                    this.switchTxQuality(delta, "scr");
                }
            }
        }
    }
    switchRxQuality(delta: number) {
        let newQ = this.currRxQuality + delta;
        if (newQ > SvcDriver.kMaxRxQualityIndex) {
            newQ = SvcDriver.kMaxRxQualityIndex;
        } else if (newQ < 0) {
            newQ = 0;
        }
        if (newQ === this.currRxQuality) {
            return false;
        }
        let params = SvcDriver.RxQuality[newQ];
        assert(params);

        this.tsLastSwitch = Date.now();
        console.warn(`Switching rx SVC quality from ${this.currRxQuality} to ${newQ}: %o`, params);
        this.currRxQuality = newQ;
        this.client.requestSvcLayers(params[0], params[1], params[2]);
        return true;
    }
    switchTxQuality(delta: number, mode: string) {
        let newQ = this.currTxQuality + delta;
        if (newQ < 0) {
            newQ = 0;
        } else if (newQ > SvcDriver.kMaxTxQualityIndex) {
            newQ = SvcDriver.kMaxTxQualityIndex;
        }
        if (newQ === this.currTxQuality) {
            return false;
        }
        return this.setTxQuality(newQ, mode);
    }
    setTxQuality(newQ: number, mode: string) {
        let track = this.client.outVSpeakerTrack.sentTrack;
        if (!track) {
            return false;
        }
        let info: any = SvcDriver.TxQuality[newQ];
        assert(info);
        this.tsLastSwitch = Date.now();
        let params = info[mode];
        let ar = this.client.screenAspectRatio;
        if (!ar) {
            let res = track.getSettings();
            if (res.width && res.height) {
                ar = this.client.screenAspectRatio = res.width / res.height;
                console.warn(`Screen capture res: ${res.width}x${res.height} (aspect ratio: ${Math.round(ar*1000)/1000})`);
            } else {
                ar = 1.78;
                console.warn("setTxQuality: Could not obtain screen track's resolution, assuming AR of", ar);
            }
        }
        params.width = Math.round(params.height * ar);
        console.warn(`Switching TX quality from ${this.currTxQuality} to ${newQ}: %o (AR: ${
            this.client.screenAspectRatio ? this.client.screenAspectRatio.toFixed(3) : "unknown"})`, params);
        this.currTxQuality = newQ;
        track.applyConstraints(params);
        return true;
    }
    initTx() {
        if (this.client.isSendingScreenHiRes()) {
            // need small delay to have the track started
            setTimeout(this.setTxQuality.bind(this, this.currTxQuality, "scr"), 100);
        }
    }
      // (427)x240 - sends only one spatial layer, i.e. receiver can't get lower resolution than 240
      // (640)x360 - 2 spatial layers: receiver can get x180 or x360
      // (852)x480 - 2 spatial layers: 240 and 480
      // (960)x540 - 3 spatial layers: 136, 270 and 540. This is the camera capture resolution
      // anything above x540 is only for screen sharing, where there are no spatial layers
      // (1028)x578 - screen sharing
      // Array(spatial, temporal, screen-temporal)
    static RxQuality = [
        [0, 0, 0], //0
        [0, 1, 0], //1
        [0, 2, 0], //2
        [1, 1, 1], //3
        [1, 2, 1], //4
        [2, 1, 2], //5
        [2, 2, 2], //6
    ];
    static kMaxRxQualityIndex = SvcDriver.RxQuality.length - 1;
    // minKbps, maxKbps, scr: constraints for applyConstraints() on sent screen track
    // x540 needs at least 400 kbps
    // x720 needs at least 500 kbps
    // x1024 needs at least 900 kbps
    // x1620 needs at least 1800 kbps
    static TxQuality = [
        { minKbps: 0, maxKbps: 250,     scr: { height: 480, frameRate: 4 }},  // 0
        { minKbps: 200, maxKbps: 550,   scr: { height: 540, frameRate: 4 }},  // 1
        { minKbps: 500, maxKbps: 700,   scr: { height: 720, frameRate: 4 }},  // 2
        { minKbps: 600, maxKbps: 800,   scr: { height: 720, frameRate: 8 }},  // 3
        { minKbps: 700, maxKbps: 1000,  scr: { height: 720, frameRate: 16 }}, // 4
        { minKbps: 900, maxKbps: 1200,  scr: { height: 1080, frameRate: 4}},  // 5
        { minKbps: 1100, maxKbps: 1400, scr: { height: 1080, frameRate: 8}},  // 6
        { minKbps: 1250, maxKbps: 1600, scr: { height: 1080, frameRate: 16}}, // 7
        { minKbps: 1450, maxKbps: 1800, scr: { height: 1440, frameRate: 8}},  // 8
        { minKbps: 1600, maxKbps: 2300, scr: { height: 1440, frameRate: 16}}, // 9
    ];
    static kDefaultTxQuality = 2;
    static kMaxTxQualityIndex = SvcDriver.TxQuality.length - 1;
}
class MicMuteMonitor {
    static kMicMutedDetectThreshold = 0.00001;
    static kWarningTimeoutMs = 16000;
    protected client: SfuClient;
    micInputSeen?: boolean;
    protected micLevelAvg: number = 0;
    protected muteIndicatorActive?: boolean;
    protected timer?: ReturnType<typeof setInterval>;
    constructor(client: SfuClient) {
        this.client = client;
    }
    protected delTimer() {
        if (this.timer) {
            clearTimeout(this.timer);
            delete this.timer;
        }
    }
    reinit() { // called upon SfuClient.connect()
        this.delTimer();
        delete this.micInputSeen;
    }
    stop() {
        this.delTimer();
    }
    restart() { // called evety time when mic input track is enabled
        this.micLevelAvg = 0.0;
        this.muteIndicatorActive = false;
        this.delTimer();
        this.timer = setTimeout(() => {
            delete this.timer;
            this.fireWarning();
        }, MicMuteMonitor.kWarningTimeoutMs);
        console.log("Started mic muted monitor");
    }
    fireWarning() {
        this.muteIndicatorActive = true;
        if (this.micInputSeen) {
            this.client._fire("onMicSignalDetected", false);
        } else {
            this.client._fire("onNoMicInput");
        }
    }
    onLevel(level: number) {
        let avg = this.micLevelAvg = (level > this.micLevelAvg) ? level : (level + this.micLevelAvg) / 2;
        if (avg >= MicMuteMonitor.kMicMutedDetectThreshold) {
            this.micInputSeen = true;
            if (this.timer) {
                this.delTimer();
            }
            else if (this.muteIndicatorActive) {
                delete this.muteIndicatorActive;
                this.client._fire("onMicSignalDetected", true);
            }
        } else if (!this.muteIndicatorActive && !this.timer) { // avg is below threshold
            this.fireWarning();
        }
    }
}
class SpeakerDetector {
    protected client: SfuClient;
    protected peers: Set<Peer> = new Set<Peer>();
    protected onTimerTick: Function;
    protected timer?: ReturnType<typeof setInterval>;
    tsLastChange: number = 0;
    currSpeaker?: Peer|null;
    constructor(client: SfuClient) {
        this.client = client;
        this.enable(false);
    }
    enable(enable: boolean) {
        this.deleteTimer();
        let cb = enable ? this._onTimerTick_active.bind(this) : this._onTimerTick_passive.bind(this);
        this.timer = setInterval(cb, SfuClient.kAudioMonTickPeriod);
    }
    deleteTimer() {
        if (!this.timer) {
            return;
        }
        clearInterval(this.timer);
        delete this.timer;
    }
    registerPeer(peer: Peer) {
        this.peers.add(peer);
    }
    unregisterPeer(peer: Peer) {
        this.peers.delete(peer);
        if (this.currSpeaker === peer) {
            delete this.currSpeaker;
        }
        if (!this.peers.size) {
            this.deleteTimer();
        }
    }
    _onTimerTick_passive() {
        for (let peer of this.peers) {
            peer.pollAudioLevel();
        }
    }
    _onTimerTick_active() {
        let maxLevel = SfuClient.kSpeakerVolThreshold;
        let maxPeer = null;
        for (let peer of this.peers) {
            let level = peer.pollAudioLevel(true)!;
            if (level > maxLevel) {
                maxLevel = level;
                maxPeer = peer;
            }
        }
        if (!maxPeer) {
            return;
        }
        let now = Date.now();
        let client = this.client;
        let ourLevel = (now - client.tsMicAudioLevel < 1500) ? client.micAudioLevel : 0;
        if (ourLevel > maxLevel) {
            maxPeer = null;
        }
        if (maxPeer === this.currSpeaker) {
            return;
        }
        if (now - this.tsLastChange < SfuClient.kSpeakerChangeMinInterval) {
            return;
        }
        this.tsLastChange = now;
        let prev = this.currSpeaker;
        this.currSpeaker = maxPeer;
        if (maxPeer) {
            console.warn("Active speaker changed to", maxPeer.userId);
            assert(this.client.peers.get(maxPeer.cid));
        } else {
            console.warn("Active speaker changed to us");
        }
        this.client.app.onActiveSpeakerChange(maxPeer, prev);
    }
}
class StatsRecorder {
    client: SfuClient;
    arrays: Record<string, number[]>;
    tsStart?: number;
    constructor(client: SfuClient) {
        this.client = client;
    }
    reset() {
        this.arrays = {
            t: []
        }
        delete this.tsStart;
    }
    start() {
        this.tsStart = Date.now();
    }
    get started() {
        return this.tsStart != null;
    }
    onStats(sample: Dict) {
        if (!this.tsStart) {
            console.warn("statsRecoder: onStats called while we are not started");
            return;
        }
        let arrays = this.arrays;
        let tarr = arrays.t;
        let len = tarr.length;
        tarr.push(Date.now() - this.tsStart!);

        for (let id in sample) {
            if (id.startsWith('_')) {
                continue;
            }
            let arr = arrays[id];
            if (!arr) {
                arr = arrays[id] = new Array(len);
                for (let i = 0; i < len; i++) {
                    arr[i] = -1;
                }
            }
            arr.push(sample[id]);
        }
    }
    submit(termReason: number) {
        if (!this.tsStart) {
            console.warn("StatsRecorder.submit: was not started (tsStart is not set)");
            return;
        }
        let arrs = this.arrays;
        let len = arrs.t.length;
        for (let id in arrs) {
            if (id === 't') {
                continue;
            }
            let arr = arrs[id];
            if (arr.length < len) {
                let oldLen = arr.length;
                arr.length = oldLen;
                for (let i = oldLen; i < len; i++) {
                    arr[i] = -1;
                }
            }
            arrs[id] = StatsRecorder.compressArray(arr);
        }
        let duration = Date.now() - this.tsStart!;
        let client = this.client;
        let verMatch = navigator.userAgent.match(/Chrom(e|ium)\/([0-9\.]+)\s/);
        let ua = (verMatch && verMatch.length >= 3) ? ("wc:" + verMatch[2]) : "w?:?";
        ua += `;${COMMIT_ID}`;
        let data: Dict = {
            ua: ua,
            userid: client.userId,
            cid: client.cid,
            callid: client.callId,
            toffs: client.joinToffs, // in ms
            dur: duration,
            peers: client.maxPeers,
            samples: arrs,
            trsn: termReason,
        };
        if (!this.client.micInputSeen) {
            data.nomic = 1;
        }
        if (this.client.isGroup) {
            data.grp = 1;
        }
        if (client.url) {
            data.sfu = new URL(client.url).host;
        }
        console.log(`Posting stats to ${SfuClient.kStatServerUrl}/stats:\n`, data);
        fetch(SfuClient.kStatServerUrl + "/stats", {
            method: "POST",
            body: JSON.stringify(data)
        });
    }
    static compressArray(arr: number[]): any[] {
        let len = arr.length;
        if (len < 1) {
            return arr;
        }
        let result = [];
        let lastVal = arr[0];
        let lastIdx = 0;
        for (let i = 1; i < len; i++) {
            let val = arr[i];
            if (val === lastVal) {
                continue;
            }
            let numRpt = i - lastIdx;
            result.push((numRpt < 2) ? lastVal : [lastVal, numRpt]);
            lastIdx = i;
            lastVal = val;
        }
        let numRpt = len - lastIdx;
        result.push((numRpt < 2) ? lastVal : [lastVal, numRpt]);
        return result;
    }
};

function msDelay(ms: number) {
    return new Promise<void>(function(resolve, reject) {
        setTimeout(()=>resolve(), ms);
    });
}

if (!SfuClient.platformHasSupport()) {
    console.error("This browser does not support insertable streams");
}

let ns = (SfuClient as any);
ns.playerPlay = playerPlay;
ns.playerStop = playerStop;
ns.binToHex = binToHex;
ns.hexToBin = hexToBin;

(window as any).SfuClient = SfuClient;
(window as any).Av = Av;
