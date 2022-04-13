export enum TermCode {
    kFlagError           = 128,
    kFlagDisconn         = 64,
    kUserHangup          = 0,
    kTooManyParticipants = 1,
    kLeavingRoom         = 2,
    //====
    kRtcDisconn       = kFlagDisconn | 0,
    kSigDisconn       = kFlagDisconn | 1,
    kSfuShuttingDown  = kFlagDisconn | 2,
    kChatDisconn      = kFlagDisconn | 3,
    kNoMediaPath      = kFlagDisconn | 4,
    //====
    kErrSignaling     = kFlagError | 0,
    kErrNoCall        = kFlagError | 1,
    kErrAuth          = kFlagError | 2,
    kErrApiTimeout    = kFlagError | 3,
    kErrSdp           = kFlagError | 4,
    kErrClientGeneral = kFlagError | 62,
    kErrSfuGeneral    = kFlagError | 63
};
export default TermCode;
