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

  nodejs-granular-v3 = {
    buildScript = ''
      mv index.js app.js.tmp
      echo "#!${config.deps.nodejs}/bin/node" > app.js
      cat app.js.tmp >> app.js
      chmod +x ./app.js
      patchShebangs .
    '';
  };

  name = lib.mkForce "estree-sitter";
  version = lib.mkForce "0.1.0";

  mkDerivation = {
    src = lib.cleanSource ./.;
    doCheck = true;
  };
}