"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BridgeRequestStatus = void 0;
var BridgeRequestStatus;
(function (BridgeRequestStatus) {
    BridgeRequestStatus["DETECTED"] = "DETECTED";
    BridgeRequestStatus["CONFIRMED"] = "CONFIRMED";
    BridgeRequestStatus["ATTESTATION_SIGNED"] = "ATTESTATION_SIGNED";
    BridgeRequestStatus["MINT_SUBMITTED"] = "MINT_SUBMITTED";
    BridgeRequestStatus["MINT_CONFIRMED"] = "MINT_CONFIRMED";
    BridgeRequestStatus["FAILED"] = "FAILED";
})(BridgeRequestStatus || (exports.BridgeRequestStatus = BridgeRequestStatus = {}));
