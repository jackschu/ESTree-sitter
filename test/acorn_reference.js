import { Parser as AcornParser } from 'acorn'

const acornParseOptions = {
    ecmaVersion: 'latest',
    // sourceType: "module",
    allowReturnOutsideFunction: true,
    // allowImportExportEverywhere: true,
    allowSuperOutsideMethod: true,
    locations: true,
    ranges: true,
}

export const parse = (text) => {
    const sourceType = 'module'

    const comments = []

    const acorn_ast = AcornParser.parse(text, {
        ...acornParseOptions,
        sourceType,
        allowImportExportEverywhere: sourceType === 'module',
        onComment: comments,
    })

    acorn_ast.comments = comments
    return acorn_ast
}
