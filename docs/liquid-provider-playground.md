# Liquid provider playground

The playground is a plain local dapp for inspecting Apogee's event-discovered Liquid browser provider. It deliberately imports no Apogee runtime code and receives no privileged extension access.

## Manual use

1. Enter the development shell and install dependencies:

   ```sh
   nix develop
   pnpm install
   ```

2. Build Apogee:

   ```sh
   pnpm build
   ```

3. Load `dist/` as an unpacked extension in your browser and initialize or unlock Apogee.
4. Start the playground:

   ```sh
   pnpm dev:provider
   ```

5. Open <http://127.0.0.1:4173/>.

The page discovers every `liquid:announceProvider` announcement, deduplicates providers by UUID, and lets the developer inspect capabilities; grant `getBalance`, `getUTXOs`, `getWalletDescriptor`, `sendTransfer`, or `signPset` permission; restore the current connection; exercise the implemented RPCs; and disconnect. Its timeline shows provider requests, direct results, structured errors, `wallet_connectionChanged`, and authorized `bip122_walletDescriptorChanged` payloads.

`getUTXOs` is an account-state disclosure permission: its connection prompt explains that a site can see individual outputs, addresses, amounts, and transaction links. Results include the raw previous `TxOut` needed for PSET construction, but never include asset/value blinding factors, private blinding keys, shared nonces, or view-capable descriptor material.

`getWalletDescriptor` is a separate account-correlation permission. Apogee currently supports only `publicWalletDescriptor` in `bip380-bip389-multipath` format. LWK validates and canonicalizes the wallet's CT descriptor before Apogee removes the independent SLIP-77 wrapper and recomputes the BIP-380 checksum. The result can derive scriptPubKeys and unconfidential addresses, but cannot derive confidential addresses or unblind outputs. `publicConfidentialDescriptor`, split-branch formats, other blinding policies, and descriptors containing private spend keys are rejected with `4200`. Descriptor-change events are delivered only when the origin has both the method and event grants.

`signPset` is a separate signing permission and every invocation still requires transaction approval. Paste the base64 PSET and its `signInputs` JSON into the playground to exercise local or Jade signing. Apogee currently accepts only wallet-owned native P2WPKH inputs and sighash modes that commit to every output. The signed PSET is returned to the page; `broadcast: true`, collaborative inputs, issuance, and mutable-output sighashes are rejected.

`sendTransfer` accepts an exact base-unit decimal string and always opens an Apogee-controlled transaction review before signing. Apogee currently rejects the optional `memo` parameter with `4200` because its LWK transaction builder cannot add the required OP_RETURN output; the field is never ignored. Successful manual transfers require a funded wallet and network access.

“Run checks” executes only public, non-prompting operations. It validates announcement metadata and identity, the minimal provider interface, capabilities, request normalization, errors, concurrency, and subscription behavior. The page also probes a same-origin child frame and an opaque child frame; neither should discover the top-level provider.

## Automated browser suite

Install Playwright's Chromium once, then run:

```sh
pnpm exec playwright install chromium
pnpm test:provider
```

The suite builds and loads the real unpacked extension. It verifies the safe public checks, seeds a deterministic testnet wallet through an extension-only message, drives Apogee's real `getBalance`, `getUTXOs`, `getWalletDescriptor`, `sendTransfer`, and `signPset` permission approvals, checks the privacy and signing disclosures, verifies that the exported descriptor has no CT wrapper or private key material, exercises descriptor-format/type rejection and the descriptor-change event, checks the UTXO cross-chain filter, explicit memo rejection, and the `signPset` no-broadcast boundary, reloads the dapp, checks origin isolation through `127.0.0.1` versus `localhost`, observes connection events, and disconnects.

The automated browser suite does not perform a successful balance or UTXO scan, funded PSET signature, or transaction broadcast, because that would make CI depend on a live Liquid service and funded wallet. Descriptor projection is local and is exercised successfully. Unit tests cover the atomic analyze-before-sign boundary, exact review matching, mutation rejection, and signer failures; the browser suite covers the permission prompt and no-broadcast boundary. It also verifies that an unconnected origin receives `4100` for every implemented application RPC. Network-backed successful requests remain available for manual testing with any initialized wallet.
