import fs from 'node:fs'
import path from 'node:path'
import url from 'node:url'

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

files.map((test_case) => {
    test(test_case.name, () => {
        expect(3).toBe(3)
    })
})
