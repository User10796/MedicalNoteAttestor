// Payer picker + procedure confirmation. Runs entirely locally (no network).
(function () {
    const C = window.MNACore;
    const $ = (id) => document.getElementById(id);
    const VARIANT_LABELS = {
        radiculopathy_cervical: 'Radiculopathy (cervical)', radiculopathy_thoracic: 'Radiculopathy (thoracic)',
        radiculopathy_lumbar: 'Radiculopathy (lumbar)', pdn: 'Painful diabetic neuropathy',
        pslps: 'Failed back (PSLPS)', chronic_back_pain: 'Chronic back pain'
    };
    const LAT_LABELS = { bilateral: 'Bilateral', right: 'Right', left: 'Left', midline: 'Midline' };
    // sel = -1: nothing highlighted. With an empty query nothing is pre-selected (wrong-payer risk);
    // typing highlights the best match, or press 1-9/0 for a pinned recent payer.
    let init = null, procs = [], procById = {}, matches = [], sel = -1, payer = null, rows = [];

    function done(answer) { window.pickerAPI.done(answer); }
    function skip() { done(null); }

    // ── step 1: payer ──
    function renderList() {
        matches = C.searchPayers(init.bundle, $('q').value, init.recents);
        if (sel >= matches.length) sel = matches.length - 1;
        const list = $('list');
        list.textContent = '';
        let pinnedN = 0;
        matches.forEach((m, i) => {
            const d = document.createElement('div');
            d.className = 'opt' + (i === sel ? ' sel' : '');
            const n = document.createElement('span'); n.className = 'n';
            if (m.pinned && !$('q').value) { pinnedN++; n.textContent = String(pinnedN % 10); }
            const name = document.createElement('span'); name.textContent = m.name; name.style.flex = '1';
            d.append(n, name);
            if (m.pinned) { const p = document.createElement('span'); p.className = 'pin'; p.textContent = 'recent'; d.append(p); }
            d.addEventListener('mousedown', (e) => { e.preventDefault(); choosePayer(m); });
            list.append(d);
            if (i === sel) d.scrollIntoView({ block: 'nearest' });
        });
    }
    function choosePayer(m) {
        if (!m) return;
        payer = m;
        $('payer-name').textContent = m.name;
        $('step-payer').classList.add('hidden');
        $('step-proc').classList.remove('hidden');
        renderRows();
        $('insert').focus();
    }

    // ── step 2: procedures ──
    function rowFor(item) {
        return { procedure_id: item.procedure_id, laterality: item.laterality, checked: !!item.checked,
                 variant: item.variant || null, line: item.line, planned: !!item.planned };
    }
    function opt(sel, value, label, selected) {
        const o = document.createElement('option'); o.value = value; o.textContent = label; if (selected) o.selected = true; sel.append(o);
    }
    function renderRows() {
        const box = $('rows');
        box.textContent = '';
        $('none').classList.toggle('hidden', !init.detection.noneDetected);
        rows.forEach((r, i) => {
            const p = procById[r.procedure_id] || null;
            const d = document.createElement('div'); d.className = 'row' + (r.checked ? '' : ' off');
            const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = r.checked; cb.title = 'Include';
            cb.addEventListener('change', () => { r.checked = cb.checked; renderRows(); });
            const ps = document.createElement('select'); ps.className = 'proc';
            opt(ps, '', '— pick a procedure —', !r.procedure_id);
            procs.forEach(x => opt(ps, x.procedure_id, x.name, x.procedure_id === r.procedure_id));
            ps.addEventListener('change', () => {
                r.procedure_id = ps.value || null; r.variant = null; r.checked = !!ps.value;
                const np = procById[r.procedure_id];
                if (np && (np.laterality_options || []).indexOf(r.laterality) === -1)
                    r.laterality = (np.laterality_options || []).indexOf('bilateral') !== -1 ? 'bilateral' : np.laterality_options[0];
                renderRows();
            });
            d.append(cb, ps);
            if (p) {
                const ls = document.createElement('select');
                (p.laterality_options || ['bilateral']).forEach(l => opt(ls, l, LAT_LABELS[l] || l, l === r.laterality));
                ls.addEventListener('change', () => { r.laterality = ls.value; renderNotices(); });
                d.append(ls);
                if (p.variants && p.variants.length) {
                    const vs = document.createElement('select'); vs.title = 'SCS indication (required)';
                    opt(vs, '', 'Indication…', !r.variant);
                    p.variants.forEach(v => opt(vs, v, VARIANT_LABELS[v] || v, v === r.variant));
                    vs.addEventListener('change', () => { r.variant = vs.value || null; renderNotices(); });
                    d.append(vs);
                }
                if (!r.planned && r.checked === false) { const t = document.createElement('span'); t.className = 'tag'; t.textContent = 'suggested'; d.append(t); }
            }
            const x = document.createElement('button'); x.className = 'x'; x.textContent = '×'; x.title = 'Remove';
            x.addEventListener('click', () => { rows.splice(i, 1); renderRows(); });
            d.append(x);
            box.append(d);
        });
        renderNotices();
    }
    function renderNotices() {
        const box = $('notices');
        box.textContent = '';
        if (!payer) return;
        const items = rows.filter(r => r.procedure_id);
        const results = C.resolveSelections(init.bundle, payer.payer_id, items);
        results.forEach(res => {
            if (!res.notice) return;
            const n = document.createElement('div');
            n.className = 'notice' + (res.marker ? ' ' + res.marker : '');
            n.textContent = res.notice;
            box.append(n);
        });
        // Exactly what will be added, so Sterling can see it before Insert (and trim after pasting).
        const ins = results.filter(r => r.insert);
        if (ins.length) {
            const d = document.createElement('details'); d.className = 'preview';
            const sm = document.createElement('summary'); sm.textContent = 'Preview inserted text (' + ins.length + ')';
            d.append(sm);
            ins.forEach(r => {
                const h = document.createElement('div'); h.className = 'ph';
                h.textContent = (procById[r.procedure_id] || {}).name || r.procedure_id; d.append(h);
                if (r.examText) { const e = document.createElement('pre'); e.textContent = 'F10 exam:\n' + r.examText; d.append(e); }
                if (r.dotphrase) { const t = document.createElement('pre'); t.textContent = 'F11 dot-phrase:\n' + r.dotphrase; d.append(t); }
            });
            box.append(d);
        }
    }
    function insert() {
        if (!payer) return;
        done({ payerId: payer.payer_id, items: rows.filter(r => r.procedure_id) });
    }

    // ── keys ──
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); skip(); return; }
        const onPayer = !$('step-payer').classList.contains('hidden');
        if (onPayer) {
            if (e.key === 'ArrowDown') { sel = Math.min(sel + 1, matches.length - 1); renderList(); e.preventDefault(); }
            else if (e.key === 'ArrowUp') { sel = Math.max(sel - 1, 0); renderList(); e.preventDefault(); }
            else if (e.key === 'Enter') { e.preventDefault(); if (sel >= 0) choosePayer(matches[sel]); }
            else if (/^[0-9]$/.test(e.key) && !$('q').value) {
                // A digit only highlights that recent payer; Enter confirms (a stray digit can't pick one).
                const pinned = matches.filter(m => m.pinned);
                const k = e.key === '0' ? 9 : Number(e.key) - 1;
                e.preventDefault();
                if (pinned[k]) { sel = matches.indexOf(pinned[k]); renderList(); }
            }
        } else if (e.key === 'Enter' && e.target.tagName !== 'SELECT' && e.target.className !== 'link' && e.target.className !== 'x') {
            e.preventDefault(); insert();
        }
    });
    $('q').addEventListener('input', () => { sel = $('q').value.trim() ? 0 : -1; renderList(); });
    $('skip1').addEventListener('click', skip);
    $('skip2').addEventListener('click', skip);
    $('insert').addEventListener('click', insert);
    $('add').addEventListener('click', () => { rows.push({ procedure_id: null, laterality: 'bilateral', checked: true, variant: null, planned: true }); renderRows(); });
    $('change-payer').addEventListener('click', () => {
        payer = null;
        $('step-proc').classList.add('hidden'); $('step-payer').classList.remove('hidden');
        $('q').focus(); renderList();
    });

    window.pickerAPI.onInit((data) => {
        init = data;
        procs = ((data.bundle.registries && data.bundle.registries.procedures) || data.bundle.procedures || []).slice()
            .sort((a, b) => a.name.localeCompare(b.name));
        procs.forEach(p => { procById[p.procedure_id] = p; });
        rows = (data.detection.items || []).map(rowFor);
        if (!rows.length) rows.push({ procedure_id: null, laterality: 'bilateral', checked: true, variant: null, planned: true });
        $('src').textContent = data.source === 'heidi' ? 'Heidi capture' : (data.source || '');
        if (data.sessionLastPayer) {
            const last = C.searchPayers(data.bundle, '', [data.sessionLastPayer])[0];
            if (last) $('payer-hint').textContent = 'Last payer this session: ' + last.name + ' (not pre-selected). ' + $('payer-hint').textContent;
        }
        renderList();
        $('q').focus();
    });
})();
