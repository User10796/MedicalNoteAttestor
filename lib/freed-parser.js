// Freed note parser (SPEC_freed_source_standalone §3–§8). Pure functions, no I/O.
// Input is the text of Freed's "Copy all" button: Subjective / Objective / Assessment & Plan.
const DIVIDERS = ['Subjective', 'Objective', 'Assessment & Plan'];

// §6: CRLF -> LF, strip a leading BOM, trim trailing whitespace on each line.
function normalize(raw) {
    return String(raw == null ? '' : raw)
        .replace(/^﻿/, '')
        .replace(/\r\n?/g, '\n')
        .split('\n').map(l => l.replace(/[ \t ]+$/, '')).join('\n');
}

// §3: checked in this order.
function classifyLine(line) {
    const t = String(line).trim();
    if (!t) return 'BLANK';
    if (DIVIDERS.includes(t)) return 'DIVIDER';
    if (/^\s*\d+\.\s+/.test(line)) return 'NUMBERED';
    if (/^\s*-\s+/.test(line)) return 'BULLET';
    if (t.endsWith(':')) return 'SUBHEADER';
    if (/^[^:\-\d][^:]*:\s+\S.*$/.test(t)) return 'INLINE_LABEL';
    return 'TEXT';
}

// §4 + §5. Returns { ok, sections: { subjective, objective, ap } } (arrays of lines).
function splitAndValidate(text) {
    const lines = text.split('\n');
    const at = {};
    for (let i = 0; i < lines.length; i++) {
        if (classifyLine(lines[i]) !== 'DIVIDER') continue;
        const d = lines[i].trim();
        if (at[d] !== undefined) return { ok: false };      // each divider exactly once
        at[d] = i;
    }
    const [s, o, a] = DIVIDERS.map(d => at[d]);
    if (s === undefined || o === undefined || a === undefined || !(s < o && o < a)) return { ok: false };
    const sections = {
        subjective: lines.slice(s + 1, o),
        objective: lines.slice(o + 1, a),
        ap: lines.slice(a + 1)
    };
    const hasHpi = sections.subjective.some(l => classifyLine(l) === 'SUBHEADER' && /^History of Present Illness/.test(l.trim()));
    const hasProblem = sections.ap.some(l => classifyLine(l) === 'NUMBERED');
    return { ok: hasHpi && hasProblem, sections };
}

// §8: format one slot. `drop` = subheaders (lowercased) removed for this slot (§7).
function formatSlot(lines, drop) {
    const out = [];
    for (const line of lines) {
        const cls = classifyLine(line);
        let emit;
        switch (cls) {
            case 'DIVIDER': continue;
            case 'BLANK': emit = ''; break;
            case 'SUBHEADER':
                if (drop.includes(line.trim().toLowerCase())) continue;
                emit = line.trim(); break;
            case 'BULLET': emit = '- ' + line.replace(/^\s*-\s+/, '').trim(); break;
            default: emit = line.trim();   // NUMBERED keeps "N. content"; INLINE_LABEL, TEXT
        }
        if (emit === '' && (out.length === 0 || out[out.length - 1] === '')) continue; // collapse blank runs
        out.push(emit);
    }
    while (out.length && out[out.length - 1] === '') out.pop();
    return out.join('\n');
}

// §7 F10 silent no-op: empty, or only N/A once the label is dropped and bullet markers stripped.
function isEmptyExam(exam) {
    const content = exam.split('\n').map(l => l.replace(/^-\s+/, '').trim()).filter(Boolean);
    return content.length === 0 || content.every(l => /^n\/a\.?$/i.test(l));
}

// Full parse. Returns { valid: false } or { valid: true, slots: { hpi, exam, ap } }.
// `text` must already be normalized (§2 order: normalize -> duplicate guard -> validate -> parse).
function parseFreed(text) {
    const v = splitAndValidate(text);
    if (!v.ok) return { valid: false };
    const hpi = formatSlot(v.sections.subjective, []);
    let exam = formatSlot(v.sections.objective, ['physical examination:']);
    if (isEmptyExam(exam)) exam = '';
    const ap = formatSlot(v.sections.ap, ['assessment and plan:']);
    return { valid: true, slots: { hpi, exam, ap } };
}

module.exports = { DIVIDERS, normalize, classifyLine, splitAndValidate, formatSlot, isEmptyExam, parseFreed };
