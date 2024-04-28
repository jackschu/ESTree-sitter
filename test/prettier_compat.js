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
export function replacePlaceholders(originalText, originalOptions) {
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
