{
  lib,
  config,
  dream2nix,
  ...
}: {
  imports = [
    dream2nix.modules.dream2nix.nodejs-package-json-v3
    dream2nix.modules.dream2nix.nodejs-granular-v3
  ];

  deps = {nixpkgs, ...}: {
    inherit
      (nixpkgs)
      gnugrep
      stdenv
      ;
  };

  name = lib.mkForce "estree-sitter";
  version = lib.mkForce "0.1.0";

  mkDerivation = let 
    fs = lib.fileset;
    dream_src = fs.unions [./flake.lock ./lock.json ./package.json];
  in 
    {
      src = fs.toSource {
        root = ./.;
        fileset = dream_src;
      };
      doCheck = true;
  };
}