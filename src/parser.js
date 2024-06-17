import assert from 'node:assert/strict'
import Parser from 'web-tree-sitter'
import { type_mapping, field_map } from './renames'

const THROW_ON_ERROR = true

await Parser.init()
const JavaScript = await Parser.Language.load('./vendored/tree-sitter-javascript.wasm')

const parser = new Parser()

parser.setLanguage(JavaScript)

let ts_comments = []

/** @param {string} text */
export const parse = (text) => {
    ts_comments = []

    const comments = []
    const tokens = []

    const ts_ast = parser.parse(text)

    let [_, out_obj] = traverse_tree(ts_ast.walk())
    out_obj = cull_parenthesized_expressions(out_obj)
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

/**
 * @param {object} out
 */
function cull_parenthesized_expressions(out) {
    for (let [key, val] of Object.entries(out)) {
        if (typeof val !== 'object' || val === null) {
            continue
        }

        out[key] = cull_parenthesized_expressions(val)
        if (val.type === 'ParenthesizedExpression') {
            out[key] = val.expression
        }
    }

    return out
}

const useless_children = new Set()
useless_children.add('regex')

const symbol_children = new Set(['{', ',', '}', '(', ')', ':', '?', '${', '...', ';', '[', ']'])

/**
 * @template T
 * @param {[string, T][]} children
 * @returns {[string, T][]}
 */
function non_symbol_children(children) {
    return children.filter(([key, _unused]) => !symbol_children.has(key))
}

/**
 * @template T
 * @param {[string, T][]} children
 * @param {string} name
 * @param {string?} parent_name
 * @returns {T}
 */
function findx_child(children, name, parent_name) {
    const found = find_child(children, name)
    if (found === undefined) {
        throw new Error(`Couldnt find child ${name} of parent ${parent_name ?? 'unknown'}`)
    }
    return found
}
/**
 * @param {(Statement|ModuleDeclaration)[]} body
 */
function annotate_directives(body) {
    for (let elem of body) {
        if (elem.type !== 'ExpressionStatement') return
        const expression = elem.expression
        if (expression.type !== 'Literal' || typeof expression.value !== 'string') return

        elem.directive = expression.value
    }
}

/**
 * @template T
 * @param {object} out
 * @param {[string, unknown][]} children
 * @returns {object}
 */
function apply_children(out, children) {
    for (let pair of children) {
        out[field_map.get(pair[0]) ?? pair[0]] = pair[1]
    }
    return out
}

/**
 * @template T
 * @param {[string, T][]} children
 * @param {string} name
 * @returns {T | undefined}
 */
function find_child(children, name) {
    return children.find((x) => x[0] === name)?.[1]
}

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

const program_cursor_to_loc = (cursor) => {
    const end = convert_position(cursor.endPosition)
    return {
        start: 0,
        end: cursor.endIndex,
        loc: {
            start: {
                line: 1,
                column: 0,
            },
            end,
        },
        range: [0, cursor.endIndex],
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

/**
 * @param {Parser.TreeCursor} cursor
 * @param {unknown[]} children
 */
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
                if (i !== ts_children.length - 1) avoid_comment_child = ts_children[i]
                break
            }
        }
    }

    let out = cursor.nodeType === 'program' ? program_cursor_to_loc(cursor) : cursor_to_loc(cursor)

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
        case 'export_clause': {
            out.children = non_symbol_children(children)
            return out
        }
        case 'namespace_export': {
            // skip '*' and 'as'
            out.name = children[2][1]
            return out
        }
        case 'export_specifier': {
            out.local = findx_child(children, 'name', 'export_specifier')
            out.exported = find_child(children, 'alias') ?? out.local

            return out
        }
        case 'export_statement': {
            let namespace_child = find_child(children, 'namespace_export')
            if (find_child(children, '*') || namespace_child) {
                out.type = 'ExportAllDeclaration'
                out.source = findx_child(children, 'source', cursor.nodeType)
                out.exported = namespace_child?.name ?? null
            } else if (find_child(children, 'default')) {
                out.type = 'ExportDefaultDeclaration'
                const value = children.find((x) => x[0] === 'value' || x[0] === 'declaration')
                out.declaration = value[1]
            } else if (find_child(children, 'export_clause')) {
                out.type = 'ExportNamedDeclaration'
                out.declaration = null
                const source = find_child(children, 'source')
                out.source = source ?? null

                const clause = findx_child(children, 'export_clause')
                out.specifiers = clause.children.map((x) => x[1])
            }

            return out
        }
        case 'import_specifier': {
            out.imported = findx_child(children, 'name', cursor.nodeType)
            const local = find_child(children, 'alias')

            out.local = local ?? out.imported

            return out
        }
        case 'named_imports': {
            out.children = non_symbol_children(children)
            return out
        }
        case 'namespace_import': {
            out.local = findx_child(children, 'identifier', cursor.nodeType)
            return out
        }
        case 'import_clause': {
            const relevant_children = non_symbol_children(children)
            out.children = []
            for (let [kind, node] of relevant_children) {
                switch (kind) {
                    case 'named_imports': {
                        out.children.push(...node.children.map((x) => x[1]))
                        continue
                    }
                    case 'namespace_import': {
                        out.children.push(node)
                        continue
                    }
                    case 'identifier': {
                        out.children.push({
                            start: node.start,
                            end: node.end,
                            range: node.range,
                            loc: node.loc,
                            type: 'ImportDefaultSpecifier',
                            local: node,
                        })
                        continue
                    }
                }
            }

            return out
        }
        case 'import_statement': {
            const import_specifier_node = find_child(children, 'import_clause', cursor.nodeType)
            if (import_specifier_node) {
                out.specifiers = import_specifier_node.children
            } else {
                out.specifiers = []
            }

            out.source = findx_child(children, 'source', cursor.nodeType)
            return out
        }
        case 'arguments': {
            out.children = non_symbol_children(children)
            return out
        }
        case 'expression_statement': {
            out.expression = children[0][1]
            return out
        }
        case 'binary_expression': {
            apply_children(out, children)
            const is_logical = ['||', '??', '&&'].includes(out.operator)
            if (is_logical) out.type = 'LogicalExpression'
            return out
        }
        case 'assignment_expression': {
            out.left = findx_child(children, 'left', 'assigment_expression')
            out.right = findx_child(children, 'right', 'assigment_expression')

            out.operator = '='
            return out
        }
        case 'await_expression': {
            const candidates = children.filter((x) => x[0] !== 'await')
            if (candidates.length !== 1) {
                throw new Error(
                    `Await expression with non-one expressions length ${candidates.length}`
                )
            }
            out.argument = candidates[0][1]

            return out
        }
        case 'new_expression': {
            out.callee = findx_child(children, 'constructor', 'new_expression')
            out.arguments = findx_child(children, 'arguments', 'new_expression').children.map(
                (x) => x[1]
            )
            return out
        }
        case 'call_expression': {
            const args = findx_child(children, 'arguments', 'call_expression')
            // Tree sitter reads template literals as call expression, handle that here
            if (args.type === 'TemplateLiteral') {
                out.tag = findx_child(children, 'function', 'call_expression')
                out.quasi = args
                out.type = 'TaggedTemplateExpression'
            } else {
                out.optional = find_child(children, 'optional_chain') !== undefined
                out.callee = findx_child(children, 'function', 'call_expression')
                out.arguments = args.children.map((x) => x[1])
            }
            return out
        }
        case 'variable_declarator': {
            out.id = findx_child(children, 'name', cursor.nodeType)
            out.init = find_child(children, 'value') ?? null
            return out
        }
        case 'lexical_declaration': {
            out.kind = findx_child(children, 'kind', cursor.nodeType).type.toLowerCase()
            out.declarations = non_symbol_children(children)
                .slice(1)
                .map((x) => x[1])
            return out
        }
        case 'variable_declaration': {
            out.kind = 'var'
            out.declarations = non_symbol_children(children)
                .slice(1)
                .map((x) => x[1])
            return out
        }
        case 'field_definition': {
            const key_child = findx_child(children, 'property', cursor.nodeType)
            out.key = key_child

            out.value = findx_child(children, 'value', cursor.nodeType)

            out.computed = key_child.name.startsWith('[')
            out.static = find_child(children, 'static') != null
            return out
        }
        case 'class_body': {
            out.body = non_symbol_children(children).map((x) => x[1])
            return out
        }
        case 'class': {
            if (children.length === 0) {
                //'class' overlaps with the literal
                return out
            }
            out.body = findx_child(children, 'body', cursor.nodeType)
            out.id = find_child(children, 'name') ?? null
            out.superClass = find_child(children, 'class_heritage') ?? null
            return out
        }
        case 'class_declaration': {
            out.id = findx_child(children, 'name', cursor.nodeType)
            out.body = findx_child(children, 'body', cursor.nodeType)
            out.superClass = find_child(children, 'class_heritage') ?? null
            return out
        }
        case 'escape_sequence':
        case 'string_fragment': {
            out.text = cursor.nodeText
            return out
        }
        case 'template_substitution': {
            out.child = non_symbol_children(children)[0][1]
            return out
        }
        case 'template_string': {
            let was_string = true
            const todo_quasis = []
            let staging_quasis = []
            out.expressions = []
            for (let child of children) {
                const is_expr = child[0] === 'template_substitution'
                if (was_string && (is_expr || child[0] === '`')) {
                    if (staging_quasis.length) {
                        todo_quasis.push(staging_quasis)
                    }
                    staging_quasis = []
                }
                if (is_expr) {
                    out.expressions.push(child[1].child)
                } else if (child[0] !== '`') {
                    staging_quasis.push(child)
                }

                was_string = !is_expr
            }

            out.quasis = todo_quasis.map((incoming) => {
                return incoming.reduce(
                    (acc, cur) => {
                        acc.value.cooked +=
                            cur[0] === 'string_fragment' ? cur[1].text : unraw(cur[1].text)
                        acc.value.raw += cur[1].text

                        return { ...acc, ...merge_position(acc, cur[1]) }
                    },
                    {
                        start: incoming[0][1].start,
                        end: incoming[0][1].end,
                        loc: incoming[0][1].loc,
                        range: incoming[0][1].range,
                        type: 'TemplateElement',
                        tail: false,
                        value: {
                            cooked: '',
                            raw: '',
                        },
                    }
                )
            })

            if (out.quasis.at(-1)) out.quasis.at(-1).tail = true
            return out
        }
        case 'statement_block': {
            out.body = non_symbol_children(children).map((x) => x[1])
            return out
        }
        case 'array_pattern': {
            out.elements = non_symbol_children(children).map((x) => x[1])
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
            const key_child = findx_child(children, 'key', cursor.nodeType)
            out.kind = 'init' // TODO need to support object getters
            out.method = false
            out.shorthand = false
            out.value = findx_child(children, 'value', cursor.nodeType)
            out.key = key_child
            out.computed = key_child.name?.startsWith?.('[') ?? false
            return out
        }
        case 'property_identifier': {
            out.name = cursor.nodeText
            return out
        }
        case 'object_pattern': {
            out.properties = non_symbol_children(children).map((x) => x[1])
            return out
        }
        case 'spread_element': {
            out.argument = non_symbol_children(children)[0][1]
            return out
        }
        case 'computed_property_name': {
            return non_symbol_children(children)[0][1]
        }
        case 'array': {
            out.elements = non_symbol_children(children).map((x) => x[1])
            return out
        }
        case 'sequence_expression': {
            out.expressions = non_symbol_children(children).map((x) => x[1])
            return out
        }
        case 'parenthesized_expression': {
            out.expression = non_symbol_children(children)[0][1]
            return out
        }
        case 'formal_parameters': {
            out.children = non_symbol_children(children)
            return out
        }
        case 'ternary_expression': {
            children = non_symbol_children(children)
            return apply_children(out, children)
        }
        case 'arrow_function': {
            const body = findx_child(children, 'body', 'arrow_function')
            out.expression = body.type !== 'BlockStatement'

            const parameter = find_child(children, 'parameter')

            if (parameter) {
                out.params = [parameter]
            } else {
                const parameters = findx_child(children, 'parameters', 'arrow_function')
                const parameter_children = parameters.children
                out.params = parameter_children.map((x) => x[1])
            }

            out.id = null
            out.generator = false
            out.async = children[0][1].nodeText === 'async'

            out.body = body
            return out
        }
        case 'function_declaration': {
            out.id = findx_child(children, 'name', cursor.nodeType)
            out.params = findx_child(children, 'parameters', cursor.nodeType).children.map(
                (x) => x[1]
            )
            out.body = findx_child(children, 'body', cursor.nodeType)
            out.async = findx_child(children, 'name', cursor.nodeType)
            out.generator = false
            out.expression = false
            out.async = find_child(children, 'async') ?? false
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
            out.key = findx_child(children, 'name', 'method_definition')
            const body = findx_child(children, 'body', 'method_definition')
            const params = findx_child(children, 'parameters', 'method_definition')
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
            const pattern = cursor.currentNode.childForFieldName('pattern')?.text
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
            out.properties = non_symbol_children(children).map((x) => x[1])
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
        case 'undefined': {
            out.type = 'Identifier'
            out.name = 'undefined'
            return out
        }
        case 'null': {
            out.raw = 'null'
            out.type = 'Literal'
            out.value = null
            return out
        }
        case 'true': {
            out.raw = 'true'
            out.type = 'Literal'
            out.value = true
            return out
        }
        case 'false': {
            out.raw = 'false'
            out.type = 'Literal'
            out.value = false
            return out
        }
        case 'statement_identifier': {
            out.name = cursor.nodeText
            return out
        }
        case 'program': {
            out.body = children.map((x) => x[1])
            annotate_directives(out.body)
            return out
        }
        case 'for_in_statement': {
            if (findx_child(children, 'operator', cursor.nodeType) === 'of') {
                out.await = find_child(children, 'await') != null
                out.type = 'ForOfStatement'
            }
            const kind = find_child(children, 'kind')
            if (kind != null) {
                let id = findx_child(children, 'left', cursor.nodeType)

                out.left = {
                    type: 'VariableDeclaration',
                    ...merge_position(kind, id),
                    kind: kind.type.toLowerCase(),
                    declarations: [
                        {
                            start: id.start,
                            end: id.end,
                            range: id.range,
                            loc: id.loc,
                            type: 'VariableDeclarator',
                            id: id,
                            init: null,
                        },
                    ],
                }
            } else {
                out.left = findx_child(children, 'left', cursor.nodeType)
            }
            out.right = findx_child(children, 'right', cursor.nodeType)
            out.body = findx_child(children, 'body', cursor.nodeType)
            return out
        }
        case 'if_statement': {
            const parenthesized_expression = findx_child(children, 'condition', cursor.nodeType)

            out.test = parenthesized_expression
            out.consequent = findx_child(children, 'consequence', cursor.nodeType)
            const else_statement = find_child(children, 'alternative', cursor.nodeType)
            out.alternate = else_statement?.body ?? null
            return out
        }
        case 'else_clause': {
            out.body = children.find((x) => x[0] !== 'else')[1]
            return out
        }
        case 'return_statement': {
            const child_candidates = children.filter((x) => x[0] !== 'return').map((x) => x[1])
            if (child_candidates.length > 1) {
                throw new Error(
                    'return with multiple expressions? ' + JSON.stringify(child_candidates)
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
        case 'ERROR': {
            if (THROW_ON_ERROR) {
                throw new Error(`Error in parsing at ${JSON.stringify(out.loc)}`)
            }
        }
        default: {
            //console.log('defaulting', cursor.nodeType)
            // TODO probably enumerate which ones we expect to hit here
            return apply_children(out, non_symbol_children(children))
        }
    }
}

// https://stackoverflow.com/questions/57330203/unraw-a-string-in-javascript
function unraw(str) {
    return str.replace(
        /\\[0-9]|\\['"\bfnrtv]|\\x[0-9a-f]{2}|\\u[0-9a-f]{4}|\\u\{[0-9a-f]+\}|\\./gi,
        (match) => {
            switch (match[1]) {
                case "'":
                case '"':
                case '\\':
                    return match[1]
                case 'b':
                    return '\b'
                case 'f':
                    return '\f'
                case 'n':
                    return '\n'
                case 'r':
                    return '\r'
                case 't':
                    return '\t'
                case 'v':
                    return '\v'
                case 'u':
                    if (match[2] === '{') {
                        return String.fromCodePoint(parseInt(match.substring(3), 16))
                    }
                    return String.fromCharCode(parseInt(match.substring(2), 16))
                case 'x':
                    return String.fromCharCode(parseInt(match.substring(2), 16))
                case '0':
                    return '\0'
                default: // E.g., "\q" === "q"
                    return match.substring(1)
            }
        }
    )
}
