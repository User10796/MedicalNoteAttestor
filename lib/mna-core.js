// MNA core: criteria-library detection, resolution and composition.
//
// Pure functions, no Node or Electron APIs, no network. The same file runs in Electron's main
// process (require) and in the macOS app through JavaScriptCore (global `MNACore`), so both
// platforms detect and compose identically and share one test suite (test/*.test.js).
//
// Source-agnostic: everything here takes plain text (A&P, exam) and never assumes which scribe
// produced it (Heidi today; a second source can plug in by supplying the same strings).
(function (root) {
    'use strict';

    // ── Cerner sanitizer (same rules and vectors as pain-pa.com lib/text.js cernerSafe) ──────────
    var CHAR_MAP = [
        [/≥/g, '>='],                          // ≥
        [/≤/g, '<='],                          // ≤
        [/[“”„‟″]/g, '"'], // curly / low / prime double quotes
        [/[‘’‚‛′]/g, "'"], // curly / low / prime single quotes
        [/ /g, ' ']                            // non-breaking space
    ];

    function cernerSafe(text) {
        if (!text) return text;
        var out = String(text);
        for (var i = 0; i < CHAR_MAP.length; i++) out = out.replace(CHAR_MAP[i][0], CHAR_MAP[i][1]);
        // Em/en dash at line start (a bullet) -> "-- "; between words -> " -- ".
        out = out.replace(/^[ \t]*[—–][ \t]*/gm, '-- ');
        out = out.replace(/[ \t]*[—–][ \t]*/g, ' -- ');
        return out;
    }

    // ── helpers ───────────────────────────────────────────────────────────────────────────────
    function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
    function isWordChar(c) { return !!c && /[A-Za-z0-9]/.test(c); }
    function normLine(l) {
        return l.replace(/\s+/g, ' ').trim().replace(/[.;:,]+$/, '').toLowerCase();
    }

    // Find all word-boundary, case-insensitive occurrences of `phrase` (plural s/es allowed).
    // Whitespace or hyphens inside the phrase match any run of whitespace/hyphens.
    function findPhrase(text, phrase) {
        var parts = phrase.trim().split(/[\s-]+/).map(escapeRe);
        var re = new RegExp(parts.join('[\\s-]+') + '(?:e?s)?', 'gi');
        var hits = [], m;
        while ((m = re.exec(text)) !== null) {
            var s = m.index, e = s + m[0].length;
            if (!isWordChar(text[s - 1]) && !isWordChar(text[e])) hits.push({ start: s, end: e, text: m[0] });
            if (m[0].length === 0) re.lastIndex++;
        }
        return hits;
    }

    // ── planning language ─────────────────────────────────────────────────────────────────────
    // Primary signals (Sterling's phrasing): "proceed with", "schedule", "submit".
    // Secondary: "plan", "will proceed", "recommend", "order".
    var PLAN_PRIMARY = /\b(proceed(?:ing)?\s+with|schedul(?:e|ed|es|ing)|submit(?:s|ted|ting)?)\b/i;
    var PLAN_SECONDARY = /\b(plan(?:s|ned|ning)?|will\s+proceed|recommend(?:s|ed|ing)?|order(?:s|ed|ing)?)\b/i;
    // History / negation markers that apply to a mention when they sit between the previous
    // mention (or clause start) and this one. "prior auth(orization)" and "prior to" are not history.
    var HISTORY = /\b(s\/p|status\s+post|previous(?:ly)?|prior(?!\s+(?:auth|to\b))|history\s+of|hx\s+of|had|has\s+had|underwent|received|did\s+well\s+with|last|recent(?:ly)?|completed|after\s+(?:his|her|their|the)?\s*(?:last|prior))\b/i;
    var NEGATION = /\b(not\s+(?:a\s+)?candidate|declin(?:e|es|ed|ing)|defer(?:red|s)?|hold(?:ing)?\s+off|not\s+interested|no\s+longer|contraindicat\w*|avoid|against|do(?:es)?\s+not\s+(?:recommend|want|plan|order|think)|not\s+(?:pursu|proceed)\w*|not\s+(?:be\s+)?(?:recommended|ordered|indicated|planned|scheduled|appropriate|warranted|needed))\b/i;
    // Negation that follows the mention in the same clause ("ESI is not recommended", "RFA was not ordered").
    var NEGATION_AFTER = /^[^,;]*?\b(?:(?:is|was|are|were|be)\s+)?(not\s+(?:be\s+)?(?:recommended|ordered|indicated|planned|scheduled|appropriate|warranted|needed|a\s+candidate|covered)|declined|deferred|on\s+hold|contraindicated)\b/i;
    // A bare "no" / "not" immediately before the mention ("No ESI for now", "MBB, not RFA").
    var NEGATION_LEAD = /\b(?:no|not)\s*$/i;
    var YEAR_AFTER = /^\s*(?:\(|in\s+|on\s+)?(?:\d{1,2}\/)?(?:19|20)\d{2}\b/i;

    // Segments: lines (bullets), then sentences/clauses ending in . ; ! ?
    function segments(text) {
        var out = [];
        var lines = String(text || '').split(/\r?\n/);
        var offset = 0;
        for (var li = 0; li < lines.length; li++) {
            var line = lines[li];
            var re = /[^.;!?]+(?:[.;!?]+|$)/g, m;
            while ((m = re.exec(line)) !== null) {
                if (!m[0].trim()) { if (m[0].length === 0) re.lastIndex++; continue; }
                // Don't split on decimal points / abbreviations followed by a digit or lowercase (e.g. "1.5", "Dr. x").
                out.push({ text: m[0], start: offset + m.index, line: li });
                if (m[0].length === 0) re.lastIndex++;
            }
            offset += line.length + 1;
        }
        // Merge fragments produced by "5.5" or "approx. 3" (segment ending in '.' followed by a digit/lowercase).
        var merged = [];
        for (var i = 0; i < out.length; i++) {
            var prev = merged[merged.length - 1];
            if (prev && prev.line === out[i].line && /[.]\s*$/.test(prev.text) &&
                (/\d\.$/.test(prev.text.trim()) || /\b(?:vs|approx|dr|e\.g|i\.e)\.$/i.test(prev.text.trim())) &&
                /^\s*[0-9a-z]/.test(out[i].text)) {
                prev.text += out[i].text;
            } else merged.push({ text: out[i].text, start: out[i].start, line: out[i].line });
        }
        return merged;
    }

    // ── region & laterality ───────────────────────────────────────────────────────────────────
    var LEVEL_RE = /\b([CTLS])(\d{1,2})\s*-\s*([CTLS])?(\d{1,2})\b/g;
    function regionOfLevel(m) {
        var a = m[1].toUpperCase(), b = (m[3] || a).toUpperCase();
        if (a === 'C') return 'cervical';                     // C5-6, C7-T1
        if (a === 'T') return b === 'L' && m[2] === '12' ? 'thoracic' : 'thoracic'; // T12-L1 treated thoracic
        if (a === 'L') return 'lumbar';                       // L4-5, L5-S1
        return 'sacral';
    }
    function regionsIn(text) {
        var out = [], m;
        LEVEL_RE.lastIndex = 0;
        while ((m = LEVEL_RE.exec(text)) !== null) out.push({ region: regionOfLevel(m), term: m[0], index: m.index });
        var words = [['cervical', 'cervical'], ['neck', 'cervical'], ['thoracic', 'thoracic'], ['lumbar', 'lumbar'],
            ['lumbosacral', 'lumbar'], ['low back', 'lumbar'], ['sacral', 'sacral'], ['caudal', 'lumbar']];
        for (var i = 0; i < words.length; i++) {
            var hits = findPhrase(text, words[i][0]);
            for (var j = 0; j < hits.length; j++) out.push({ region: words[i][1], term: hits[j].text, index: hits[j].start });
        }
        return out;
    }

    // Laterality from a text window. Returns 'bilateral' | 'right' | 'left' | null.
    // "R " / "L " (capital, standalone) count; "L4-5" / "L5-S1" do not.
    function lateralityIn(text, preferEnd) {
        var found = [];
        var res = [
            [/\b(bilateral(?:ly)?|b\/l|bilat)\b/gi, 'bilateral'],
            [/\b(right|rt)\b/gi, 'right'],
            [/\b(left|lt)\b/gi, 'left'],
            [/(?:^|[\s(])R(?=\s|\)|$)/g, 'right'],
            [/(?:^|[\s(])L(?=\s|\)|$)/g, 'left']
        ];
        for (var i = 0; i < res.length; i++) {
            var m, re = res[i][0];
            re.lastIndex = 0;
            while ((m = re.exec(text)) !== null) { found.push({ lat: res[i][1], index: m.index }); if (!m[0].length) re.lastIndex++; }
        }
        if (!found.length) return null;
        found.sort(function (a, b) { return a.index - b.index; });
        return (preferEnd ? found[found.length - 1] : found[0]).lat;
    }

    // ── alias index ───────────────────────────────────────────────────────────────────────────
    function procedureList(bundle) {
        var reg = bundle && bundle.registries && bundle.registries.procedures;
        return reg && reg.length ? reg : ((bundle && bundle.procedures) || []);
    }
    function buildAliasIndex(procs) {
        var idx = {};
        for (var i = 0; i < procs.length; i++) {
            var al = procs[i].aliases || [];
            for (var j = 0; j < al.length; j++) {
                var k = al[j].toLowerCase();
                (idx[k] = idx[k] || { alias: al[j], ids: [] }).ids.push(procs[i].procedure_id);
            }
        }
        return idx;
    }

    function pickCandidate(ids, procById, regionHits, lat) {
        var cands = ids.slice();
        if (cands.length > 1 && regionHits.length) {
            var byRegion = cands.filter(function (id) {
                var p = procById[id];
                var terms = (p.region_terms || []).map(function (t) { return t.toLowerCase(); });
                return regionHits.some(function (r) {
                    return p.region === r.region || terms.indexOf(r.term.toLowerCase()) !== -1;
                });
            });
            // Prefer a candidate whose own region matches the first region hit.
            var exact = byRegion.filter(function (id) { return procById[id].region === regionHits[0].region; });
            if (exact.length) cands = exact; else if (byRegion.length) cands = byRegion;
        }
        if (cands.length > 1) {
            // Generic "ESI": sided -> transforaminal, unsided -> interlaminar.
            var tf = cands.filter(function (id) { return /tfesi$/.test(id); });
            var il = cands.filter(function (id) { return /ilesi$/.test(id); });
            if (tf.length && il.length) cands = (lat === 'right' || lat === 'left') ? tf : il;
        }
        if (cands.length > 1) {
            // No region given: default to lumbar (most common in this practice).
            var lum = cands.filter(function (id) { return procById[id].region === 'lumbar'; });
            if (lum.length) cands = lum;
        }
        return { id: cands[0], regionInferred: !regionHits.length };
    }

    function fitLaterality(proc, lat) {
        var opts = proc.laterality_options || ['bilateral'];
        if (lat && opts.indexOf(lat) !== -1) return lat;
        if (opts.indexOf('bilateral') !== -1) return 'bilateral';
        if (opts.indexOf('midline') !== -1) return 'midline';
        return opts[0];
    }

    // ── detection ─────────────────────────────────────────────────────────────────────────────
    // Returns { items: [{procedure_id, name, laterality, lateralityExplicit, region, regionInferred,
    //   planned, checked, variant, needsVariant, mention, line}], noneDetected }
    // planned=true rows are pre-checked; mentioned-but-unplanned rows are unchecked suggestions;
    // history/negated mentions ("s/p RFA 2024", "previously had ESI") are dropped.
    function detectProcedures(apText, bundle) {
        var procs = procedureList(bundle);
        var procById = {};
        for (var i = 0; i < procs.length; i++) procById[procs[i].procedure_id] = procs[i];
        var idx = buildAliasIndex(procs);
        var aliasKeys = Object.keys(idx);
        var byId = {}, order = [];

        var segs = segments(apText);
        for (var si = 0; si < segs.length; si++) {
            var seg = segs[si].text;
            // All alias hits in this segment; longest match wins on overlap.
            var hits = [];
            for (var a = 0; a < aliasKeys.length; a++) {
                var h = findPhrase(seg, idx[aliasKeys[a]].alias);
                for (var hi = 0; hi < h.length; hi++) { h[hi].key = aliasKeys[a]; hits.push(h[hi]); }
            }
            hits.sort(function (x, y) { return x.start - y.start || (y.end - y.start) - (x.end - x.start); });
            var kept = [];
            for (var k = 0; k < hits.length; k++) {
                var last = kept[kept.length - 1];
                if (last && hits[k].start < last.end) continue;
                kept.push(hits[k]);
            }
            // Adjacent hits that resolve to the same procedure family ("TFESI (transforaminal ESI)") are one mention.
            var planInSeg = PLAN_PRIMARY.test(seg) || PLAN_SECONDARY.test(seg);
            for (var q = 0; q < kept.length; q++) {
                var hit = kept[q];
                var prevEnd = q > 0 ? kept[q - 1].end : 0;
                var nextStart = q + 1 < kept.length ? kept[q + 1].start : seg.length;
                var before = seg.slice(prevEnd, hit.start);
                var after = seg.slice(hit.end, nextStart);
                var nearAfter = after.slice(0, 40);
                // History / negation applies only to the clause leading into this mention.
                var lead = before.split(/,|\band\b|\bthen\b|\bbut\b/i).pop();
                var isHistory = HISTORY.test(lead) || YEAR_AFTER.test(after);
                var isNegated = NEGATION.test(before) || NEGATION_LEAD.test(before) || NEGATION_AFTER.test(after);
                if (isHistory || isNegated) continue;
                var lat = lateralityIn(before, true) || lateralityIn(nearAfter, false);
                var regionHits = regionsIn(before + ' ' + after);
                var pick = pickCandidate(idx[hit.key].ids, procById, regionHits, lat);
                var proc = procById[pick.id];
                if (!proc) continue;
                var planned = planInSeg;
                var latFit = fitLaterality(proc, lat);
                var existing = byId[proc.procedure_id];
                if (existing) {
                    existing.planned = existing.planned || planned;
                    existing.checked = existing.planned;
                    if (lat && existing.lateralityExplicit && existing.laterality !== latFit &&
                        (proc.laterality_options || []).indexOf('bilateral') !== -1) existing.laterality = 'bilateral';
                    else if (lat && !existing.lateralityExplicit) { existing.laterality = latFit; existing.lateralityExplicit = true; }
                    continue;
                }
                var row = {
                    procedure_id: proc.procedure_id,
                    name: proc.name,
                    laterality: latFit,
                    lateralityExplicit: !!lat,
                    region: regionHits.length ? regionHits[0].region : proc.region,
                    regionInferred: pick.regionInferred,
                    planned: planned,
                    checked: planned,
                    variant: null,
                    needsVariant: !!(proc.variants && proc.variants.length),
                    mention: hit.text,
                    line: segs[si].line
                };
                byId[proc.procedure_id] = row;
                order.push(proc.procedure_id);
            }
        }
        var items = order.map(function (id) { return byId[id]; });
        // Planned rows first (in note order), then suggestions.
        items.sort(function (x, y) { return (y.planned ? 1 : 0) - (x.planned ? 1 : 0); });
        return { items: items, noneDetected: items.length === 0 };
    }

    // ── resolution ────────────────────────────────────────────────────────────────────────────
    function payerName(bundle, payerId) {
        var ps = (bundle && bundle.registries && bundle.registries.payers) || (bundle && bundle.payers) || [];
        for (var i = 0; i < ps.length; i++) if (ps[i].payer_id === payerId) return ps[i].name;
        return payerId;
    }
    function procName(bundle, procId) {
        var ps = procedureList(bundle);
        for (var i = 0; i < ps.length; i++) if (ps[i].procedure_id === procId) return ps[i].name;
        return procId;
    }

    // items: rows with checked=true are resolved. Returns per-item results:
    // { procedure_id, insert: bool, examText, dotphrase, marker: null|'amber'|'red', notice }
    function resolveSelections(bundle, payerId, items) {
        var entries = {};
        var list = (bundle && bundle.entries) || [];
        for (var i = 0; i < list.length; i++) entries[list[i].payer_id + '/' + list[i].procedure_id] = list[i];
        var out = [];
        for (var j = 0; j < items.length; j++) {
            var it = items[j];
            if (!it.checked) continue;
            var label = payerName(bundle, payerId) + ' — ' + procName(bundle, it.procedure_id);
            var none = { procedure_id: it.procedure_id, insert: false, examText: '', dotphrase: '', marker: null,
                         notice: 'No library criteria for ' + label };
            var e = entries[payerId + '/' + it.procedure_id];
            var status = e && e.meta && e.meta.status;
            if (!e || e.routing_only || status === 'draft') { out.push(none); continue; }
            var examText = '', dot = e.documentation_dotphrase || '';
            if (e.variants && Object.keys(e.variants).length) {
                if (!it.variant) {
                    out.push({ procedure_id: it.procedure_id, insert: false, examText: '', dotphrase: '', marker: null,
                               notice: 'Choose an SCS indication to insert criteria for ' + label });
                    continue;
                }
                var v = e.variants[it.variant];
                if (!v) { none.notice = 'No library criteria for ' + label + ' (' + it.variant + ')'; out.push(none); continue; }
                if (v.coverage === 'not_covered') {
                    out.push({ procedure_id: it.procedure_id, insert: false, examText: '', dotphrase: '', marker: 'red',
                               notice: label + ' (' + it.variant + '): not covered by this payer' });
                    continue;
                }
                var byLat = (e.exam_text_by_variant || {})[it.variant] || e.exam_text || {};
                examText = pickLat(byLat, it.laterality);
                if (v.documentation_dotphrase) dot = v.documentation_dotphrase;
            } else {
                examText = pickLat(e.exam_text || {}, it.laterality);
            }
            var marker = status === 'stale' ? 'red' : (status === 'needs_review' ? 'amber' : null);
            out.push({
                procedure_id: it.procedure_id, insert: true,
                examText: cernerSafe(examText || ''), dotphrase: cernerSafe(dot || ''),
                marker: marker,
                notice: marker === 'red' ? label + ': criteria are stale (past re-verify date)'
                      : marker === 'amber' ? label + ': criteria need review' : null
            });
        }
        return out;
    }
    // Exam text for the chosen side. Never falls back to the other side (a left procedure must
    // not get "on the right" text); bilateral <-> midline are equivalent (no side).
    function pickLat(byLat, lat) {
        if (byLat[lat] != null) return byLat[lat];
        if (lat === 'bilateral' && byLat.midline != null) return byLat.midline;
        if (lat === 'midline' && byLat.bilateral != null) return byLat.bilateral;
        return '';
    }

    // ── composition ───────────────────────────────────────────────────────────────────────────
    // Exam (F10): scribe exam + blank line + library exam text (all procedures), deduplicated
    // line-by-line against the scribe exam and each other; library order preserved; ___ kept.
    // Empty scribe exam + library text -> library text alone. Both empty -> '' (caller no-ops).
    function composeExam(scribeExam, libraryTexts) {
        var scribe = scribeExam && String(scribeExam).trim() ? String(scribeExam) : '';
        var seen = {};
        scribe.split(/\r?\n/).forEach(function (l) { var n = normLine(l); if (n) seen[n] = true; });
        var outLines = [];
        (libraryTexts || []).forEach(function (t) {
            if (!t || !String(t).trim()) return;
            if (outLines.length) outLines.push('');
            cernerSafe(String(t)).split(/\r?\n/).forEach(function (l) {
                var n = normLine(l);
                if (!n) { outLines.push(''); return; }
                if (seen[n]) return;
                seen[n] = true;
                outLines.push(l);
            });
        });
        var lib = tidy(dropOrphanHeaders(outLines)).join('\n');
        if (!lib) return scribe;
        if (!scribe) return lib;
        return scribe.replace(/\s+$/, '') + '\n\n' + lib;
    }
    // A header line ("Range of motion:") whose content lines were all deduped away is dropped.
    function dropOrphanHeaders(lines) {
        var out = [];
        for (var i = 0; i < lines.length; i++) {
            var l = lines[i];
            if (/:\s*$/.test(l) && l.trim().length < 60) {
                var j = i + 1;
                while (j < lines.length && !lines[j].trim()) j++;
                if (j >= lines.length || /:\s*$/.test(lines[j])) continue;
            }
            out.push(l);
        }
        return out;
    }
    function tidy(lines) {
        var out = [];
        for (var i = 0; i < lines.length; i++) {
            if (!lines[i].trim() && (!out.length || !out[out.length - 1].trim())) continue;
            out.push(lines[i]);
        }
        while (out.length && !out[out.length - 1].trim()) out.pop();
        return out;
    }

    // A&P (F11): A&P + blank line + each dot-phrase in procedure order. No header.
    // opts.insertion: 'end' (default) | 'after_plan_line' (after the line holding the first
    // planned procedure mention, given as opts.planLine = line index into apText).
    function composeAP(apText, dotphrases, opts) {
        var ap = apText ? String(apText) : '';
        var dots = (dotphrases || []).filter(function (d) { return d && String(d).trim(); })
            .map(function (d) { return cernerSafe(String(d)).replace(/\s+$/, ''); });
        if (!dots.length) return ap;
        var block = dots.join('\n\n');
        if (!ap.trim()) return block;
        if (opts && opts.insertion === 'after_plan_line' && typeof opts.planLine === 'number') {
            var lines = ap.split(/\r?\n/);
            if (opts.planLine >= 0 && opts.planLine < lines.length - 1) {
                var head = lines.slice(0, opts.planLine + 1).join('\n');
                var tail = lines.slice(opts.planLine + 1).join('\n').replace(/^\s*\n/, '');
                return head + '\n\n' + block + '\n\n' + tail;
            }
        }
        return ap.replace(/\s+$/, '') + '\n\n' + block;
    }

    // One call that turns confirmed selections into the two paste outputs.
    // Returns { exam, ap, results, notices, inserted } — exam/ap are null when nothing changes,
    // so callers fall back to today's exact paste.
    function composeOutputs(bundle, payerId, items, scribeExam, apText, opts) {
        return composeFromResults(resolveSelections(bundle, payerId, items), items, scribeExam, apText, opts);
    }

    // Same as composeOutputs, from already-resolved results (e.g. after a verified Claude fill).
    function composeFromResults(results, items, scribeExam, apText, opts) {
        var ins = results.filter(function (r) { return r.insert; });
        var exams = ins.map(function (r) { return r.examText; }).filter(Boolean);
        var dots = ins.map(function (r) { return r.dotphrase; }).filter(Boolean);
        var planLine = null;
        for (var i = 0; i < items.length; i++) if (items[i].checked && typeof items[i].line === 'number') { planLine = items[i].line; break; }
        var exam = exams.length ? composeExam(scribeExam, exams) : null;
        var ap = dots.length ? composeAP(apText, dots, { insertion: (opts && opts.insertion) || 'end', planLine: planLine }) : null;
        return {
            exam: exam, ap: ap, results: results, inserted: ins.length,
            notices: results.filter(function (r) { return r.notice; }).map(function (r) { return { text: r.notice, marker: r.marker }; })
        };
    }

    // ── Claude fill of library blanks (SPEC_library_claude_fill) ───────────────────────────────
    // Claude EXTRACTS values with source quotes; the app VERIFIES them and does all substitution.
    // Opt-in (off by default) and only with a user-entered key; each platform makes the API call.
    var FILL_TOOL = 'record_blank_values';
    var BLANK_RE = /_{3,}/g;

    // A parenthetical right after a blank: an option list ("(MRI/CT)") if it has '/' between short
    // options and no comma/semicolon/colon; otherwise a criteria hint. A parenthetical that itself
    // contains a blank ("(MRI/CT date ___)", "(scale: ___)") is neither: it is always kept, and its
    // own blanks are numbered normally (the spec is silent; dropping it would delete those blanks).
    function classifyParen(inner) {
        if (/_{3,}/.test(inner)) return { type: 'contains_blank' };
        var parts = inner.split('/').map(function (x) { return x.trim(); });
        var isOptions = parts.length >= 2 && !/[,;:]/.test(inner) && parts.every(function (p) {
            return p.length > 0 && p.length <= 30 && p.split(/\s+/).length <= 4;
        });
        return isOptions ? { type: 'options', options: parts } : { type: 'hint', hint: inner.trim() };
    }

    // templates: [{ slot: 'exam'|'ap', key: string, text: string }]
    // Returns { lines: [{line_id, template, text}], blanks: [{blank_id, line_id, template, start, end,
    //           paren: {start, end, type, options?, hint?} | null}] } (offsets are within the template text).
    function fillPlan(templates) {
        var lines = [], blanks = [], lineId = 0, blankId = 0;
        (templates || []).forEach(function (t, ti) {
            var text = String(t.text || ''), offset = 0;
            text.split('\n').forEach(function (line) {
                lineId++;
                lines.push({ line_id: lineId, template: ti, text: line });
                var m, re = new RegExp(BLANK_RE.source, 'g');
                while ((m = re.exec(line)) !== null) {
                    blankId++;
                    var after = line.slice(m.index + m[0].length);
                    var pm = /^\s*\(([^()]*)\)/.exec(after), paren = null;
                    if (pm) {
                        var c = classifyParen(pm[1]);
                        paren = { start: offset + m.index + m[0].length, end: offset + m.index + m[0].length + pm[0].length,
                                  type: c.type, options: c.options || null, hint: c.hint || null };
                    }
                    blanks.push({ blank_id: blankId, line_id: lineId, template: ti,
                                  start: offset + m.index, end: offset + m.index + m[0].length, paren: paren });
                }
                offset += line.length + 1;
            });
        });
        return { lines: lines, blanks: blanks };
    }

    var FILL_SYSTEM_PROMPT = [
        'You help fill blanks ("___") in prior-authorization template lines from a clinical note (HPI, Exam, A&P).',
        'You do not write note text. You return values through the record_blank_values tool; the app checks them and inserts them.',
        'Fill each blank the way a reasonable clinician would after reading the note:',
        '1. Use what the note states, including synonyms, abbreviations and paraphrase (PT = physical therapy, HEP = home exercise program, "shots" = injections, MR = MRI), and reasonable clinical inference.',
        '2. Every value needs a source_quote: text copied exactly from the note section named in source_section (HPI, Exam or A&P) that supports it.',
        '3. kind: "explicit" if the quote states the value directly; "inferred" if it is a reasonable conclusion from the quote; "derived" if it is a number computed from the quote (for example "two months" -> 8 weeks).',
        '4. null is correct when a reasonable person could not tell from the note. Do not guess.',
        '5. If a blank has an option list, value must be one of the options (map synonyms to the option, for example "MR" -> "MRI").',
        '6. Never invent: dates must come from the quote; percentages and counts must be stated in the quote as digits or words (a count of 0 when the quote clearly says none); durations need a duration in the quote (unit conversion is fine, kind "derived"); provider and facility names must appear in the quote.',
        '7. Do not judge whether criteria are met inside value. Put any concern (for example a requirement in a hint that the note does not meet) in criteria_flags, referencing the template line_id.',
        '8. Return one entry per blank_id you were given (value null when the note does not say).'
    ].join('\n');

    var FILL_INPUT_SCHEMA = {
        type: 'object',
        properties: {
            values: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        blank_id: { type: 'integer' },
                        value: { type: ['string', 'null'] },
                        kind: { type: 'string', enum: ['explicit', 'inferred', 'derived'] },
                        source_quote: { type: 'string' },
                        source_section: { type: 'string', enum: ['HPI', 'Exam', 'A&P'] }
                    },
                    required: ['blank_id', 'value', 'kind', 'source_quote', 'source_section']
                }
            },
            criteria_flags: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: { line_id: { type: 'integer' }, message: { type: 'string' } },
                    required: ['line_id', 'message']
                }
            }
        },
        required: ['values']
    };

    // A full template (30+ blanks, each with a quote) takes Claude well over 20 s to answer, so the
    // request gets 60 s and room for the whole reply (2026-10-12; was 20 s / 2048 tokens).
    var FILL_TIMEOUT_MS = 60000;
    var FILL_MAX_TOKENS = 4096;

    // Visible notice text for every way the fill can't run or fails (same text on both platforms).
    // Never includes note text, values or the key.
    function fillNotice(reason, detail) {
        var tail = ' \u2014 blanks left as-is.';
        switch (reason) {
            case 'no-key': return 'Claude fill: no API key saved' + tail + ' Add your key in Settings.';
            case 'key-unreadable': return 'Claude fill: your saved API key couldn\u2019t be read' + tail + ' Re-enter it in Settings.';
            case 'timeout': return 'Claude fill timed out after ' + Math.round(FILL_TIMEOUT_MS / 1000) + ' s' + tail;
            case 'http':
                var code = Number(detail) || 0;
                return 'Claude fill failed (HTTP ' + code + (code === 401 || code === 403 ? ': check your API key' :
                    code === 429 ? ': rate limited' : code >= 500 ? ': Anthropic service error' : '') + ')' + tail;
            case 'network': return 'Claude fill failed (network error)' + tail;
            case 'malformed': return 'Claude fill failed (unexpected reply)' + tail;
            case 'request': return 'Claude fill failed (couldn\u2019t build the request)' + tail;
            case 'no-blanks': return 'Claude fill: no blanks in the inserted library text.';
            default: return 'Claude fill unavailable' + tail;
        }
    }

    // §0.5: only the captured HPI, exam and A&P plus the inserted template text.
    function fillRequest(note, templates, model) {
        var plan = fillPlan(templates);
        var blankLines = plan.blanks.map(function (b) {
            var line = plan.lines[b.line_id - 1].text;
            var s = '- blank_id ' + b.blank_id + ' (line_id ' + b.line_id + '): ' + JSON.stringify(line);
            if (b.paren && b.paren.type === 'options') s += ' | options: ' + JSON.stringify(b.paren.options);
            if (b.paren && b.paren.type === 'hint') s += ' | criteria hint: ' + JSON.stringify(b.paren.hint);
            return s;
        });
        var user = [
            '<note>',
            '<HPI>\n' + String((note && note.hpi) || '') + '\n</HPI>',
            '<Exam>\n' + String((note && note.exam) || '') + '\n</Exam>',
            '<A&P>\n' + String((note && note.ap) || '') + '\n</A&P>',
            '</note>',
            '',
            'Template lines (line_id: text):',
            plan.lines.map(function (l) { return l.line_id + ': ' + l.text; }).join('\n'),
            '',
            'Blanks to fill (the blank is the ___ in the quoted line; blanks are numbered left to right):',
            blankLines.join('\n')
        ].join('\n');
        return {
            plan: plan,
            body: {
                model: model,
                max_tokens: FILL_MAX_TOKENS,
                system: FILL_SYSTEM_PROMPT,
                tools: [{ name: FILL_TOOL, description: 'Record the value (or null) for each blank, with an exact source quote.', input_schema: FILL_INPUT_SCHEMA }],
                tool_choice: { type: 'tool', name: FILL_TOOL },
                messages: [{ role: 'user', content: user }]
            }
        };
    }

    // Messages API response -> { values, flags } or null if malformed.
    function fillParse(response) {
        try {
            var r = typeof response === 'string' ? JSON.parse(response) : response;
            var block = (r && r.content || []).filter(function (b) { return b && b.type === 'tool_use' && b.name === FILL_TOOL; })[0];
            if (!block || !block.input || !Array.isArray(block.input.values)) return null;
            var values = block.input.values;
            for (var i = 0; i < values.length; i++) {
                var v = values[i];
                if (!v || typeof v.blank_id !== 'number' || (v.value !== null && typeof v.value !== 'string')) return null;
            }
            var flags = Array.isArray(block.input.criteria_flags) ? block.input.criteria_flags.filter(function (f) {
                return f && typeof f.line_id === 'number' && typeof f.message === 'string';
            }) : [];
            return { values: values, flags: flags };
        } catch (e) { return null; }
    }

    function fillNorm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9%]+/g, ' ').trim(); }

    // ── value checks (anti-fabrication) ──
    var NUMBER_WORDS = { zero: 0, none: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
        ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
        nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
        hundred: 100, a: 1, an: 1, single: 1, once: 1, twice: 2, couple: 2 };
    // Fractions people use for relief ("about half the pain gone" = 50%).
    var FRACTION_PERCENTS = { half: 50, 'a third': 33, 'one third': 33, 'two thirds': 67, 'a quarter': 25, 'one quarter': 25, 'three quarters': 75 };
    var MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
    var UNIT_DAYS = { hour: 1 / 24, day: 1, week: 7, month: 30.44, year: 365.25 };
    function unitOf(w) {
        w = String(w || '').toLowerCase();
        if (/^(h|hr|hrs|hour|hours)$/.test(w)) return 'hour';
        if (/^(d|day|days)$/.test(w)) return 'day';
        if (/^(w|wk|wks|week|weeks)$/.test(w)) return 'week';
        if (/^(mo|mos|month|months)$/.test(w)) return 'month';
        if (/^(y|yr|yrs|year|years)$/.test(w)) return 'year';
        return null;
    }
    // Numbers stated in text, as digits or words (incl. "twenty-five").
    function numbersIn(text) {
        var out = [], t = String(text || '').toLowerCase();
        (t.match(/\d+(?:\.\d+)?/g) || []).forEach(function (n) { out.push(Number(n)); });
        var words = t.split(/[^a-z]+/);
        for (var i = 0; i < words.length; i++) {
            var w = words[i];
            if (NUMBER_WORDS[w] !== undefined && !(w === 'a' || w === 'an' || w === 'couple')) {
                var n = NUMBER_WORDS[w];
                if (n >= 20 && n < 100 && NUMBER_WORDS[words[i + 1]] !== undefined && NUMBER_WORDS[words[i + 1]] < 10) n += NUMBER_WORDS[words[i + 1]];
                out.push(n);
            }
        }
        return out;
    }
    // Durations stated in text: [{n, unit}] ("two months", "6 wks", "a month", "a couple of weeks").
    function durationsIn(text) {
        var out = [], re = /(\d+(?:\.\d+)?|[a-z]+)(?:[\s-]+of)?[\s-]+(hours?|hrs?|days?|weeks?|wks?|months?|mos?|years?|yrs?)\b/gi, m;
        var t = String(text || '');
        while ((m = re.exec(t)) !== null) {
            var raw = m[1].toLowerCase(), n = /^\d/.test(raw) ? Number(raw) : NUMBER_WORDS[raw];
            if (n === undefined) continue;
            out.push({ n: n, unit: unitOf(m[2]) });
        }
        return out;
    }
    // Dates stated in text, normalized to {y, m, d?}. Handles 2026-08-14, 08/14/2026, 08/2026, Aug 2026, August 14, 2026.
    function datesIn(text) {
        var out = [], t = String(text || ''), m, re;
        re = /\b(\d{4})-(\d{1,2})(?:-(\d{1,2}))?\b/g;
        while ((m = re.exec(t)) !== null) out.push({ y: +m[1], m: +m[2], d: m[3] ? +m[3] : null });
        re = /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/g;
        while ((m = re.exec(t)) !== null) out.push({ y: m[3].length === 2 ? 2000 + +m[3] : +m[3], m: +m[1], d: +m[2] });
        re = /\b(\d{1,2})\/(\d{4})\b/g;
        while ((m = re.exec(t)) !== null) out.push({ y: +m[2], m: +m[1], d: null });
        re = /\b(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\.?\s+(?:(\d{1,2})(?:st|nd|rd|th)?,?\s+)?(\d{4})\b/gi;
        while ((m = re.exec(t)) !== null) out.push({ y: +m[3], m: MONTHS[m[1].toLowerCase().slice(0, m[1].toLowerCase() === 'sept' ? 4 : 3)] || MONTHS[m[1].toLowerCase().slice(0, 3)], d: m[2] ? +m[2] : null });
        return out;
    }
    function looksLikeDate(value) { return datesIn(value).length > 0 || /\b(19|20)\d{2}\b/.test(value); }
    function dateSupported(value, quote) {
        var vs = datesIn(value), qs = datesIn(quote);
        if (!vs.length) return false;
        return vs.every(function (v) {
            return qs.some(function (q) { return q.y === v.y && q.m === v.m && (v.d === null || q.d === null || q.d === v.d); });
        });
    }
    var NEGATION_NONE = /\b(no|none|denies|denied|never|without|zero|has not had|hasn't had|not had)\b/i;
    var NAME_CONTEXT = /\b(provider|physician|surgeon|radiologist|doctor|dr|md|do|np|pa|therapist|facility|hospital|clinic|center|centre|practice|imaging center|credential)\b/i;
    var NAME_VALUE = /^(dr|doctor)\.?\s|\b(hospital|clinic|center|centre|imaging|radiology|medical|health|associates|group)\b/i;
    var FILL_SIDE_RE = /^(right|left|bilateral)$/i;
    var FILL_LEVEL_TOKEN = /^[ctls]\d{1,2}$/i;

    // Option lists: exact (case-insensitive) or a known synonym/abbreviation of the option.
    var OPTION_SYNONYMS = {
        'mri': ['mr', 'magnetic resonance', 'magnetic resonance imaging', 'mri scan'],
        'ct': ['cat', 'cat scan', 'computed tomography', 'ct scan'],
        'x-ray': ['xr', 'xray', 'radiograph', 'radiographs', 'plain film', 'plain films'],
        'physical therapy': ['pt', 'physio', 'physiotherapy'],
        'home exercise program': ['hep', 'home exercises', 'home exercise'],
        'right': ['r', 'rt'], 'left': ['l', 'lt'], 'bilateral': ['b/l', 'bilat', 'both', 'both sides']
    };
    function matchOption(value, options) {
        var v = fillNorm(value);
        for (var i = 0; i < options.length; i++) {
            var o = fillNorm(options[i]);
            if (o === v) return options[i];
            var syn = OPTION_SYNONYMS[options[i].toLowerCase()] || OPTION_SYNONYMS[o] || [];
            if (syn.map(fillNorm).indexOf(v) !== -1) return options[i];
        }
        return null;
    }

    // §3 (revised 2026-10-12): read the note like a reasonable clinician, but never fabricate.
    // Returns { accepted: {blank_id: {value, kind, quote, section, conversion?}}, rejections: [{blank_id, reason}], flags }.
    function fillValidate(parsed, plan, note) {
        var sections = { 'HPI': fillNorm(note && note.hpi), 'Exam': fillNorm(note && note.exam), 'A&P': fillNorm(note && note.ap) };
        var byId = {}; plan.blanks.forEach(function (b) { byId[b.blank_id] = b; });
        var accepted = {}, rejections = [];
        (parsed.values || []).forEach(function (v) {
            var b = byId[v.blank_id];
            if (!b || accepted[v.blank_id] || v.value === null || v.value === undefined || !String(v.value).trim()) return;
            var value = String(v.value).trim(), quote = String(v.source_quote || ''), kind = v.kind;
            var reject = function (why) { rejections.push({ blank_id: v.blank_id, reason: why }); };
            if (['explicit', 'inferred', 'derived'].indexOf(kind) === -1) return reject('unknown kind');
            var sec = sections[v.source_section], q = fillNorm(quote);
            if (sec === undefined) return reject('unknown section');
            if (!q || sec.indexOf(q) === -1) return reject('quote not in note section');

            var line = plan.lines[b.line_id - 1].text;
            var lineOffset = 0;
            for (var li = 0; li < b.line_id - 1; li++) if (plan.lines[li].template === b.template) lineOffset += plan.lines[li].text.length + 1;
            var after = line.slice(b.end - lineOffset);
            var conversion = null;

            if (b.paren && b.paren.type === 'options') {
                var opt = matchOption(value, b.paren.options);
                if (!opt) return reject('value not in option list');
                value = opt;
            } else if (looksLikeDate(value)) {
                if (!dateSupported(value, quote)) return reject('date not supported by quote');
            } else if (/%/.test(value) || /^\s*%/.test(after)) {
                var pct = Number((value.match(/\d+(?:\.\d+)?/) || [])[0]);
                var qn = numbersIn(quote).concat(Object.keys(FRACTION_PERCENTS).filter(function (f) {
                    return new RegExp('\\b' + f + '\\b', 'i').test(quote);
                }).map(function (f) { return FRACTION_PERCENTS[f]; }));
                if (isNaN(pct) || qn.indexOf(pct) === -1) return reject('percentage not in quote');
            } else {
                var unitMatch = /^\s*(hours?|hrs?|days?|weeks?|wks?|months?|mos?|years?|yrs?)\b/i.exec(after) ||
                                /\b(hours?|hrs?|days?|weeks?|wks?|months?|mos?|years?|yrs?)\b/i.exec(value);
                var num = numbersIn(value);
                if (unitMatch && num.length === 1) {
                    // Duration: the quote must state a duration; unit conversion allowed (marked derived).
                    var unit = unitOf(unitMatch[1]), n = num[0];
                    var ds = durationsIn(quote);
                    if (!ds.length) return reject('duration not in quote');
                    var same = ds.some(function (d) { return d.unit === unit && d.n === n; });
                    if (!same) {
                        var conv = ds.filter(function (d) {
                            var x = d.n * UNIT_DAYS[d.unit] / UNIT_DAYS[unit];
                            var monthWeeks = (d.unit === 'month' && unit === 'week') ? d.n * 4 : (d.unit === 'year' && unit === 'week') ? d.n * 52 : null;
                            return n === Math.round(x) || n === Math.floor(x) || n === monthWeeks;
                        })[0];
                        if (!conv) return reject('duration not supported by quote');
                        kind = 'derived';
                        conversion = conv.n + ' ' + conv.unit + (conv.n === 1 ? '' : 's') + ' → ' + n + ' ' + unit + (n === 1 ? '' : 's');
                    }
                } else if (/^\s*\d+(\.\d+)?\s*$/.test(value) || (num.length === 1 && NUMBER_WORDS[fillNorm(value)] !== undefined)) {
                    // Count / score: digits or words in the quote; 0 when the quote clearly says none.
                    var cn = num[0];
                    if (cn === 0) { if (!NEGATION_NONE.test(quote) && numbersIn(quote).indexOf(0) === -1) return reject('count not in quote'); }
                    else if (numbersIn(quote).indexOf(cn) === -1) return reject('count not in quote');
                } else {
                    // Names: a provider or facility name must appear in the quote.
                    var context = line + ' ' + ((b.paren && b.paren.hint) || '');
                    if ((NAME_CONTEXT.test(context) || NAME_VALUE.test(value)) && q.indexOf(fillNorm(value)) === -1) return reject('name not in quote');
                    // Any other number in the value (scores, strengths) must be stated; spinal levels are exempt.
                    var stray = (value.match(/[A-Za-z]*\d+(?:\.\d+)?/g) || []).filter(function (tok) { return !FILL_LEVEL_TOKEN.test(tok); })
                        .map(function (tok) { return Number(tok.replace(/^[A-Za-z]+/, '')); })
                        .filter(function (x) { return numbersIn(quote).indexOf(x) === -1; });
                    if (stray.length) return reject('number not in quote');
                }
            }
            accepted[v.blank_id] = { value: value, kind: kind, quote: quote, section: v.source_section, conversion: conversion };
        });
        return { accepted: accepted, rejections: rejections, flags: parsed.flags || [] };
    }

    // §4. Returns per template { text, marks: [{start, end, kind: 'explicit'|'inferred'|'unfilled', quote?}] }.
    function fillAssemble(templates, plan, accepted) {
        return (templates || []).map(function (t, ti) {
            var text = String(t.text || ''), out = '', pos = 0, marks = [];
            plan.blanks.filter(function (b) { return b.template === ti; }).forEach(function (b) {
                if (b.start < pos) return;   // inside a parenthetical already consumed (never happens: such parens are kept)
                out += text.slice(pos, b.start);
                var a = accepted[b.blank_id];
                if (!a) {
                    marks.push({ start: out.length, end: out.length + (b.end - b.start), kind: 'unfilled' });
                    out += text.slice(b.start, b.end);
                    pos = b.end;
                    return;
                }
                var value = a.value;
                if (b.paren && b.paren.type === 'options') {
                    value = b.paren.options.filter(function (o) { return o.toLowerCase() === a.value.toLowerCase(); })[0] || a.value;
                }
                marks.push({ start: out.length, end: out.length + value.length, kind: a.kind, quote: a.quote, conversion: a.conversion || null });
                out += value;
                // Option list: dropped. Hint: dropped because the blank is filled. Contains-blank: kept.
                pos = (b.paren && b.paren.type !== 'contains_blank') ? b.paren.end : b.end;
            });
            out += text.slice(pos);
            return { text: out, marks: marks };
        });
    }

    function fillSummary(plan, validation) {
        var ids = Object.keys(validation.accepted);
        var inferred = ids.filter(function (id) { return validation.accepted[id].kind === 'inferred'; }).length;
        var derived = ids.filter(function (id) { return validation.accepted[id].kind === 'derived'; }).length;
        var w = validation.flags.length;
        var parts = []; if (inferred) parts.push(inferred + ' inferred'); if (derived) parts.push(derived + ' derived');
        return 'Filled ' + ids.length + ' of ' + plan.blanks.length + ' blanks' + (parts.length ? ' (' + parts.join(', ') + ')' : '') +
            (w ? '; ' + w + ' criteria warning' + (w === 1 ? '' : 's') : '') + '.';
    }

    // Convenience: response -> verified, assembled templates. ok:false (malformed) leaves everything as-is.
    function fillApply(note, templates, response) {
        var plan = fillPlan(templates);
        var parsed = fillParse(response);
        if (!parsed) return { ok: false, notice: 'Claude fill unavailable — blanks left as-is.' };
        var v = fillValidate(parsed, plan, note);
        var assembled = fillAssemble(templates, plan, v.accepted);
        return {
            ok: true,
            texts: assembled.map(function (a) { return a.text; }),
            marks: assembled.map(function (a) { return a.marks; }),
            flags: v.flags.map(function (f) { var l = plan.lines[f.line_id - 1]; return { line_id: f.line_id, message: f.message, line: l ? l.text : null }; }),
            summary: fillSummary(plan, v),
            counts: { blanks: plan.blanks.length, filled: Object.keys(v.accepted).length,
                      inferred: Object.keys(v.accepted).filter(function (id) { return v.accepted[id].kind === 'inferred'; }).length,
                      derived: Object.keys(v.accepted).filter(function (id) { return v.accepted[id].kind === 'derived'; }).length,
                      rejected: v.rejections.length },
            // Reasons only (never values or note text): safe to log.
            rejectionReasons: v.rejections.map(function (r) { return r.reason; })
        };
    }

    // Resolution results (inserted procedures) <-> fill templates.
    function fillTemplatesFromResults(results) {
        var t = [];
        (results || []).forEach(function (r, i) {
            if (!r.insert) return;
            if (r.examText) t.push({ slot: 'exam', result: i, text: r.examText });
            if (r.dotphrase) t.push({ slot: 'ap', result: i, text: r.dotphrase });
        });
        return t;
    }
    function applyFilledTexts(results, templates, texts) {
        var out = JSON.parse(JSON.stringify(results || []));
        templates.forEach(function (t, k) {
            if (t.slot === 'exam') out[t.result].examText = texts[k];
            else out[t.result].dotphrase = texts[k];
        });
        return out;
    }

    // ── Open the picker only for a planned procedure (SPEC_freed_picker_on_planned_procedure) ──────
    // Applies to every capture source (Heidi and Freed; 2026-10-12). Rule-based and local; no note text
    // leaves the machine. Input: the A&P slot (F11) text. Every line outside the Follow-up: block is
    // evaluated: numbered, bullet, plain sentence, and labeled ("Plan: ...") lines.
    var BASE_PROCEDURE_TERMS = ['injection', 'injections', 'block', 'blocks', 'medial branch', 'MBB', 'radiofrequency',
        'ablation', 'RFA', 'epidural', 'ESI', 'transforaminal', 'interlaminar', 'caudal', 'facet', 'SI joint', 'sacroiliac',
        'genicular', 'trigger point', 'Botox', 'botulinum', 'nerve block', 'stellate', 'sympathetic', 'spinal cord stimulator',
        'SCS', 'intrathecal', 'pump', 'kyphoplasty', 'vertebroplasty', 'discogram', 'PRP', 'arthrocentesis', 'aspiration',
        // Abbreviations (2026-10-12)
        'TFESI', 'ILESI', 'LESI', 'CESI', 'TESI', 'TF ESI', 'IL ESI', 'SIJI', 'SIJ', 'TPI', 'TPIs', 'GTB', 'GNB', 'RFTC',
        'LMBB', 'CMBB'];
    // "plan" (bare verb) is not in the spec's list; added because the spec's own case
    // "Plan right SI joint injection under fluoroscopy" must be planned (reported).
    var COMMITMENT_PHRASES = ['schedule', 'scheduled', 'scheduling', 'proceed with', 'proceeding with', 'plan for', 'planned',
        'planning', 'plan', 'will perform', 'will schedule', 'will proceed', 'book', 'booked', 'perform', 'performed',
        'administered', 'completed today', 'done today', 'set up'];
    var HEDGES = ['consider', 'considering', 'could', 'may', 'might', 'possible', 'possibly', 'potential', 'potentially',
        'option', 'options', 'discuss', 'discussed', 'discussion', 'if', 'unless', 'would', 'defer', 'deferred', 'hold off',
        'declined', 'declines', 'refused', 'not a candidate', 'not indicated', 'in the future', 'eventually', 'versus', 'vs'];

    function phraseRe(p) {
        return new RegExp('(?:^|[^A-Za-z0-9])(' + p.trim().split(/\s+/).map(escapeRe).join('[\\s-]+') + ')(?![A-Za-z0-9])', 'i');
    }
    function anyPhrase(text, list) { for (var i = 0; i < list.length; i++) if (phraseRe(list[i]).test(text)) return true; return false; }

    // Base list + every procedure name and alias in the library, the name without its region prefix
    // ("Lumbar/sacral transforaminal ESI" -> "transforaminal ESI"), and all-caps abbreviations of
    // 3+ letters inside names ("ESI", "RFA").
    var REGION_PREFIX = /^(?:cervical|thoracic|lumbar|sacral|lumbosacral)(?:\/(?:cervical|thoracic|lumbar|sacral))?\s+/i;
    function procedureTerms(bundle) {
        var terms = BASE_PROCEDURE_TERMS.slice();
        procedureList(bundle).forEach(function (p) {
            [p.name].concat(p.aliases || []).forEach(function (n) {
                if (!n) return;
                terms.push(n);
                var bare = n.replace(REGION_PREFIX, '');
                if (bare !== n && bare.trim()) terms.push(bare);
                (n.match(/\b[A-Z]{3,}s?\b/g) || []).forEach(function (a) { terms.push(a); });
            });
        });
        return terms.filter(function (t, i) { return terms.indexOf(t) === i; });
    }

    // "order" counts only when a procedure term is its object (within the next few words).
    function orderWithProcedure(clause, terms) {
        var re = /(?:^|[^A-Za-z0-9])order(?:ed|s)?(?![A-Za-z0-9])((?:\s+\S+){1,5})/gi, m;
        while ((m = re.exec(clause)) !== null) if (anyPhrase(m[1], terms)) return true;
        return false;
    }

    // §2.1: split at ';' and at sentence boundaries ('. ' followed by a capital letter).
    function intentClauses(line) {
        return line.split(';').reduce(function (acc, part) {
            return acc.concat(part.split(/\.\s+(?=[A-Z])/));
        }, []).map(function (c) { return c.trim(); }).filter(Boolean);
    }

    // §2.2 (+ §2.3: imaging words are simply not procedure terms, so imaging-only clauses fail).
    function clauseQualifies(clause, terms) {
        if (!anyPhrase(clause, terms)) return false;
        if (!(anyPhrase(clause, COMMITMENT_PHRASES) || orderWithProcedure(clause, terms))) return false;
        return !anyPhrase(clause, HEDGES);
    }

    // One A&P line (bullet/numbered marker optional). INLINE_LABEL lines follow §2.4 only.
    function lineIsPlanned(line, bundle, terms) {
        terms = terms || procedureTerms(bundle);
        var t = String(line).trim().replace(/^-\s+/, '').replace(/^\d+\.\s+/, '');
        var label = /^([^:\-\d][^:]*):\s+(\S.*)$/.exec(String(line).trim());
        if (label && !/^\s*[-\d]/.test(String(line))) {
            var name = label[1].toLowerCase(), content = label[2].trim();
            if (/considered/.test(name)) return false;
            // §2.4 summary lines ("Procedures scheduled: ...").
            if (/scheduled|planned|performed/.test(name)) return !/^none\.?$/i.test(content) && anyPhrase(content, terms);
            t = content;   // any other label ("Plan: Schedule TFESI"): judge the content like a sentence
        }
        var clauses = intentClauses(t);
        for (var i = 0; i < clauses.length; i++) if (clauseQualifies(clauses[i], terms)) return true;
        return false;
    }

    // Whole A&P slot (any source): planned if any line outside the Follow-up: block qualifies.
    // Heidi A&P text is free-form, so plain sentence lines count as well as numbered/bullet/labeled ones.
    function procedurePlanned(apText, bundle) {
        var terms = procedureTerms(bundle);
        var lines = String(apText || '').replace(/\r\n?/g, '\n').split('\n');
        var inFollowUp = false;
        for (var i = 0; i < lines.length; i++) {
            var raw = lines[i], t = raw.trim();
            if (!t) { inFollowUp = false; continue; }
            if (/^follow-?up:$/i.test(t)) { inFollowUp = true; continue; }
            var numbered = /^\s*\d+\.\s+/.test(raw), bullet = /^\s*-\s+/.test(raw);
            var inline = !numbered && !bullet && /^[^:\-\d][^:]*:\s+\S.*$/.test(t);
            if (numbered || inline) inFollowUp = false;
            if (inFollowUp) continue;
            if (lineIsPlanned(raw, bundle, terms)) return true;
        }
        return false;
    }

    // After any successful capture (Heidi or Freed, whatever key is bound): open the picker only for
    // a planned procedure; otherwise a brief, non-blocking notice. Manual open always works.
    var NO_PLANNED_NOTICE = 'No planned procedure detected \u2014 use Open payer picker if needed.';
    function pickerOnCapture(apText, bundle) {
        if (!String(apText || '').trim()) return { open: false, notice: null };
        var planned = procedurePlanned(apText, bundle);
        return { open: planned, notice: planned ? null : NO_PLANNED_NOTICE };
    }

    // Capture source for each hotkey action. Rebinding changes only the key, never the source
    // (parser, picker gating and Claude fill all follow the source).
    var CAPTURE_SOURCE_FOR_ACTION = { capture: 'heidi', captureFreed: 'freed' };
    function captureSourceForAction(action) { return CAPTURE_SOURCE_FOR_ACTION[action] || null; }

    // ── payer picker ──────────────────────────────────────────────────────────────────────────
    var MAX_RECENTS = 10;
    function payerRegistry(bundle) {
        return ((bundle && bundle.registries && bundle.registries.payers) || (bundle && bundle.payers) || [])
            .map(function (p) { return { payer_id: p.payer_id, name: p.name, aliases: p.aliases || [] }; });
    }
    function scorePayer(p, q) {
        if (!q) return 1;
        var names = [p.name].concat(p.aliases);
        var best = 0;
        for (var i = 0; i < names.length; i++) {
            var n = names[i].toLowerCase();
            if (n === q) best = Math.max(best, 100);
            else if (n.indexOf(q) === 0) best = Math.max(best, 80);
            else if (new RegExp('(^|[^a-z0-9])' + escapeRe(q)).test(n)) best = Math.max(best, 60);
            else if (n.indexOf(q) !== -1) best = Math.max(best, 30);
        }
        return best;
    }
    // Returns [{payer_id, name, pinned}] — the up-to-10 most recent payers first (most recent
    // first) when they match, then the rest by score/name.
    function searchPayers(bundle, query, recents) {
        var q = String(query || '').trim().toLowerCase();
        var all = payerRegistry(bundle);
        var byId = {};
        all.forEach(function (p) { byId[p.payer_id] = p; });
        var rec = (recents || []).filter(function (id) { return byId[id]; }).slice(0, MAX_RECENTS);
        var out = [];
        rec.forEach(function (id) { if (scorePayer(byId[id], q) > 0) out.push({ payer_id: id, name: byId[id].name, pinned: true }); });
        var rest = all.filter(function (p) { return rec.indexOf(p.payer_id) === -1; })
            .map(function (p) { return { p: p, s: scorePayer(p, q) }; })
            .filter(function (x) { return x.s > 0; })
            .sort(function (a, b) { return b.s - a.s || a.p.name.localeCompare(b.p.name); });
        rest.forEach(function (x) { out.push({ payer_id: x.p.payer_id, name: x.p.name, pinned: false }); });
        return out;
    }
    function recordRecentPayer(recents, payerId) {
        var r = (recents || []).filter(function (id) { return id !== payerId; });
        r.unshift(payerId);
        return r.slice(0, MAX_RECENTS);
    }

    // ── library bundle validation & source selection ──────────────────────────────────────────
    function parseBundle(raw) {
        try {
            var b = typeof raw === 'string' ? JSON.parse(raw.replace(/^﻿/, '')) : raw;
            if (!b || typeof b !== 'object' || !Array.isArray(b.entries) || !b.built_at) return null;
            return b;
        } catch (e) { return null; }
    }
    // Fallback order: fresh download -> local cache -> bundled snapshot. Each candidate is
    // { raw, tag } or null. Returns { bundle, source, tag } (source: 'download'|'cache'|'snapshot'|'none').
    function chooseLibrary(fresh, cache, snapshot) {
        var c = [['download', fresh], ['cache', cache], ['snapshot', snapshot]];
        for (var i = 0; i < c.length; i++) {
            if (!c[i][1]) continue;
            var b = parseBundle(c[i][1].raw);
            if (b) return { bundle: b, source: c[i][0], tag: c[i][1].tag || null };
        }
        return { bundle: null, source: 'none', tag: null };
    }

    // ── hotkeys ───────────────────────────────────────────────────────────────────────────────
    // Action ids and defaults. Defaults are today's keys and must not change.
    var HOTKEY_ACTIONS = [
        { id: 'capture',   label: 'Heidi capture', default: 'F8' },
        { id: 'pasteHpi',  label: 'Paste HPI',     default: 'F9' },
        { id: 'pasteExam', label: 'Paste Exam',    default: 'F10' },
        { id: 'pasteAp',   label: 'Paste A&P',     default: 'F11' },
        // Freed (second scribe source): Windows only; the macOS app has no Freed source.
        { id: 'captureFreed', label: 'Freed capture', default: 'F7', platforms: ['win32'] }
    ];
    // Optional actions: unbound by default (never in defaultHotkeys), validated only when bound.
    var OPTIONAL_HOTKEY_ACTIONS = [
        { id: 'openPicker', label: 'Open payer picker', default: '', platforms: ['win32', 'darwin'] }
    ];
    // Keys web browsers use (help, find, reload, address bar, caret browsing, full screen, devtools).
    var BROWSER_KEYS = ['F1', 'F3', 'F5', 'F6', 'F7', 'F11', 'F12'];
    function optionalHotkeyActions(platform) {
        return OPTIONAL_HOTKEY_ACTIONS.filter(function (a) { return !a.platforms || (platform && a.platforms.indexOf(platform) !== -1); });
    }
    // Actions for a platform. No platform -> only actions that exist everywhere (F8-F11).
    function actionsFor(platform) {
        return HOTKEY_ACTIONS.filter(function (a) { return !a.platforms || (platform && a.platforms.indexOf(platform) !== -1); });
    }
    var MOD_ORDER = ['Ctrl', 'Alt', 'Shift', 'Cmd'];
    var MOD_ALIASES = { ctrl: 'Ctrl', control: 'Ctrl', commandorcontrol: 'Ctrl', cmdorctrl: 'Ctrl', alt: 'Alt', option: 'Alt',
        opt: 'Alt', shift: 'Shift', cmd: 'Cmd', command: 'Cmd', meta: 'Cmd', super: 'Cmd', win: 'Cmd' };
    var KEY_ALIASES = { pgup: 'PageUp', pageup: 'PageUp', pgdn: 'PageDown', pagedown: 'PageDown', ins: 'Insert',
        insert: 'Insert', del: 'Delete', delete: 'Delete', home: 'Home', end: 'End', up: 'Up', down: 'Down',
        left: 'Left', right: 'Right', space: 'Space', tab: 'Tab', enter: 'Enter', return: 'Enter', esc: 'Esc', escape: 'Esc' };

    // Canonical form: modifiers in fixed order + key, e.g. "Ctrl+Shift+F10". null if invalid.
    function normalizeHotkey(s) {
        if (!s || typeof s !== 'string') return null;
        var parts = s.split('+').map(function (p) { return p.trim(); }).filter(Boolean);
        if (!parts.length) return null;
        var mods = {}, key = null;
        for (var i = 0; i < parts.length; i++) {
            var lp = parts[i].toLowerCase();
            if (MOD_ALIASES[lp]) { mods[MOD_ALIASES[lp]] = true; continue; }
            if (key) return null; // two non-modifier keys
            if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(parts[i])) key = parts[i].toUpperCase();
            else if (/^[a-z0-9]$/i.test(parts[i])) key = parts[i].toUpperCase();
            else if (KEY_ALIASES[lp]) key = KEY_ALIASES[lp];
            else return null;
        }
        if (!key) return null;
        var m = MOD_ORDER.filter(function (x) { return mods[x]; });
        // Without a modifier only F-keys and PageUp/PageDown are allowed; anything else (letters,
        // Space, Delete, arrows, Home/End...) would hijack ordinary typing in Cerner.
        if (!m.length && !/^F\d{1,2}$/.test(key) && key !== 'PageUp' && key !== 'PageDown') return null;
        return m.concat([key]).join('+');
    }

    var CONFLICTS = {
        win32: ['Alt+F4', 'Ctrl+Alt+Delete', 'Alt+Tab', 'Ctrl+Esc', 'Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+A', 'Ctrl+Z',
            'Ctrl+Y', 'Ctrl+S', 'Ctrl+P', 'Ctrl+F', 'F1', 'Cmd+L', 'Cmd+D', 'Cmd+E', 'Cmd+R', 'Alt+Space'],
        darwin: ['Cmd+Q', 'Cmd+W', 'Cmd+Tab', 'Cmd+Space', 'Cmd+C', 'Cmd+V', 'Cmd+X', 'Cmd+A', 'Cmd+Z', 'Cmd+H',
            'Cmd+M', 'Cmd+S', 'Cmd+P', 'Cmd+F', 'Ctrl+Space', 'Ctrl+Up', 'Ctrl+Down', 'Ctrl+Left', 'Ctrl+Right',
            'Cmd+Shift+3', 'Cmd+Shift+4', 'Cmd+Shift+5', 'Cmd+Alt+Esc', 'Ctrl+Cmd+Q', 'Ctrl+Cmd+F']
    };

    // bindings: {actionId: string}. Returns { ok, bindings (normalized, defaults filled),
    // errors: [{action, message}], warnings: [{action, message}] }.
    function validateHotkeys(bindings, platform) {
        var out = {}, errors = [], warnings = [], used = {};
        var conflicts = CONFLICTS[platform] || [];
        // Windows: PageUp/PageDown are the fixed legacy HPI/A&P copy keys in the AHK script.
        if (platform === 'win32') { used.PageUp = 'the legacy HPI copy key'; used.PageDown = 'the legacy A&P copy key'; }
        var actions = actionsFor(platform);
        for (var i = 0; i < actions.length; i++) {
            var a = actions[i];
            var raw = bindings && bindings[a.id];
            var n = raw == null || raw === '' ? a.default : normalizeHotkey(raw);
            if (!n) { errors.push({ action: a.id, message: a.label + ': "' + raw + '" is not a valid key combination' }); n = a.default; }
            if (used[n]) errors.push({ action: a.id, message: a.label + ': ' + n + ' is already used by ' + used[n] });
            else used[n] = a.label;
            if (conflicts.indexOf(n) !== -1) warnings.push({ action: a.id, message: a.label + ': ' + n + ' is reserved by the system and may not work' });
            out[a.id] = n;
        }
        var optional = optionalHotkeyActions(platform);
        for (var j = 0; j < optional.length; j++) {
            var o = optional[j];
            var r = bindings && bindings[o.id];
            if (r == null || r === '') continue;               // unbound (the default)
            var on = normalizeHotkey(r);
            if (!on) { errors.push({ action: o.id, message: o.label + ': "' + r + '" is not a valid key combination' }); continue; }
            if (used[on]) { errors.push({ action: o.id, message: o.label + ': ' + on + ' is already used by ' + used[on] }); continue; }
            used[on] = o.label;
            if (conflicts.indexOf(on) !== -1) warnings.push({ action: o.id, message: o.label + ': ' + on + ' is reserved by the system and may not work' });
            if (BROWSER_KEYS.indexOf(on) !== -1) warnings.push({ action: o.id, message: o.label + ': ' + on + ' is used by web browsers; pick a key with a modifier' });
            out[o.id] = on;
        }
        return { ok: errors.length === 0, bindings: out, errors: errors, warnings: warnings };
    }
    function defaultHotkeys(platform) {
        var d = {};
        actionsFor(platform).forEach(function (a) { d[a.id] = a.default; });
        return d;
    }
    // AutoHotkey v2 key name for a canonical binding ("Ctrl+Shift+F10" -> "^+F10").
    var AHK_KEYS = { PageUp: 'PgUp', PageDown: 'PgDn', Insert: 'Ins', Delete: 'Del', Esc: 'Escape' };
    function toAhkHotkey(n) {
        var norm = normalizeHotkey(n);
        if (!norm) return null;
        var parts = norm.split('+'), key = parts.pop(), pre = '';
        parts.forEach(function (m) { pre += { Ctrl: '^', Alt: '!', Shift: '+', Cmd: '#' }[m]; });
        return pre + (AHK_KEYS[key] || key);
    }

    var api = {
        cernerSafe: cernerSafe,
        detectProcedures: detectProcedures,
        resolveSelections: resolveSelections,
        composeExam: composeExam,
        composeAP: composeAP,
        composeOutputs: composeOutputs,
        composeFromResults: composeFromResults,
        fillPlan: fillPlan,
        fillRequest: fillRequest,
        fillParse: fillParse,
        fillValidate: fillValidate,
        fillAssemble: fillAssemble,
        fillApply: fillApply,
        fillTemplatesFromResults: fillTemplatesFromResults,
        applyFilledTexts: applyFilledTexts,
        FILL_SYSTEM_PROMPT: FILL_SYSTEM_PROMPT,
        FILL_INPUT_SCHEMA: FILL_INPUT_SCHEMA,
        FILL_TOOL: FILL_TOOL,
        procedurePlanned: procedurePlanned,
        freedProcedurePlanned: procedurePlanned,   // older name; same rule for every source
        procedureLineIsPlanned: lineIsPlanned,
        procedureTerms: procedureTerms,
        pickerOnCapture: pickerOnCapture,
        NO_PLANNED_NOTICE: NO_PLANNED_NOTICE,
        captureSourceForAction: captureSourceForAction,
        fillNotice: fillNotice,
        FILL_TIMEOUT_MS: FILL_TIMEOUT_MS,
        searchPayers: searchPayers,
        recordRecentPayer: recordRecentPayer,
        parseBundle: parseBundle,
        chooseLibrary: chooseLibrary,
        normalizeHotkey: normalizeHotkey,
        validateHotkeys: validateHotkeys,
        defaultHotkeys: defaultHotkeys,
        toAhkHotkey: toAhkHotkey,
        HOTKEY_ACTIONS: HOTKEY_ACTIONS,
        hotkeyActionsFor: actionsFor,
        optionalHotkeyActions: optionalHotkeyActions,
        MAX_RECENTS: MAX_RECENTS,
        _segments: segments,
        _lateralityIn: lateralityIn
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.MNACore = api;
})(this);
