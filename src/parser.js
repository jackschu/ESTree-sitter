import assert from 'node:assert/strict'
import Parser from 'web-tree-sitter'
import { type_mapping, field_map } from './renames'

await Parser.init()
const JavaScript = await Parser.Language.load(
    './vendored/tree-sitter-javascript.wasm'
)

const parser = new Parser()

parser.setLanguage(JavaScript)

let ts_comments = []

/** @param {string} text */
export const parse = (text) => {
    ts_comments = []

    const comments = []
    const tokens = []

    const ts_ast = parser.parse(text)

    const [_, out_obj] = traverse_tree(ts_ast.walk())
    out_obj.comments = ts_comments

    return out_obj
}

/** @param {Parser.TreeCursor} cursor */
const traverse_tree = (cursor) => {
    const children = []

    let out

    if (!useless_children.has(cursor.nodeText) && cursor.gotoFirstChild()) {
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
        //        console.log('no field for node type', name)
    }
    return [name, out]
}

const useless_children = new Set()
useless_children.add('regex')

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
        case 'expression_statement': {
            out.expression = children[0][1]
            return out
        }
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
        case 'statement_block': {
            out.body = children
                .filter((x) => x[0] !== '{' && x[0] !== '}')
                .map((x) => x[1])
            return out
        }
        case 'rest_pattern': {
            out.argument = children[1][1]
            return out
        }
        case 'shorthand_property_identifier_pattern': {
            out.name = cursor.nodeText
            const fake_child = { ...out, type: 'Identifier' }
            out.computed = false
            out.kind = 'init'
            out.method = false
            out.shorthand = true
            out.value = fake_child
            out.key = fake_child
            return out
        }

        case 'pair_pattern': {
            const key_child = children.find((x) => x[0] === 'key')[1]
            const val_child = children.find((x) => x[0] === 'value')[1]
            out.computed = cursor.nodeText.startsWith('[')
            out.kind = 'init'
            out.method = false
            out.shorthand = false
            out.value = val_child
            out.key = key_child
            out.name = key_child.name
            return out
        }
        case 'property_identifier': {
            out.name = cursor.nodeText
            return out
        }
        case 'object_pattern': {
            const relevant_children = children.filter(
                (x) => x[0] !== '{' && x[0] !== '}' && x[0] !== ','
            )
            out.properties = relevant_children.map((x) => x[1])
            return out
        }
        case 'formal_parameters': {
            out.children = children.filter(
                (x) => x[0] !== '(' && x[0] !== ')' && x[0] !== ','
            )
            return out
        }
        case 'arrow_function': {
            const body = children.find((x) => x[0] === 'body')?.[1]
            if (!body) throw new Error('arrow func with no body')
            out.expression = body.type !== 'BlockStatement'

            const parameter = children.find((x) => x[0] === 'parameter')?.[1]

            if (parameter) {
                out.params = [parameter]
            } else {
                const parameters = children.find(
                    (x) => x[0] === 'parameters'
                )?.[1]
                if (!parameters) throw new Error('arrow func with no params')
                const parameter_children = parameters.children
                out.params = parameter_children.map((x) => x[1])
            }

            out.id = null
            out.generator = false
            out.async = children[0][1].nodeText === 'async'

            out.body = body
            return out
        }
        case 'comment': {
            out.type = cursor.nodeText.startsWith('//') ? 'Line' : 'Block'
            if (out.type === 'Line') out.value = cursor.nodeText.slice(2)
            else out.value = cursor.nodeText.slice(2, -2)

            ts_comments.push(out)
            return null
        }
        case 'regex': {
            const pattern =
                cursor.currentNode.childForFieldName('pattern')?.text
            const flag = cursor.currentNode.childForFieldName('flags')?.text

            if (flag !== null) out.value = new RegExp(pattern, flag)
            else out.value = new RegExp(pattern)
            out.regex = {
                pattern,
                flags: flag ?? '',
            }
            out.raw = cursor.nodeText
            return out
        }
        case 'number': {
            out.raw = cursor.nodeText
            if (out.raw.endsWith('n')) {
                out.value = BigInt(out.raw)
            } else if (out.raw.startsWith('0b') || out.raw.startsWith('0B')) {
                out.value = parseInt(cursor.nodeText, 2)
            } else if (out.raw.startsWith('0x') || out.raw.startsWith('0X')) {
                out.value = parseInt(cursor.nodeText, 16)
            } else if (out.raw.startsWith('0.')) {
                out.value = parseFloat(cursor.nodeText)
            } else if (out.raw.startsWith('0')) {
                out.value = parseInt(cursor.nodeText, 8)
            } else {
                out.value = parseInt(cursor.nodeText)
            }

            return out
        }
        case 'statement_identifier': {
            out.name = cursor.nodeText
            return out
        }
        case 'program': {
            out.body = children.map((x) => x[1])
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
