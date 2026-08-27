// The one-time passkey offer's dismissal flag, shared because two contexts must
// agree on it: the side panel reads and sets it (screens/Wallet.tsx), and
// keystore.reset() clears it.
//
// Dismissal is permanent BY DESIGN — "not now" means now, and the offer never
// nags again for that vault. What it must not outlive is the vault itself: a
// surviving flag hides the offer for the NEXT vault the user creates or
// restores, which is how a reset can leave passkey enrollment undiscoverable
// with no way back except Settings. Same reasoning as the unlock throttle,
// which reset() drops for the same class of reason.
export const PASSKEY_OFFER_KEY = "apogee:passkeyOfferDismissed";
