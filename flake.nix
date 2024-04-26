{
  description = "Converts tree-sitter javascript ASTs to estree ASTs";

  inputs = {
    dream2nix.url = "github:nix-community/dream2nix";
    nixpkgs.follows = "dream2nix/nixpkgs";
  };

  outputs = inputs@{ self, dream2nix, nixpkgs, ... }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };

      fs = pkgs.lib.fileset;

      non_node_packages = pkgs.lib.cleanSource ./.;
      dream_eval = dream2nix.lib.evalModules {
        packageSets.nixpkgs =
          inputs.dream2nix.inputs.nixpkgs.legacyPackages.${system};
        modules = [
          ./default.nix
          {
            paths.projectRoot = non_node_packages;
            # can be changed to ".git" or "flake.nix" to get rid of .project-root
            paths.projectRootFile = "flake.nix";
            paths.package = non_node_packages;
          }
        ];
      };
      jest-check = pkgs.stdenv.mkDerivation {
        name = "jest-check";
        src = dream_eval;
        doCheck = true;
        checkPhase = ''
        # gotta do this or else we'll be in node_modules path
        # and that'll confuse some of jest's regexs
        TEST_DIR=$(mktemp -d)
        cp -r ./lib/node_modules/estree-sitter $TEST_DIR
        cd $TEST_DIR/estree-sitter
        cp -r ${non_node_packages}/* ./

        NODE_OPTIONS="--experimental-vm-modules" ${dream_eval}/lib/node_modules/estree-sitter/node_modules/jest/bin/jest.js
      '';
        installPhase = ''
          mkdir "$out"
        '';
      };
    in {
      # All packages defined in ./packages/<name> are automatically added to the flake outputs
      # e.g., 'packages/hello/default.nix' becomes '.#packages.hello'
      packages.${system} = {
        default = pkgs.writeShellApplication {
          name = "estreesit";

          runtimeInputs = [ pkgs.nodejs ];

          text = ''
          TMP_DIR=$(mktemp -d)
          cp -r ${dream_eval}/lib/node_modules/estree-sitter/node_modules "$TMP_DIR"
          cp -r ${non_node_packages}/* "$TMP_DIR"
          cd "$TMP_DIR"
          ${pkgs.nodejs}/bin/node src/index.js
          '';
        };
        dream = dream_eval;
      };
      apps.x86_64-linux.check = let
        jest-esm = pkgs.writeShellScriptBin "checks-with-env" ''
          export NODE_OPTIONS="--experimental-vm-modules"
          ${dream_eval}/lib/node_modules/estree-sitter/node_modules/jest/bin/jest.js "$@"
        '';
      in {
        type = "app";
        program = "${jest-esm}/bin/checks-with-env";
      };
      checks.x86_64-linux = {inherit jest-check;};
    };
}
