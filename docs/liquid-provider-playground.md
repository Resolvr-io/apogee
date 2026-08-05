# Liquid provider playground

The playground is a plain local dapp for inspecting Apogee's event-discovered Liquid browser provider. It deliberately imports no Apogee runtime code and receives no privileged extension access.

## Manual use

1. Build and load Apogee as an unpacked extension.
2. Start the playground:

   ```sh
   pnpm dev:provider
   ```

3. Open <http://127.0.0.1:4173/>.

The page discovers every `liquid:announceProvider` announcement, deduplicates providers by UUID, and lets the developer inspect capabilities, connect with `getBalance` permission, restore the current connection, request a balance, and disconnect. Its timeline shows provider requests, direct results, structured errors, and `wallet_connectionChanged` payloads.

“Run checks” executes only public, non-prompting operations. It validates announcement metadata and identity, the minimal provider interface, capabilities, request normalization, errors, concurrency, and subscription behavior. The page also probes a same-origin child frame and an opaque child frame; neither should discover the top-level provider.

## Automated browser suite

Install Playwright's Chromium once, then run:

```sh
pnpm exec playwright install chromium
pnpm test:provider
```

The suite builds and loads the real unpacked extension. It verifies the safe public checks, seeds a deterministic testnet wallet through an extension-only message, drives Apogee's real connection approval, reloads the dapp, checks origin isolation through `127.0.0.1` versus `localhost`, observes the connection event, and disconnects.

The automated suite does not perform a successful `getBalance` scan because that would make CI depend on a live Liquid service. It does verify that an unconnected origin receives `4100`. A successful balance request remains available for manual testing with any initialized wallet.
