import { readFile } from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import * as prettier from 'prettier'

import { parsers } from '../src/index.js'
import { parse as acorn_parse } from './acorn_reference.js'
import { should_throw } from './throwers.js'

const DEBUG = process.env.DEBUG ?? false
const corpus_dirname = process.env.CORPUS ?? 'corpus'

const test_dir = path.dirname(url.fileURLToPath(import.meta.url))
const corpus_dir = path.join(test_dir, corpus_dirname)
//const corpus_dir = path.join(test_dir, 'ambition')

const dir = fs.readdirSync(corpus_dir, { withFileTypes: true })

const files = await Promise.all(
    dir
        .flatMap((file) => {
            const basename = file.name
            const filename = path.join(corpus_dir, basename)
            if (
                path.extname(basename) === '.snap' ||
                !file.isFile() ||
                basename[0] === '.' ||
                // VSCode creates this file sometime https://github.com/microsoft/vscode/issues/105191
                basename === 'debug.log'
            ) {
                return []
            }
            return [{ basename, filename }]
        })
        .map(({ basename, filename }) =>
            readFile(filename, 'utf8').then((text) => ({
                name: basename,
                text,
            }))
        )
)

console.log('finished reading')

const base_ts_opts = {
    parser: 'tree-sitter',
    plugins: [{ parsers }],
}

const ts_parse = parsers['tree-sitter'].parse

const base_acorn_opts = {
    parser: 'custom-acorn',
    plugins: [
        {
            parsers: {
                'custom-acorn': {
                    ...parsers['tree-sitter'],
                    parse: acorn_parse,
                },
            },
        },
    ],
}

test('smoke test', async () => {
    const formatted_ts = await prettier.format('lodash ( )', ts_opts)
    expect(formatted_ts).toBe('lodash();\n')
    const formatted_acorn = await prettier.format('lodash ( )', acorn_opts)
    expect(formatted_acorn).toBe('lodash();\n')
})

const pare_acorn_tree = (obj) =>
    JSON.parse(
        JSON.stringify(obj, function (key, value) {
            if (this.type === 'Program' && key === 'sourceType')
                return undefined
            if (this.type === 'Literal' && ['bigint'].includes(key))
                return undefined

            return value
        })
    )

const CURSOR_PLACEHOLDER = '<|>'
const RANGE_START_PLACEHOLDER = '<<<PRETTIER_RANGE_START>>>'
const RANGE_END_PLACEHOLDER = '<<<PRETTIER_RANGE_END>>>'
const indexProperties = [
    {
        property: 'cursorOffset',
        placeholder: CURSOR_PLACEHOLDER,
    },
    {
        property: 'rangeStart',
        placeholder: RANGE_START_PLACEHOLDER,
    },
    {
        property: 'rangeEnd',
        placeholder: RANGE_END_PLACEHOLDER,
    },
]
function replacePlaceholders(originalText, originalOptions) {
    const indexes = indexProperties
        .map(({ property, placeholder }) => {
            const value = originalText.indexOf(placeholder)
            return value === -1 ? undefined : { property, value, placeholder }
        })
        .filter(Boolean)
        .sort((a, b) => a.value - b.value)

    const options = { ...originalOptions }
    let text = originalText
    let offset = 0
    for (const { property, value, placeholder } of indexes) {
        text = text.replace(placeholder, '')
        options[property] = value + offset
        offset -= placeholder.length
    }
    return { text, options }
}
describe('corpus test', () => {
    files.map(({ name, text }) => {
        const replaced = replacePlaceholders(text, base_acorn_opts)
        text = replaced.text
        const acorn_opts = replaced.options
        const ts_opts = { ...acorn_opts, ...base_ts_opts }

        if (should_throw.includes(name)) {
            test(`Should throw: ${name}`, async () => {
                await expect(
                    async () => await prettier.format(text, acorn_opts)
                ).rejects.toThrow()
                await expect(
                    async () => await prettier.format(text, ts_opts)
                ).rejects.toThrow()
            })
            return
        }

        test(`Reference should not throw: ${name}`, async () => {
            try {
                await prettier.format(text, acorn_opts)
            } catch (e) {
                expect(e).toBe(undefined)
            }
        })
        test(`AST match: ${name}`, async () => {
            const ts_ast = ts_parse(text)

            if (DEBUG) console.log(JSON.stringify(ts_ast, null, 4))
            let acorn_ast = acorn_parse(text)
            acorn_ast = pare_acorn_tree(acorn_ast)
            if (DEBUG) console.log('acorn_ast;')
            if (DEBUG) console.log(JSON.stringify(acorn_ast, null, 4))
            expect(ts_ast).toMatchObject(acorn_ast)
        })
        test(`Prettier match: ${name}`, async () => {
            let formatted_ts
            try {
                formatted_ts = await prettier.format(text, ts_opts)
            } catch (e) {
                expect(e).toBe(undefined)
            }
            const formatted_acorn = await prettier.format(text, acorn_opts)
            expect(formatted_ts).toBe(formatted_acorn)
        })
    })
})
