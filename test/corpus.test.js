import { readFile } from 'node:fs/promises'
import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import * as prettier from 'prettier'

import { parsers } from '../src/index.js'
import { parse as acorn_parse } from './acorn_reference.js'
import { should_throw } from './throwers.js'

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

const ts_opts = {
    parser: 'tree-sitter',
    plugins: [{ parsers }],
}

const ts_parse = parsers['tree-sitter'].parse

const acorn_opts = {
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

describe('corpus test', () => {
    files.map(({ name, text }) => {
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

        test(`AST match: ${name}`, async () => {
            const ts_ast = ts_parse(text)

            const DEBUG = false
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
