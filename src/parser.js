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
    out_obj = insert_chain_expressions(out_obj)
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
function insert_chain_expressions(out) {
    for (let [key, val] of Object.entries(out)) {
        if (typeof val !== 'object' || val === null) {
            continue
        }

        const modified = insert_chain_expressions(val)
        out[key] = modified
    }

    if (out.type === 'MemberExpression' && out.object.type === 'ChainExpression') {
        out.object = out.object.expression
        out = {
            start: out.start,
            end: out.end,
            range: out.range,
            loc: out.loc,
            type: 'ChainExpression',
            expression: out,
        }
    } else if (out.type === 'CallExpression' && out.callee.type === 'ChainExpression') {
        out.callee = out.callee.expression
        out = {
            start: out.start,
            end: out.end,
            range: out.range,
            loc: out.loc,
            type: 'ChainExpression',
            expression: out,
        }
    } else if ((out.type === 'MemberExpression' || out.type === 'CallExpression') && out.optional) {
        out = {
            start: out.start,
            end: out.end,
            range: out.range,
            loc: out.loc,
            type: 'ChainExpression',
            expression: out,
        }
    }
    return out
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

const adjust_jsx_member_expr = (obj) => {
    if (obj.type === 'Identifier') {
        obj.type = 'JSXIdentifier'
        return obj
    }
    obj.type = 'JSXMemberExpression'
    obj.object = adjust_jsx_member_expr(obj.object)
    obj.property.type = 'JSXIdentifier'
    return obj
}

const adjust_jsx_name = (obj) => {
    if (!obj?.name) return obj
    if (obj.name.type === 'Identifier') obj.name.type = 'JSXIdentifier'
    if (obj.name.type !== 'MemberExpression') return obj
    obj.name = adjust_jsx_member_expr(obj.name)
    return obj
}

const shorthand_to_property = (id) => ({
    start: id.start,
    end: id.end,
    loc: id.loc,
    range: id.range,
    type: 'Property',
    computed: false,
    kind: 'init',
    method: false,
    shorthand: true,
    value: id,
    key: id,
})

const useless_children = new Set()
useless_children.add('regex')

const symbol_children = new Set([
    '{',
    ',',
    '}',
    '(',
    ')',
    ':',
    '?',
    '${',
    '...',
    ';',
    '[',
    ']',
    '*',
])

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
        const key = field_map.get(pair[0]) ?? pair[0]
        if (key === 'operator') {
            out[key] = pair[1].text
        } else {
            out[key] = pair[1]
        }
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

/**
 * @param {string} string
 * @returns {string}
 */
function stylistic_capitalize(string) {
    if (string.startsWith('jsx')) {
        return `JSX${string.charAt(3).toUpperCase()}${string.slice(4)}`
    }
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

const function_expression_to_declaration = (expression) => {
    return {
        ...expression,
        type: 'FunctionDeclaration',
        id: null,
    }
}

/**
 * @param {Parser.TreeCursor} cursor
 * @param {unknown[]} children
 */
const convert = (cursor, children) => {
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

    if (cursor.currentFieldName === 'operator') {
        out.text = cursor.nodeText
        return out
    }

    out.type =
        type_mapping.get(cursor.nodeType) ??
        cursor.nodeType
            .split('_')
            .map((word) => stylistic_capitalize(word))
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
                let value = children.find((x) => x[0] === 'value' || x[0] === 'declaration')[1]
                // TODO: drop when this is resolved
                // https://github.com/tree-sitter/tree-sitter-javascript/issues/323
                if (value.type === 'FunctionExpression') {
                    value = function_expression_to_declaration(value)
                }
                out.declaration = value
            } else {
                out.type = 'ExportNamedDeclaration'
                out.declaration = null
                const source = find_child(children, 'source')
                out.source = source ?? null

                const clause = find_child(children, 'export_clause')
                if (clause) {
                    out.specifiers = clause.children.map((x) => x[1])
                } else {
                    out.specifiers = []
                    out.declaration = findx_child(children, 'declaration', cursor.nodeType)
                }
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
            const args_node = find_child(children, 'arguments')
            if (args_node) {
                out.arguments = args_node.children.map((x) => x[1])
            } else {
                out.arguments = []
            }
            return out
        }
        case 'call_expression': {
            const args = findx_child(children, 'arguments', 'call_expression')
            const func = findx_child(children, 'function', 'call_expression')
            // Tree sitter reads template literals as call expression, handle that here
            if (args.type === 'TemplateLiteral') {
                out.type = 'TaggedTemplateExpression'
                out.tag = func
                out.quasi = args
            } else if (func.type === 'Import') {
                // Tree sitter also has no separate node for import expression
                if (args.children.length !== 1) {
                    throw new Error(
                        `Found import expression with non-one args ${args.children.map(
                            (x) => x[0]
                        )}`
                    )
                }
                out.type = 'ImportExpression'
                out.source = args.children[0][1]
            } else {
                out.optional = find_child(children, 'optional_chain') !== undefined
                out.callee = func
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
        case 'class_static_block': {
            out.body = findx_child(children, 'body', cursor.nodeType).body
            return out
        }
        case 'field_definition': {
            let key_child = findx_child(children, 'property', cursor.nodeType)
            if (key_child.computed) {
                out.computed = true
                key_child = key_child.child
            } else {
                out.computed = false
            }

            out.key = key_child

            out.value = find_child(children, 'value', cursor.nodeType) ?? null
            out.static = find_child(children, 'static') != null

            return out
        }
        case 'class_body': {
            // ';' should be considered part of the region for property defintion
            // but tree-sitter AST doesnt do this for conflict trickery
            out.body = children.flatMap(([kind, node], idx) => {
                if (kind === '{' || kind === ';' || kind === '}') return []
                const next_child = children.at(idx + 1)
                if (!next_child) return [node]
                if (node.type === 'PropertyDefinition' && next_child[0] === ';') {
                    return [
                        {
                            ...node,
                            ...merge_position(node, next_child[1]),
                        },
                    ]
                }
                return [node]
            })

            return out
        }
        case 'class_heritage': {
            out.expression = non_symbol_children(children).filter((x) => x[0] !== 'extends')[0][1]
            return out
        }
        case 'class': {
            if (children.length === 0) {
                //'class' overlaps with the literal
                return out
            }
            out.body = findx_child(children, 'body', cursor.nodeType)
            out.id = find_child(children, 'name') ?? null
            out.superClass = find_child(children, 'class_heritage')?.expression ?? null
            return out
        }
        case 'class_declaration': {
            out.id = findx_child(children, 'name', cursor.nodeType)
            out.body = findx_child(children, 'body', cursor.nodeType)
            out.superClass = find_child(children, 'class_heritage')?.expression ?? null
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
            // yeah this is pretty ugly, deserves a refactor
            let is_empty = true
            const todo_quasis = []
            let staging_quasis = []
            out.expressions = []
            for (let i = 0; i < children.length; i++) {
                const child = children[i]
                is_empty &&= child[0] === '`'
                const is_expr = child[0] === 'template_substitution'
                if (is_expr || child[0] === '`') {
                    if (staging_quasis.length) {
                        todo_quasis.push(staging_quasis)
                    } else if (i !== 0) {
                        const start = child[1].start
                        todo_quasis.push([
                            [
                                'string_fragment',
                                {
                                    start,
                                    end: start,
                                    loc: { start: child[1].loc.start, end: child[1].loc.start },
                                    range: [start, start],
                                    text: '',
                                },
                            ],
                        ])
                    }
                    staging_quasis = []
                }

                if (is_expr) {
                    out.expressions.push(child[1].child)
                } else if (child[0] !== '`') {
                    staging_quasis.push(child)
                }
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
        case 'rest_pattern': {
            out.argument = children[1][1]
            return out
        }
        case 'object_assignment_pattern': {
            const left = findx_child(children, 'left', cursor.nodeType)
            out.value = {
                ...out,
                type: 'AssignmentPattern',
                left,
                right: findx_child(children, 'right', cursor.nodeType),
            }

            out.key = left
            out.computed = false
            out.kind = 'init'
            out.method = false
            out.shorthand = true
            return out
        }
        case 'pair':
        case 'pair_pattern': {
            let key_child = findx_child(children, 'key', cursor.nodeType)
            if (key_child.computed) {
                out.computed = true
                key_child = key_child.child
            } else {
                out.computed = false
            }
            out.kind = 'init' // TODO need to support object getters
            out.method = false
            out.shorthand = false
            out.value = findx_child(children, 'value', cursor.nodeType)
            out.key = key_child
            return out
        }
        case 'private_property_identifier': {
            out.name = cursor.nodeText.slice(1)
            return out
        }
        case 'property_identifier': {
            out.name = cursor.nodeText
            return out
        }
        case 'object_pattern': {
            out.properties = non_symbol_children(children)
                .map(([kind, id]) => {
                    if (!kind.startsWith('shorthand')) {
                        return [kind, id]
                    }
                    return [kind, shorthand_to_property(id)]
                })
                .map((x) => x[1])
            return out
        }
        case 'spread_element': {
            out.argument = non_symbol_children(children)[0][1]
            return out
        }
        case 'computed_property_name': {
            out.computed = true
            out.child = non_symbol_children(children)[0][1]
            return out
        }
        case 'array_pattern':
        case 'array': {
            out.elements = children.reduce(
                ([was_empty, acc], [key, val]) => {
                    if (key === '[' || key === ']') return [true, acc]
                    if (key === ',') {
                        if (was_empty) acc.push(null)

                        return [true, acc]
                    }
                    acc.push(val)
                    return [false, acc]
                },
                [true, []]
            )[1]
            return out
        }
        case 'update_expression': {
            const operator = findx_child(children, 'operator', cursor.nodeType)
            out.operator = operator.text
            out.argument = findx_child(children, 'argument', cursor.nodeType)
            out.prefix = operator.start < out.argument.start
            return out
        }
        case 'unary_expression': {
            const operator = findx_child(children, 'operator', cursor.nodeType)
            out.operator = operator.text
            out.argument = findx_child(children, 'argument', cursor.nodeType)
            out.prefix = true
            return out
        }
        case 'subscript_expression': {
            out.object = findx_child(children, 'object', cursor.nodeType)
            out.property = findx_child(children, 'index', cursor.nodeType)

            out.computed = true
            const optional_child = find_child(children, 'optional_chain')
            out.optional = optional_child != null

            return out
        }
        case 'member_expression': {
            out.object = findx_child(children, 'object', cursor.nodeType)
            out.property = findx_child(children, 'property', cursor.nodeType)

            out.computed = false
            const optional_child = find_child(children, 'optional_chain')
            out.optional = optional_child != null

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
        case 'yield_expression': {
            out.argument = non_symbol_children(children).find((x) => x[0] !== 'yield')?.[1] ?? null
            out.delegate = find_child(children, '*') != null
            return out
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
            out.async = find_child(children, 'async') != null

            out.body = body
            return out
        }
        case 'generator_function':
        case 'generator_function_declaration':
        case 'function_expression':
        case 'function_declaration': {
            // allow null here for declarations in case of `export default function`
            out.id = find_child(children, 'name') ?? null
            out.params = findx_child(children, 'parameters', cursor.nodeType).children.map(
                (x) => x[1]
            )
            out.body = findx_child(children, 'body', cursor.nodeType)
            out.generator =
                cursor.nodeType === 'generator_function' ||
                cursor.nodeType === 'generator_function_declaration'

            // Depricated field that we always set false
            // https://github.com/estree/estree/blob/18fc6cc4be436548a8f86736907299ae850a1a26/deprecated.md#functions
            out.expression = false
            out.async = find_child(children, 'async') != null
            return out
        }
        case 'method_definition': {
            const maybe_prefix = cursor.currentNode.children[0]

            const child_types = children.map((x) => x[0])
            if (child_types.includes('get') || child_types.includes('static get')) {
                out.kind = 'get'
            } else if (child_types.includes('set')) {
                out.kind = 'set'
            } else {
                out.kind = 'method'
            } // TODO: constructor kind

            out.static = child_types.includes('static') || child_types.includes('static get')
            let key_child = findx_child(children, 'name', 'method_definition')
            if (key_child.computed) {
                out.computed = true
                key_child = key_child.child
            } else {
                out.computed = false
            }
            out.key = key_child
            const body = findx_child(children, 'body', 'method_definition')
            const params = findx_child(children, 'parameters', 'method_definition')
            out.value = {
                type: 'FunctionExpression',
                body,
                expression: false,
                id: null,
                generator: child_types.includes('*'),
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
        case 'jsx_element': {
            out.openingElement = findx_child(children, 'open_tag', cursor.nodeType)
            out.children = non_symbol_children(children)
                .filter((x) => x[0] !== 'open_tag' && x[0] !== 'close_tag')
                .map((x) => x[1])
            out.closingElement = findx_child(children, 'close_tag', cursor.nodeType)
            out.openingElement.selfClosing = false

            return out
        }
        case 'jsx_attribute': {
            out.value = null
            for (let child of non_symbol_children(children)) {
                switch (child[0]) {
                    // name
                    case 'jsx_namespace_name': {
                        out.name = child[1]
                        break
                    }
                    case 'property_identifier': {
                        out.name = child[1]
                        out.name.type = 'JSXIdentifier'
                        break
                    }
                    // value
                    case 'string':
                    case 'jsx_expression':
                    case 'jsx_element':
                    case 'jsx_self_closing_element': {
                        out.value = child[1]
                        break
                    }
                }
            }
            return out
        }
        case 'jsx_expression': {
            out.expression = non_symbol_children(children).at(0)?.[1]
            if (out.expression == null) {
                const child = findx_child(children, '{', cursor.nodeType)
                const start = child.start
                out.expression = {
                    start,
                    end: start,
                    loc: { start: child.loc.start, end: child.loc.start },
                    range: [start, start],
                    type: 'JSXEmptyExpression',
                }
            }
            return out
        }
        case 'jsx_self_closing_element': {
            const name = findx_child(children, 'name', cursor.nodeType)

            out.children = []
            out.openingElement = {
                start: out.start,
                end: out.end,
                attributes: children.filter((x) => x[0] === 'attribute').map((x) => x[1]),
                range: out.range,
                loc: out.loc,
                type: 'JSXOpeningElement',
                name: name,
                selfClosing: true,
            }
            out.openingElement = adjust_jsx_name(out.openingElement)
            out.closingElement = null

            return out
        }
        case 'jsx_opening_element': {
            out.name = find_child(children, 'name')
            out = adjust_jsx_name(out)

            out.attributes = children.filter((x) => x[0] === 'attribute').map((x) => x[1])

            return out
        }
        case 'jsx_closing_element': {
            out.name = find_child(children, 'name')
            out = adjust_jsx_name(out)
            return out
        }
        case 'jsx_namespace_name': {
            const relevant = children.filter((x) => x[0] !== ':')
            if (relevant.length !== 2) {
                throw new Error(
                    `jsx namespaced name found innapropriate # children ${children.map(
                        (x) => x[0]
                    )}`
                )
            }
            out.namespace = relevant[0][1]
            out.namespace.type = 'JSXIdentifier'
            out.name = relevant[1][1]
            out.name.type = 'JSXIdentifier'

            return out
        }

        case 'hash_bang_line':
        case 'html_comment':
        case 'comment': {
            if (cursor.nodeText.startsWith('//') || cursor.nodeText.startsWith('#!')) {
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
            out.properties = non_symbol_children(children)
                .map(([kind, id]) => {
                    if (!kind.startsWith('shorthand')) {
                        return [kind, id]
                    }
                    return [kind, shorthand_to_property(id)]
                })
                .map((x) => x[1])
            return out
        }
        case 'jsx_text': {
            out.raw = cursor.nodeText
            out.value = cursor.nodeText
            return out
        }
        case 'string': {
            out.raw = cursor.nodeText
            out.value = cursor.nodeText.slice(1, -1)
            return out
        }
        case 'number': {
            out.raw = cursor.nodeText

            const text = cursor.nodeText
                .split('')
                .filter((x) => x !== '_')
                .join('')

            const is_big_int = out.raw.endsWith('n')

            let prefix_len
            let base
            if (out.raw.startsWith('0b') || out.raw.startsWith('0B')) {
                prefix_len = 2
                base = 2
            } else if (out.raw.startsWith('0x') || out.raw.startsWith('0X')) {
                prefix_len = 2
                base = 16
            } else if (out.raw.startsWith('0.') || out.raw.startsWith('.')) {
                prefix_len = 0
                base = 10
            } else if (out.raw.startsWith('0o') || out.raw.startsWith('0O')) {
                prefix_len = 2
                base = 8
            } else if (out.raw.startsWith('0')) {
                const is_zero = text === '0' || text === '0n'
                prefix_len = is_zero ? 0 : 1
                if (out.raw.includes('8') || out.raw.includes('9') || is_zero) {
                    base = 10
                } else {
                    base = 8
                }
            } else {
                base = 10
            }

            if (base == 10) {
                if (is_big_int) {
                    out.value = BigInt(text.slice(prefix_len, -1))
                    out.bigint = out.raw.slice(0, -1)
                } else {
                    out.value = Number(text.slice(prefix_len))
                }
            } else {
                out.value = parseInt(text.slice(prefix_len), base)
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
        case 'for_statement': {
            out.init = findx_child(children, 'initializer', cursor.nodeType)
            if (out.init.type === 'EmptyStatement') out.init = null
            else if (out.init.type === 'ExpressionStatement') out.init = out.init.expression
            else {
                const last_node = out.init.declarations?.at(-1)
                if (last_node) {
                    out.init.end = last_node.end
                    out.init.loc.end = last_node.loc.end
                    out.init.range[1] = last_node.range[1]
                }
            }

            out.test = findx_child(children, 'condition', cursor.nodeType)
            if (out.test.type === 'EmptyStatement') out.test = null
            else if (out.test.type === 'ExpressionStatement') out.test = out.test.expression

            out.update = find_child(children, 'increment') ?? null

            out.body = findx_child(children, 'body', cursor.nodeType)
            return out
        }
        case 'for_in_statement': {
            if (findx_child(children, 'operator', cursor.nodeType).text === 'of') {
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
        case 'try_statement': {
            out.block = findx_child(children, 'body', cursor.nodeType)
            out.handler = find_child(children, 'handler') ?? null
            out.finalizer = find_child(children, 'finalizer') ?? null
            return out
        }
        case 'catch_clause': {
            out.param = find_child(children, 'parameter') ?? null
            out.body = findx_child(children, 'body', cursor.nodeType)

            return out
        }
        case 'finally_clause': {
            return findx_child(children, 'body', cursor.nodeType)
        }
        case 'switch_statement': {
            out.discriminant = findx_child(children, 'value', cursor.nodeType)
            out.cases = findx_child(children, 'body', cursor.nodeType).children.map((x) => x[1])

            return out
        }
        case 'switch_body': {
            out.children = non_symbol_children(children)
            return out
        }
        case 'switch_case':
        case 'switch_default': {
            out.test = find_child(children, 'value') ?? null
            const body = find_child(children, 'body', cursor.nodeType)
            out.consequent = body ? [body] : []

            return out
        }
        case 'break_statement': {
            out.label = find_child(children, 'label') ?? null

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
            out.body = non_symbol_children(children).find((x) => x[0] !== 'else')[1]
            return out
        }
        case 'return_statement': {
            const child_candidates = non_symbol_children(children)
                .filter((x) => x[0] !== 'return')
                .map((x) => x[1])
            if (child_candidates.length > 1) {
                throw new Error(
                    'return with multiple expressions? ' + JSON.stringify(child_candidates, null, 4)
                )
            }
            out.argument = child_candidates[0] ?? null
            return out
        }
        case 'new': {
            return null
        }
        case 'shorthand_property_identifier':
        case 'shorthand_property_identifier_pattern':
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
            //            console.log('defaulting', cursor.nodeType)
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
