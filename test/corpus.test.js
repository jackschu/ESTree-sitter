import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'
import * as prettier from 'prettier'

import { parsers } from '../src/index.js'
import { parse as acorn_parse } from './acorn_reference.js'

const test_dir = path.dirname(url.fileURLToPath(import.meta.url))
const corpus_dir = path.join(test_dir, 'corpus')

const files = fs
    .readdirSync(corpus_dir, { withFileTypes: true })
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

        const text = fs.readFileSync(filename, 'utf8')

        return [
            {
                name: basename,
                text,
            },
        ]
    })

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
                'custom-acorn': { parse: acorn_parse, astFormat: 'estree' },
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

describe('corpus test', () => {
    files.map(({ name, text }) => {
        test(`AST match: ${name}`, async () => {
            const ts_ast = ts_parse(text)
            const acorn_ast = acorn_parse(text)
            expect(ts_ast).toMatchObject(acorn_ast)
        })
        test(`Prettier match: ${name}`, async () => {
            const formatted_ts = await prettier.format('lodash ( )', ts_opts)
            const formatted_acorn = await prettier.format(
                'lodash ( )',
                acorn_opts
            )
            expect(formatted_ts).toBe(formatted_acorn)
        })
    })
})
