export default class Av {
    static Audio = 1;
    static CameraLowRes = 2; static CameraHiRes = 4; static Camera = 6;
    static ScreenLowRes = 8; static ScreenHiRes = 16; static Screen = 24;
    static LowResVideo = 10; static HiResVideo = 20; static Video = 30;
    static onHold = 128;
    static hasCamAndScreen(av: number) {
        return ((av & Av.Camera) && (av & Av.Screen));
    }
    static toString(av: number) {
        let result = (av & Av.onHold) ? "H" : "";
        if (av & Av.Audio) {
            result += "a";
        }
        if (av & Av.CameraHiRes) {
            result += "C";
        }
        if (av & Av.CameraLowRes) {
            result += "c";
        }
        if (av & Av.ScreenHiRes) {
            result += "S";
        }
        if (av & Av.ScreenLowRes) {
            result += "s";
        }
        return result;
    }
}
