import { nodeUrlsToRecords, setNodeName } from '../../utils/node-transformer.js';
import { addFlagEmoji, removeFlagEmoji } from '../../utils/node-utils.js';

const MAX_PARAMETER_LENGTH = 1024;
const MAX_RULES = 16;
const MAX_NODE_NAME_LENGTH = 1024;

function parameter(params, key) {
    const value = params.get(key) || '';
    if (value.length > MAX_PARAMETER_LENGTH) {
        throw Object.assign(new Error(`Subscription parameter ${key} is too long`), {
            status: 400,
        });
    }
    return value;
}

function rules(value) {
    const result = value.split(/[|\r\n]/).filter(Boolean);
    if (result.length > MAX_RULES) {
        throw Object.assign(new Error('Too many subscription transformation rules'), {
            status: 400,
        });
    }
    return result;
}

export function parseRequestTransforms(params) {
    const rename = rules(parameter(params, 'rename'))
        .map((rule) => {
            const separator = rule.indexOf('@');
            return separator < 0
                ? [rule, '']
                : [rule.slice(0, separator), rule.slice(separator + 1)];
        })
        .filter(([from]) => from);
    const include = rules(parameter(params, 'include')).map((value) => value.toLowerCase());
    const exclude = rules(parameter(params, 'exclude')).map((value) => value.toLowerCase());
    const emoji = params.get('emoji');
    return rename.length ||
        include.length ||
        exclude.length ||
        emoji === 'true' ||
        emoji === 'false'
        ? { rename, include, exclude, emoji }
        : null;
}

// Request-controlled patterns are literal strings. Never compile them as regular expressions.
function replaceLiteral(value, from, replacement) {
    let result = '';
    let position = 0;
    while (position < value.length && result.length < MAX_NODE_NAME_LENGTH) {
        const next = value.indexOf(from, position);
        if (next < 0) return (result + value.slice(position)).slice(0, MAX_NODE_NAME_LENGTH);
        result += value.slice(position, next) + replacement;
        position = next + from.length;
    }
    return result.slice(0, MAX_NODE_NAME_LENGTH);
}

export function applyRequestTransforms(nodeList, transforms) {
    if (!transforms) return nodeList;
    const records = nodeUrlsToRecords(String(nodeList || '').split('\n'));
    const lines = records
        .filter((record) => {
            const name = record.name.toLowerCase();
            return (
                (!transforms.include.length ||
                    transforms.include.some((part) => name.includes(part))) &&
                !transforms.exclude.some((part) => name.includes(part))
            );
        })
        .map((record) => {
            let name = record.name.slice(0, MAX_NODE_NAME_LENGTH);
            for (const [from, replacement] of transforms.rename)
                name = replaceLiteral(name, from, replacement);
            let url =
                name === record.name ? record.url : setNodeName(record.url, record.protocol, name);
            if (transforms.emoji === 'false') url = removeFlagEmoji(url);
            if (transforms.emoji === 'true') url = addFlagEmoji(url);
            return url;
        });
    return lines.length ? lines.join('\n') + '\n' : '';
}
