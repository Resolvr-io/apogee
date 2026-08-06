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

The page discovers every `liquid:announceProvider` announcement, deduplicates providers by UUID, and lets the developer inspect capabilities, grant `getBalance` or `sendTransfer` permission, restore the current connection, request a balance, exercise a transfer with an initialized wallet, and disconnect. Its timeline shows provider requests, direct results, structured errors, and `wallet_connectionChanged` payloads.

`sendTransfer` accepts an exact base-unit decimal string and always opens an Apogee-controlled transaction review before signing. Apogee currently rejects the optional `memo` parameter with `4200` because its LWK transaction builder cannot add the required OP_RETURN output; the field is never ignored. Successful manual transfers require a funded wallet and network access.

“Run checks” executes only public, non-prompting operations. It validates announcement metadata and identity, the minimal provider interface, capabilities, request normalization, errors, concurrency, and subscription behavior. The page also probes a same-origin child frame and an opaque child frame; neither should discover the top-level provider.

## Automated browser suite

Install Playwright's Chromium once, then run:

```sh
pnpm exec playwright install chromium
pnpm test:provider
```

The suite builds and loads the real unpacked extension. It verifies the safe public checks, seeds a deterministic testnet wallet through an extension-only message, drives Apogee's real connection and `sendTransfer` permission approvals, verifies explicit memo rejection, reloads the dapp, checks origin isolation through `127.0.0.1` versus `localhost`, observes the connection event, and disconnects.

The automated suite does not perform a successful balance scan or broadcast because that would make CI depend on a live Liquid service and funded wallet. It verifies that an unconnected origin receives `4100` for both application RPCs. Successful requests remain available for manual testing with any initialized wallet.
