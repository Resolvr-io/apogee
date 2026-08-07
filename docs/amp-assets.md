# AMP / transfer-restricted assets

## Status

| Capability | Supported? |
|------------|------------|
| Hold / display standard Liquid issued assets (e.g. USDt) | Yes (wallet + balance) |
| Side-panel Send of held issued assets | Yes |
| Dapp-initiated transfer of a specific `assetId` (provider path on `main`) | Yes |
| Blockstream **AMP transfer-restricted** / issuer-tracked assets (cosign) | **No** |

## Why AMP is separate

[Blockstream AMP](https://blockstream.com/amp/) assets often require:

1. Registered users / GAID-style identity
2. Assignment / whitelist rules on the AMP server
3. **Cosigning** by AMP for spends (not a plain LWK PSET)

Apogee’s engine builds and signs ordinary Liquid PSETs via `lwk_wasm`. That path does **not** implement AMP0/AMP2 cosign or transfer restrictions. Sending an AMP-restricted asset as if it were a free Liquid asset will fail or be non-compliant.

## Boundary (not a roadmap)

This document records why transfer-restricted and cosigned assets are out of reach for `lwk_wasm`-only spends. It is a **statement of the current boundary**, not a commitment to ship AMP support.

Closing the gap would require, at minimum:

1. Optional AMP client integration (testnet + mainnet issuer APIs)
2. Cosign flow before broadcast when the asset is AMP-restricted
3. Provider surface that routes restricted assets through that flow
4. Clear device/UI review for asset id + amount on restricted transfers

Until then, `features.ampRestricted` remains `false` in `liquid_getCapabilities` (or equivalent).

## Related

- Issued-asset dapp/provider transfers for **non-AMP** Liquid assets (see `sendTransfer` / Liquid provider on `main`)
- Upstream: Blockstream AMP / AMP2 docs
