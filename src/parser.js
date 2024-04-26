import assert from 'node:assert/strict'
import Parser from 'web-tree-sitter'

await Parser.init()
const JavaScript = await Parser.Language.load(
    './vendored/tree-sitter-javascript.wasm'
)

const parser = new Parser()

parser.setLanguage(JavaScript)

const ts_comments = []

/** @param {string} text */
export const parse = (text) => {
    const sourceType = 'module'

    const comments = []
    const tokens = []

    const ts_ast = parser.parse(text)

    const [_, out_obj] = traverse_tree(ts_ast.walk())
    out_obj.comments = ts_comments

    return out_obj
}

const type_mapping = new Map()
type_mapping.set('binary_expression', 'LogicalExpression')

/** @param {Parser.TreeCursor} cursor */
const traverse_tree = (cursor) => {
    const children = []

    let out

    if (cursor.gotoFirstChild()) {
        do {
            let child_pair = traverse_tree(cursor)
            if (child_pair === null) {
                continue
            }
            children.push(child_pair)
        } while (cursor.gotoNextSibling())
        cursor.gotoParent()
    }

    out = convert(cursor, children)
    if (out === null) return null
    let name = cursor.currentFieldName
    if (name == null) {
        name = cursor.nodeType
        console.log('no field for node type', name)
    }
    return [name, out]
}

function capitalize(string) {
    return string.charAt(0).toUpperCase() + string.slice(1)
}

/** @param {Parser.Point} point */
const convert_position = (point) => ({
    line: point.row + 1,
    column: point.column,
})

/** @param {Parser.TreeCursor} cursor */
const convert = (cursor, children) => {
    if (cursor.currentFieldName === 'operator') {
        return cursor.nodeText
    } else if (cursor.currentFieldName === 'arguments') {
        return children
            .map((x) => x[1])
            .filter((x) => x.type === 'ExpressionStatement')
    }
    const start = convert_position(cursor.startPosition)
    const end = convert_position(cursor.endPosition)
    const out = {
        start: cursor.startIndex,
        end: cursor.endIndex,
        loc: {
            start,
            end,
        },
        range: [cursor.startIndex, cursor.endIndex],
    }
    out.type =
        type_mapping.get(cursor.nodeType) ??
        cursor.nodeType
            .split('_')
            .map((word) => capitalize(word))
            .join('')
    switch (cursor.nodeType) {
        case 'call_expression': {
            let optional = false
            for (let pair of children) {
                if (pair[0] === 'optional_chain') {
                    optional = true
                } else {
                    out[field_map.get(pair[0]) ?? pair[0]] = pair[1]
                }
            }
            out.optional = optional

            return out
        }
        case 'comment': {
            out.type = cursor.nodeText.startsWith('//') ? 'Line' : 'Block'
            if (out.type === 'Line') out.value = cursor.nodeText.slice(2)
            else out.value = cursor.nodeText.slice(2, -2)

            ts_comments.push(out)
            return null
        }
        case 'program': {
            out.body = children.map((x) => x[1])
            out.sourceType = 'module'
            return out
        }
        case 'return_statement': {
            const child_candidates = children
                .filter((x) => x[0] !== 'return')
                .map((x) => x[1])
            if (child_candidates.length > 1) {
                throw new Error(
                    'return with multiple expressions? ' +
                        JSON.stringify(child_candidates)
                )
            }
            out.argument = child_candidates[0]
            return out
        }
        case 'new': {
            return null
        }
        case 'identifier': {
            out.name = cursor.nodeText
            return out
        }

        default: {
            for (let pair of children) {
                out[field_map.get(pair[0]) ?? pair[0]] = pair[1]
            }

            //      out.text = cursor.nodeText;

            return out
        }
    }
}

const field_map = new Map()
field_map.set('new_expression', 'expression')
field_map.set('call_expression', 'expression')
field_map.set('constructor', 'callee')
field_map.set('function', 'callee')
