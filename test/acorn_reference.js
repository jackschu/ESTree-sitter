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

const parseImpl = (text, sourceType) => {
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

export const parse = (text) => {
    // terrible, but this seems to be what prettier does
    try {
        return parseImpl(text, 'module')
    } catch (_e) {
        return parseImpl(text, 'script')
    }
}
