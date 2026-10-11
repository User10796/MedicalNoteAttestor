// SPEC_ui_cleanup_ai_note: visible "Heidi" -> "AI Note" where it means the scribe note generically;
// scribe names kept where they distinguish sources; exactly one Settings menu entry.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

test('main window and Settings tabs say "AI Note" (internal ids unchanged)', () => {
    assert.match(read('index.html'), /<button class="tab" data-tab="heidi">AI Note<\/button>/);
    assert.match(read('settings.html'), /<button class="tab active" data-tab="heidi">AI Note<\/button>/);
    assert.match(read('index.html'), /Configure in Settings &rarr; AI Note/);
    assert.match(read('renderer.js'), /Configure in Settings \\u2192 AI Note/);
    for (const f of ['index.html', 'settings.html', 'renderer.js']) assert.ok(!/Heidi Copy<\/button>|→ Heidi Copy|&rarr; Heidi Copy/.test(read(f)), f);
});

test('source-specific labels keep the scribe name (hotkeys, picker source label)', () => {
    assert.match(read('lib/mna-core.js'), /label: 'Heidi capture'/);
    assert.match(read('lib/mna-core.js'), /label: 'Freed capture'/);
    assert.match(read('picker.js'), /'Heidi capture'/);
});

test('Electron: exactly one Settings menu entry, and it opens Settings', () => {
    const src = read('main.js');
    const tmpl = src.slice(src.indexOf('const menuTemplate = ['), src.indexOf('const menu = Menu.buildFromTemplate'));
    assert.strictEqual((tmpl.match(/click: \(\) => openSettings\(\)/g) || []).length, 1);
    assert.strictEqual((tmpl.match(/Preferences\.\.\./g) || []).length, 1);
    assert.match(src, /function openSettings\(\)/);
});
