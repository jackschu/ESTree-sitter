import { parse } from './parser.js'

function locStart(node) {
    const start = node.range?.[0] ?? node.start

    // Handle nodes with decorators. They should start at the first decorator
    const firstDecorator = (node.declaration?.decorators ??
        node.decorators)?.[0]
    if (firstDecorator) {
        return Math.min(locStart(firstDecorator), start)
    }

    return start
}

function locEnd(node) {
    return node.range?.[1] ?? node.end
}

export const parsers = {
    'tree-sitter': {
        astFormat: 'estree',
        parse,
        locStart,
        locEnd,
    },
}
