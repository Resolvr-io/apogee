# Third-Party Notices

## Simplicity Lending contract sources

Apogee includes the following Simplicity source files from the
[`lending-contracts`](https://github.com/BlockstreamResearch/simplicity-lending/tree/8f8ace33963788a0ed901c160a1187f8489e2c55/crates/contracts)
package at commit `8f8ace33963788a0ed901c160a1187f8489e2c55`:

- `asset_auth.simf` — SHA-256
  `cfd27392a1571e2ee47e0399b5db0c5009ec2cdee11e0f0283a85d0b17e664b6`
- `asset_auth_vault.simf` — SHA-256
  `3a1bbaa2e28fa84f2573fb06a90fcf450b401733009102cb878c612194be7d7f`
- `issuance_factory.simf` — SHA-256
  `dd1e7f89c6843291b8939d33c4f6ec57a88037726a8ecf40b76eeee024d24438`
- `lending.simf` — SHA-256
  `a9b4ade7d131f963a0da014b45f08cc49094194cd76490a30495e3dc93749b8a`
- `script_auth.simf` — SHA-256
  `ffe473ee77ac0b51d90f1b7f1b26d883a64b40e7276212aedf9f4bfadb54e8f7`

These hashes cover the exact upstream bytes. The vendored text files add one
final line feed for repository tooling; Apogee removes that byte before hashing
or compiling them.

The upstream package declares `MIT OR Apache-2.0`. Apogee redistributes these
files under the MIT option. Copyright remains with the respective upstream
authors and contributors.

### MIT License

Copyright (c) the respective upstream authors and contributors

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
