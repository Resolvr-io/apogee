{
  description = "Apogee development environment";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-darwin"
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          # Pinned build-only tools for the checked-in TX Manifest browser runtime.
          # The wrapped compiler injects host libc include paths even for the
          # wasm32 target on Linux. Use upstream Clang directly; the Rust sys
          # crates provide the deliberately minimal WASM headers they require.
          tx-manifest-clang = pkgs.llvmPackages.clang-unwrapped;
          tx-manifest-llvm-tools = pkgs.llvmPackages.bintools-unwrapped;
          tx-manifest-wasm-bindgen = pkgs.wasm-bindgen-cli;
        }
      );

      devShells = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
        in
        {
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_22
              pkgs.pnpm_10
            ];
          };
        }
      );
    };
}
