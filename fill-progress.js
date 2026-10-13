// Claude fill progress window (stages, elapsed time, Cancel). No note text is ever sent here.
const stage = document.getElementById('stage'), elapsed = document.getElementById('elapsed');
const cancel = document.getElementById('cancel'), close = document.getElementById('close'), fill = document.getElementById('fill');
let startedAt = Date.now(), finished = false;
setInterval(() => { if (!finished) elapsed.textContent = Math.round((Date.now() - startedAt) / 1000) + ' s'; }, 250);
cancel.onclick = () => { cancel.disabled = true; cancel.textContent = 'Cancelling…'; window.fillProgressAPI.cancel(); };
close.onclick = () => window.fillProgressAPI.close();
window.fillProgressAPI.onProgress((p) => {
    if (p.startedAt) startedAt = p.startedAt;
    stage.textContent = p.text || '';
    stage.className = p.stage === 'error' || p.stage === 'cancelled' ? 'error' : p.stage === 'done' ? 'done' : '';
    if (p.total) fill.style.width = Math.min(100, Math.round(100 * (p.stage === 'done' || p.stage === 'checking' ? 1 : p.n / p.total))) + '%';
    finished = ['done', 'error', 'cancelled'].includes(p.stage);
    if (finished) { elapsed.textContent = p.elapsed + ' s'; cancel.style.display = 'none'; close.style.display = ''; }
});
