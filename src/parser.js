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
const merge_position = (first, second) => {
    return {
        start: first.start,
        end: second.end,
        loc: { start: first.loc.start, end: second.loc.end },
        range: [first.range[0], second.range[1]],
    }
}

const cursor_to_loc = (cursor) => {
    const start = convert_position(cursor.startPosition)
    const end = convert_position(cursor.endPosition)
    return {
        start: cursor.startIndex,
        end: cursor.endIndex,
        loc: {
            start,
            end,
        },
        range: [cursor.startIndex, cursor.endIndex],
    }
}

/** @param {Parser.TreeCursor} cursor */
const convert = (cursor, children) => {
    if (cursor.currentFieldName === 'operator') {
        return cursor.nodeText
    }

    // the estee mob would like us to have our ranges avoid comment children
    // in strangely specific scenarios
    const ts_children = cursor.currentNode.children
    let avoid_comment_child = null
    if (cursor.nodeType !== 'program') {
        for (let i = ts_children.length - 1; i >= 0; i--) {
            if (ts_children[i].type !== 'comment') {
                if (i !== ts_children.length - 1)
                    avoid_comment_child = ts_children[i]
                break
            }
        }
    }

    let out = cursor_to_loc(cursor)

    if (avoid_comment_child) {
        out = merge_position(out, cursor_to_loc(avoid_comment_child))
    }
    out.type =
        type_mapping.get(cursor.nodeType) ??
        cursor.nodeType
            .split('_')
            .map((word) => capitalize(word))
            .join('')
    switch (cursor.nodeType) {
        case 'arguments': {
            out.children = children.filter((x) => x[0] !== '(' && x[0] !== ')')
            return out
        }
        case 'expression_statement': {
            out.expression = children[0][1]
            if (
                cursor.nodeText.startsWith("'use strict'") ||
                cursor.nodeText.startsWith('"use strict"')
            )
                out.directive = 'use strict'
            return out
        }
        case 'binary_expression': {
            for (let pair of children) {
                out[field_map.get(pair[0]) ?? pair[0]] = pair[1]
            }
            const is_logical = ['||', '??', '&&'].includes(out.operator)
            if (is_logical) out.type = 'LogicalExpression'
            return out
        }
        case 'assignment_expression': {
            out.left = children.find((x) => x[0] === 'left')[1]
            out.right = children.find((x) => x[0] === 'right')[1]

            out.operator = '='
            return out
        }
        case 'new_expression': {
            out.callee = children.find((x) => x[0] === 'constructor')[1]
            out.arguments = children
                .find((x) => x[0] === 'arguments')[1]
                .children.map((x) => x[1])
            return out
        }
        case 'call_expression': {
            out.optional =
                children.find((x) => x[0] === 'optional_chain') !== undefined
            out.callee = children.find((x) => x[0] === 'function')[1]
            out.arguments = children
                .find((x) => x[0] === 'arguments')[1]
                .children.map((x) => x[1])

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
        case 'shorthand_property_identifier':
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

        case 'pair':
        case 'pair_pattern': {
            const key_child = children.find((x) => x[0] === 'key')[1]
            const val_child = children.find((x) => x[0] === 'value')[1]
            out.computed = cursor.nodeText.startsWith('[')
            out.kind = 'init' // TODO need to support object getters
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
        case 'spread_element': {
            out.argument = children.find((x) => x[0] !== '...')[1]
            return out
        }
        case 'computed_property_name': {
            return children.find((x) => x[0] !== '[' && x[0] !== ']')[1]
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
        case 'method_definition': {
            const maybe_prefix = cursor.currentNode.children[0]

            const child_types = children.map((x) => x[0])
            if (child_types.includes('get')) {
                out.kind = 'get'
            } else if (child_types.includes('set')) {
                out.kind = 'set'
            } else {
                out.kind = 'method'
            } // TODO: constructor kind

            out.computed = cursor.nodeText.startsWith('[')
            out.static = child_types.includes('static')
            out.key = children.find((x) => x[0] === 'name')[1]
            const body = children.find((x) => x[0] === 'body')[1]
            const params = children.find((x) => x[0] === 'parameters')[1]
            out.value = {
                type: 'FunctionExpression',
                body,
                expression: false,
                id: null,
                generator: false,
                params: params.children.map((x) => x[1]),
                async: child_types.includes('async'),
                key: body.key,
                ...merge_position(params, body),
            }
            if (cursor.currentNode.parent.type === 'object') {
                const function_expression = out.value
                const fake_property = {
                    type: 'Property',
                    method: out.kind === 'method',
                    kind: out.kind === 'method' ? 'init' : out.kind,
                    shorthand: false,
                    key: out.key,
                    value: function_expression,
                    computed: out.computed,
                    start: out.start,
                    end: out.end,
                    loc: out.loc,
                    range: out.range,
                }
                return fake_property
            }

            return out
        }
        case 'html_comment':
        case 'comment': {
            if (cursor.nodeText.startsWith('//')) {
                out.type = 'Line'
                out.value = cursor.nodeText.slice(2)
            } else if (cursor.nodeText.startsWith('/*')) {
                out.type = 'Block'
                out.value = cursor.nodeText.slice(2, -2)
            } else {
                out.type = 'Line'
                out.value = cursor.nodeText.slice(4, -3)
            }

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
        case 'object': {
            out.properties = children.flatMap((pair) => {
                const [kind, child] = pair
                switch (kind) {
                    case '{':
                    case ',':
                    case '}':
                        return []
                    default:
                        return [child]
                }
            })
            return out
        }
        case 'string': {
            out.raw = cursor.nodeText
            out.value = cursor.nodeText.slice(1, -1)
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
            return out
        }
    }
}
