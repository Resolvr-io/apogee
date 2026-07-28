# AMP / transfer-restricted assets

## Status

| Capability | Supported? |
|------------|------------|
| Hold / display standard Liquid issued assets (e.g. USDt) | Yes (wallet + balance) |
| Side-panel Send of held issued assets | Yes |
| **Dapp** `liquid_sendTransaction` with `assetId` | Yes (this change) |
| Blockstream **AMP transfer-restricted** / issuer-tracked assets (cosign) | **No** |

## Why AMP is separate

[Blockstream AMP](https://blockstream.com/amp/) assets often require:

1. Registered users / GAID-style identity
2. Assignment / whitelist rules on the AMP server
3. **Cosigning** by AMP for spends (not a plain LWK PSET)

Apogee’s engine builds and signs ordinary Liquid PSETs via `lwk_wasm`. That path does **not** implement AMP0/AMP2 cosign or transfer restrictions. Sending an AMP-restricted asset as if it were a free Liquid asset will fail or be non-compliant.

## Requested follow-up (ecosystem)

For SME equity / security-token dapps we need:

1. Optional AMP client integration (testnet + mainnet issuer APIs)
2. Cosign flow before broadcast when the asset is AMP-restricted
3. Dapp methods such as:
   - `liquid_getAmpStatus({ assetId })`
   - `liquid_sendTransaction` that routes through AMP cosign when required
4. Jade review UI for asset id + amount on restricted transfers (already partly present for free issued assets)

Until then, `features.ampRestricted` remains `false` in `liquid_getCapabilities`.

## Related

- Dapp send with `assetId` for **non-AMP** issued assets (this PR)
- Upstream: Blockstream AMP / AMP2 docs
