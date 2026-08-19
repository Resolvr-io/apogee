# Confirmed lending-v3 AcceptOffer vector

Captured from the public Liquid testnet explorer on 2026-08-07 for offline,
deterministic tests.

- Final acceptance transaction: `e69e0e401919dcd8a4721f3d33cd044375080d9578905a456d097c73f6d39231`
- Pending-offer parent (inputs 0 and 1): `baa0de011d4addd0ab4bf0b00c34bb797f67487be7517136af04ac39b184bff1`
- Principal parent (input 2): `224160fb671be79394438747de2313bdc01c56d8f02a91bf5609e40f4f4bf3d3`
- Fee parent (input 3): `16b28b36dbba9115a97a0f90dc65585715b9637b6206adaaf871ff9e216f2ab4`

The test reconstructs every witness UTXO from these parent transactions and rejects
a missing or mismatched prevout. It executes the lending covenant at input 0 and the
ScriptAuth covenant at input 1 against the exact finalized transaction.
