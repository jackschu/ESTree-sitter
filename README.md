# ESTree-sitter
ESTree-sitter is an [ESTree](https://github.com/estree/estree) compability layer for [tree-sitter-javascript](https://github.com/tree-sitter/tree-sitter-javascript).

## But what does that mean?
- [ESTree](https://github.com/estree/estree) is a common specification that `babel` `prettier` `acorn` and other JavaScript tools ~adhere to. 
  - They adhere in that they produce or ingest an AST with a shape similar to a naive reading of the spec.
- [tree-sitter](https://tree-sitter.github.io/) is a parser generator from the future that generates parsers with some great properties (see docs).
- [tree-sitter-javascript](https://github.com/tree-sitter/tree-sitter-javascript) is effectively one such parser.

This project's goal is to produce ASTs in the 'ESTree format' from `tree-sitter-javascript`'s ASTs. 

ASTs produced by this project should be identical to those that an ESTree parser (namely [Acorn](https://github.com/acornjs/acorn)) would produce.

As a result, other ESTree-based tools like [prettier](https://prettier.io/) could run 'using tree-sitter', which would be freaking sick.

## Getting started

Dont! This project is WIP and as of this commit (06-18-24) only passes 60% of prettier's js test corpus. 

It's not even on a package manager yet AFAIK, how are you here?
