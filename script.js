const STORAGE_KEY = 'storyMessengerState';
const COLORS = ['#6c5ce7', '#e17055', '#00b894', '#fdcb6e', '#0984e3', '#e84393', '#00cec9', '#d63031', '#a29bfe', '#55efc4'];
const NARRATOR = { id: 'narrator', name: 'Narrateur', color: '#8a8ea8', avatar: null, isNarrator: true };

function defaultState() {
    return {
        characters: [{ ...NARRATOR }],
        messages: [],
        chapters: [{ id: 'chapter_1', title: 'Chapitre 1', cast: [] }],
        activeChapterId: 'chapter_1',
        activeChar: 'narrator',
        align: 'left',
        charSectionOpen: true,
        appTitle: 'Mon Histoire',
    };
}

let state = defaultState();
// Image attachée au prochain message : volontairement hors de `state` pour ne jamais être enregistrée
let pendingImage = null;
// Seul le message qui vient d'être envoyé est animé, pas toute la liste à chaque rendu
let lastAddedId = null;
let editingId = null;
let reading = null;


/* ---------- Utilitaires ---------- */

const $ = id => document.getElementById(id);
const msgArea = $('msgArea'), charList = $('charList'), charSelector = $('charSelector');
const msgInput = $('msgInput');

function uid(prefix) { return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function isColor(v) { return typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v); }
function refreshIcons() { lucide.createIcons(); }

// Transforme ce que l'utilisateur colle en adresse d'image valide. Sous Windows, « Copier en tant que
// chemin d'accès » donne « "C:\Users\…\image.png" », que le navigateur prendrait pour une adresse « C: »
function normalizeImageUrl(input) {
    let url = (input || '').trim();
    if (url.startsWith('data:')) return url;
    url = url.replace(/^["'<]+|["'>]+$/g, '').trim();
    if (!url) return null;

    const toFileUrl = path => 'file://' + encodeURI(path.replace(/\\/g, '/')).replace(/[?#]/g, encodeURIComponent);
    if (/^[a-z]:[\\/]/i.test(url)) return toFileUrl('/' + url);         // C:\Users\…\image.png
    if (/^\\\\[^\\]/.test(url)) return toFileUrl(url.slice(2));          // \\serveur\partage\image.png
    if (/^\/[^/]/.test(url)) return toFileUrl(url);                       // /home/…/image.png
    if (/^www\./i.test(url)) return 'https://' + url;
    return url;
}

function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Image illisible'));
        img.src = src;
    });
}

function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
    });
}

// Une image de l'ordinateur est réduite puis intégrée à l'histoire (data URL) :
// elle suit ainsi le fichier de sauvegarde, même si l'original est déplacé ou sur un autre PC
async function imageFileToDataUrl(file, maxSize) {
    // Un GIF redessiné perdrait son animation : on le garde tel quel s'il reste léger
    if (file.type === 'image/gif' && file.size <= 2 * 1024 * 1024) return readAsDataUrl(file);

    const objectUrl = URL.createObjectURL(file);
    try {
        const img = await loadImage(objectUrl);
        const width = img.naturalWidth || maxSize, height = img.naturalHeight || maxSize;
        const scale = Math.min(1, maxSize / Math.max(width, height));
        const canvas = el('canvas');
        canvas.width = Math.round(width * scale);
        canvas.height = Math.round(height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/webp', 0.85);
    } finally {
        URL.revokeObjectURL(objectUrl);
    }
}

// Crée un élément sans passer par innerHTML : les données de l'utilisateur ne sont jamais interprétées comme du HTML
function el(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
        if (value == null) continue;
        if (key === 'class') node.className = value;
        else if (key === 'style') node.style.cssText = value;
        else if (key === 'text') node.textContent = value;
        else if (key.startsWith('on')) node[key] = value;
        else node.setAttribute(key, value);
    }
    for (const child of [].concat(children)) {
        if (child != null && child !== false) node.append(child);
    }
    return node;
}

function icon(name) { return el('i', { 'data-lucide': name }); }

function findChar(id) { return state.characters.find(c => c.id === id); }
function currentChapter() { return state.chapters.find(ch => ch.id === state.activeChapterId) || state.chapters[0]; }
// Le narrateur est dans tous les chapitres ; les autres personnages seulement là où on les a ajoutés
function inChapter(c, ch = currentChapter()) { return c.isNarrator || ch.cast.includes(c.id); }
function chapterMessages() {
    return state.messages.filter(m => m.chapterId === state.activeChapterId && findChar(m.charId));
}

let toastTimer;
function showToast(text, type) {
    let toast = $('toast');
    if (!toast) {
        toast = el('div', { id: 'toast', role: 'status' });
        document.body.append(toast);
    }
    toast.textContent = text;
    toast.className = 'toast' + (type === 'error' ? ' toast-error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.remove(), type === 'error' ? 4000 : 2500);
}


/* ---------- Données ---------- */

// Valide et nettoie des données venant de la copie du navigateur ou d'un fichier importé
function normalizeState(raw) {
    if (!raw || typeof raw !== 'object' || !['characters', 'messages', 'chapters'].some(k => Array.isArray(raw[k]))) {
        throw new Error('Format invalide');
    }
    const str = v => (typeof v === 'string' ? v : '');
    const list = v => (Array.isArray(v) ? v : []);
    const seen = new Set();
    const unique = id => typeof id === 'string' && id && !seen.has(id) && seen.add(id);

    const characters = list(raw.characters)
        .filter(c => c && unique(c.id))
        .map(c => ({
            id: c.id,
            name: str(c.name).trim() || (c.id === NARRATOR.id ? NARRATOR.name : 'Personnage'),
            color: isColor(c.color) ? c.color : COLORS[0],
            avatar: normalizeImageUrl(str(c.avatar)),
            isNarrator: c.id === NARRATOR.id,
        }));
    if (!characters.some(c => c.isNarrator)) characters.unshift({ ...NARRATOR });

    const charIds = characters.filter(c => !c.isNarrator).map(c => c.id);
    let chapters = list(raw.chapters)
        .filter(ch => ch && unique(ch.id))
        .map((ch, i) => ({
            id: ch.id,
            title: str(ch.title).trim() || `Chapitre ${i + 1}`,
            // Personnages qui peuvent parler dans ce chapitre (le narrateur, toujours). Les sauvegardes
            // d'avant cette fonction n'ont pas de liste : tous les personnages sont alors présents
            cast: Array.isArray(ch.cast) ? charIds.filter(id => ch.cast.includes(id)) : [...charIds],
        }));
    if (!chapters.length) chapters = [{ ...defaultState().chapters[0], cast: [...charIds] }];

    const chapterIds = new Set(chapters.map(ch => ch.id));
    const activeChapterId = chapterIds.has(raw.activeChapterId) ? raw.activeChapterId : chapters[0].id;

    const messages = list(raw.messages)
        .filter(m => m && typeof m === 'object')
        .map(m => ({
            id: unique(m.id) ? m.id : uid('msg'),
            // Les anciennes sauvegardes n'avaient pas de chapitre : on les range dans le chapitre actif
            chapterId: chapterIds.has(m.chapterId) ? m.chapterId : activeChapterId,
            charId: m.charId,
            text: str(m.text),
            align: m.align === 'right' ? 'right' : 'left',
            image: normalizeImageUrl(str(m.image)),
        }))
        // Supprime les messages orphelins (personnage supprimé) et les messages vides
        .filter(m => characters.some(c => c.id === m.charId) && (m.text || m.image));

    return {
        characters,
        messages,
        chapters,
        activeChapterId,
        activeChar: characters.some(c => c.id === raw.activeChar) ? raw.activeChar : NARRATOR.id,
        align: raw.align === 'right' ? 'right' : 'left',
        charSectionOpen: raw.charSectionOpen !== false,
        appTitle: typeof raw.appTitle === 'string' ? raw.appTitle : 'Mon Histoire',
        // Date de dernière modification : sert à savoir qui est le plus récent entre le navigateur et le fichier
        savedAt: Number(raw.savedAt) || 0,
    };
}

// Copie de l'histoire dans le navigateur, pour l'afficher dès l'ouverture.
// Elle est dans IndexedDB et non plus dans localStorage, limité à ~5 Mo (trop peu avec des images intégrées)
let storageWarned = false;
function writeBrowserCopy() {
    return idbRequest('readwrite', store => store.put(JSON.stringify(state), 'state'))
        .then(() => {
            storageWarned = false;
            // L'ancienne copie (localStorage) n'est plus utile une fois la nouvelle écrite
            try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* stockage bloqué */ }
        })
        .catch(e => {
            console.error('Erreur de sauvegarde dans le navigateur', e);
            if (!storageWarned) {
                storageWarned = true;
                showToast('Copie dans le navigateur impossible (stockage plein ou bloqué). Utilisez « Enregistrer ».', 'error');
            }
        });
}

function saveToLocal() {
    state.savedAt = Date.now();
    scheduleFileWrite();
    writeBrowserCopy();
}

async function loadFromLocal() {
    try {
        let raw = await idbRequest('readonly', store => store.get('state')).catch(() => null);
        // Histoires enregistrées par les versions précédentes
        if (!raw) {
            try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { /* stockage bloqué */ }
        }
        if (raw) state = normalizeState(JSON.parse(raw));
    } catch (e) {
        console.error('Erreur de chargement de la copie du navigateur', e);
    }
}

function commit(scrollToBottom = false) {
    renderAll(scrollToBottom);
    saveToLocal();
}


/* ---------- Rendu : éléments communs ---------- */

function initialEl(c, size) {
    const name = (c.name || '').trim();
    return el('div', {
        class: 'avatar-initial',
        style: `background:${c.color};font-size:${Math.max(10, size / 2.5)}px`,
        text: name ? [...name][0].toUpperCase() : 'P',
    });
}

function avatarEl(c, size = 30) {
    const wrap = el('div', { class: 'avatar', title: c.name, style: `width:${size}px;height:${size}px` });
    if (c.avatar) {
        const img = el('img', { src: c.avatar, alt: '', loading: 'lazy' });
        img.onerror = () => img.replaceWith(initialEl(c, size));
        wrap.append(img);
    } else {
        wrap.append(initialEl(c, size));
    }
    return wrap;
}

function messageImage(url) {
    const img = el('img', { src: url, class: 'img-in-msg', alt: '', loading: 'lazy' });
    img.onerror = () => img.replaceWith(el('div', { class: 'img-error', text: 'Image introuvable' }));
    return img;
}

function messageActions(m) {
    return el('div', { class: 'msg-actions' }, [
        el('button', { class: 'msg-action edit', title: 'Modifier', 'aria-label': 'Modifier le message', onclick: () => openEditModal(m.id) }, icon('pencil')),
        el('button', { class: 'msg-action delete', title: 'Supprimer', 'aria-label': 'Supprimer le message', onclick: () => deleteMessage(m.id) }, icon('trash-2')),
    ]);
}

// Utilisé à la fois par la discussion (avec actions) et par le mode lecture
function messageEl(m, c, { actions = false, reading = false } = {}) {
    const animation = reading ? 'reading-fade' : (m.id === lastAddedId ? 'fade-in' : '');
    const content = [m.text || null, m.image ? messageImage(m.image) : null];

    if (c.isNarrator) {
        return el('div', { class: `msg msg-narrator ${animation}` }, [
            el('div', { class: 'narrator-msg' }, content),
            actions && messageActions(m),
        ]);
    }

    const right = m.align === 'right';
    return el('div', { class: `msg msg-char ${right ? 'right' : 'left'} ${animation}` }, [
        avatarEl(c, 30),
        el('div', { class: 'msg-body' }, [
            el('div', { class: 'msg-author', text: c.name }),
            el('div', {
                class: `bubble ${right ? 'bubble-right' : 'bubble-left'}`,
                style: `background:${c.color}22;border-color:${c.color}44`,
            }, content),
            actions && messageActions(m),
        ]),
    ]);
}


/* ---------- Rendu : sections ---------- */

function renderChars() {
    const present = state.characters.filter(c => inChapter(c));
    const absent = state.characters.filter(c => !inChapter(c));
    charList.replaceChildren(
        el('div', { class: 'char-group-label', text: `Dans « ${currentChapter().title} »` }),
        ...present.map(charRow),
        ...(absent.length ? [el('div', { class: 'char-group-label', text: 'Autres personnages' }), ...absent.map(charRow)] : []),
    );
}

function charRow(c) {
    const present = inChapter(c);
    const row = el('div', { class: 'char-row' + (present ? '' : ' absent') }, avatarEl(c, 26));

    const nameBtn = el('button', { class: 'char-name', text: c.name, title: `${c.name} (cliquer pour renommer)` });
    nameBtn.onclick = () => startRename(c, nameBtn);
    row.append(nameBtn);

    if (!c.isNarrator) {
        row.append(el('button', {
            class: 'icon-btn-sm', title: 'Photo de profil', 'aria-label': `Photo de ${c.name}`,
            onclick: () => editAvatar(c),
        }, icon('camera')));
    }

    const colorInput = el('input', { type: 'color', class: 'color-input', title: 'Couleur', 'aria-label': `Couleur de ${c.name}` });
    colorInput.value = c.color;
    // `change` et non `input` : on ne redessine qu'une fois la couleur choisie
    colorInput.onchange = () => { c.color = colorInput.value; commit(); };
    row.append(colorInput);

    if (!c.isNarrator) {
        const label = present ? 'Retirer de ce chapitre (sans le supprimer)' : 'Faire parler dans ce chapitre';
        row.append(
            el('button', {
                class: 'icon-btn-sm', title: label, 'aria-label': `${c.name} : ${label}`,
                onclick: () => setInChapter(c, !present),
            }, icon(present ? 'user-minus' : 'user-plus')),
            el('button', {
                class: 'icon-btn-sm danger', title: 'Supprimer de toute l’histoire', 'aria-label': `Supprimer ${c.name}`,
                onclick: () => deleteChar(c),
            }, icon('x')),
        );
    }
    return row;
}

function renderChapterSelect() {
    $('chapterSelect').replaceChildren(...state.chapters.map(ch => {
        const option = el('option', { value: ch.id, text: ch.title });
        option.selected = ch.id === state.activeChapterId;
        return option;
    }));
}

function renderChapterList() {
    $('chapterList').replaceChildren(...state.chapters.map(chapterRow));
}

function chapterRow(ch) {
    const row = el('div', { class: 'chapter-row' + (ch.id === state.activeChapterId ? ' active' : '') });
    row.onclick = () => selectChapter(ch.id);

    const input = el('input', { type: 'text', class: 'chapter-input', 'aria-label': 'Nom du chapitre' });
    input.value = ch.title;
    input.onclick = e => e.stopPropagation();
    input.onkeydown = e => {
        if (e.key === 'Enter') input.blur();
        if (e.key === 'Escape') { e.stopPropagation(); input.value = ch.title; input.blur(); }
    };
    input.onblur = () => {
        const title = input.value.trim() || ch.title;
        input.value = title;
        if (title === ch.title) return;
        ch.title = title;
        renderChapterSelect();
        renderChars();
        refreshIcons();
        saveToLocal();
    };

    const deleteBtn = el('button', {
        class: 'icon-btn-sm danger', title: 'Supprimer ce chapitre', 'aria-label': `Supprimer ${ch.title}`,
        onclick: e => { e.stopPropagation(); deleteChapter(ch); },
    }, icon('x'));

    row.append(input, deleteBtn);
    return row;
}

function renderMsgs(scrollToBottom = false) {
    const previousScroll = msgArea.scrollTop;
    const msgs = chapterMessages();

    if (!msgs.length) {
        msgArea.replaceChildren(el('div', { class: 'empty-state' }, [
            icon('message-circle'),
            el('span', { text: 'Aucun message' }),
            el('span', { class: 'empty-hint', text: 'Choisissez en bas qui parle (le narrateur ou un personnage), puis écrivez votre message et appuyez sur Entrée.' }),
        ]));
    } else {
        msgArea.replaceChildren(...msgs.map(m => messageEl(m, findChar(m.charId), { actions: true })));
    }
    lastAddedId = null;
    msgArea.scrollTop = scrollToBottom ? msgArea.scrollHeight : previousScroll;
}

function renderCharSelector() {
    // Celui qui parlait n'est peut-être pas dans ce chapitre (changement de chapitre, retrait…)
    if (!inChapter(findChar(state.activeChar))) state.activeChar = NARRATOR.id;
    charSelector.replaceChildren(...state.characters.filter(c => inChapter(c)).map(c => {
        const isActive = state.activeChar === c.id;
        const btn = el('button', {
            class: 'char-btn',
            'aria-pressed': isActive,
            style: isActive ? `background:${c.color}33;border-color:${c.color}` : null,
        }, [avatarEl(c, 22), el('span', { text: c.name })]);
        btn.onclick = () => { state.activeChar = c.id; renderCharSelector(); saveToLocal(); };
        return btn;
    }));
}

function renderAlign() {
    $('alignToggle').replaceChildren(icon(state.align === 'left' ? 'align-left' : 'align-right'));
}

function renderAll(scrollToBottom = false) {
    $('appTitle').value = state.appTitle;
    $('charSection').hidden = !state.charSectionOpen;
    $('charToggle').classList.toggle('collapsed', !state.charSectionOpen);
    $('charToggle').setAttribute('aria-expanded', state.charSectionOpen);

    renderChapterSelect();
    renderChapterList();
    renderChars();
    renderMsgs(scrollToBottom);
    renderCharSelector();
    renderAlign();
    refreshIcons();
}


/* ---------- Actions : personnages ---------- */

function nextColor(characters = state.characters) {
    const used = new Set(characters.map(c => c.color.toLowerCase()));
    return COLORS.find(color => !used.has(color)) || COLORS[characters.length % COLORS.length];
}

function startRename(c, nameBtn) {
    const input = el('input', { type: 'text', class: 'inline-input', 'aria-label': 'Nom du personnage' });
    input.value = c.name;
    nameBtn.replaceWith(input);
    input.focus();
    input.select();

    // Le rendu retire le champ du DOM, ce qui peut redéclencher `blur` : on ne termine qu'une fois
    let done = false;
    const finish = save => {
        if (done) return;
        done = true;
        if (save) {
            c.name = input.value.trim() || c.name;
            commit();
        } else {
            renderAll();
        }
    };
    input.onblur = () => finish(true);
    input.onkeydown = e => {
        if (e.key === 'Enter') finish(true);
        if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
    };
}

function editAvatar(c) {
    openImagePicker({
        title: `Photo de ${c.name}`,
        current: c.avatar,
        maxSize: 256,
        onConfirm: url => { c.avatar = url; commit(); },
    });
}

// Ajoute ou retire un personnage du chapitre affiché, sans toucher au personnage ni à ses messages
function setInChapter(c, present) {
    const ch = currentChapter();
    ch.cast = present ? [...ch.cast, c.id] : ch.cast.filter(id => id !== c.id);
    commit();

    const hasMessages = state.messages.some(m => m.chapterId === ch.id && m.charId === c.id);
    if (present) showToast(`${c.name} peut parler dans « ${ch.title} »`);
    else showToast(`${c.name} ne parle plus dans « ${ch.title} »` + (hasMessages ? ' (ses messages déjà écrits restent)' : ''));
}

function deleteChar(c) {
    const count = state.messages.filter(m => m.charId === c.id).length;
    if (!confirm(`Supprimer définitivement « ${c.name} » de toute l’histoire${count ? `, avec ses ${count} message(s)` : ''} ?\n\n` +
        'Pour qu’il ne parle plus seulement dans ce chapitre, utilisez plutôt le bouton « Retirer de ce chapitre ».')) return;

    state.characters = state.characters.filter(x => x.id !== c.id);
    state.messages = state.messages.filter(m => m.charId !== c.id);
    state.chapters.forEach(ch => { ch.cast = ch.cast.filter(id => id !== c.id); });
    commit();
}

$('addCharBtn').onclick = () => {
    const newChar = { id: uid('char'), name: 'Nouveau personnage', color: nextColor(), avatar: null, isNarrator: false };
    state.characters.push(newChar);
    // Un nouveau personnage n'apparaît que dans le chapitre en cours ; on peut l'ajouter ailleurs ensuite
    currentChapter().cast.push(newChar.id);
    state.activeChar = newChar.id;
    commit();
};

$('charToggle').onclick = () => {
    state.charSectionOpen = !state.charSectionOpen;
    $('charSection').hidden = !state.charSectionOpen;
    $('charToggle').classList.toggle('collapsed', !state.charSectionOpen);
    $('charToggle').setAttribute('aria-expanded', state.charSectionOpen);
    saveToLocal();
};


/* ---------- Actions : chapitres ---------- */

function nextChapterTitle() {
    const titles = new Set(state.chapters.map(ch => ch.title));
    let n = state.chapters.length + 1;
    while (titles.has(`Chapitre ${n}`)) n++;
    return `Chapitre ${n}`;
}

function uniqueChapterTitle(title) {
    const titles = new Set(state.chapters.map(ch => ch.title));
    if (!titles.has(title)) return title;
    let n = 2;
    while (titles.has(`${title} (${n})`)) n++;
    return `${title} (${n})`;
}

function selectChapter(id) {
    if (id === state.activeChapterId) return;
    state.activeChapterId = id;
    toggleSidebar(false);
    commit(true);
}

function deleteChapter(ch) {
    if (state.chapters.length === 1) {
        showToast('Il faut garder au moins un chapitre.', 'error');
        return;
    }
    const count = state.messages.filter(m => m.chapterId === ch.id).length;
    if (!confirm(`Supprimer « ${ch.title} »${count ? ` et ses ${count} message(s)` : ''} ?`)) return;

    state.chapters = state.chapters.filter(chapter => chapter.id !== ch.id);
    state.messages = state.messages.filter(m => m.chapterId !== ch.id);
    if (state.activeChapterId === ch.id) state.activeChapterId = state.chapters[0].id;
    commit(true);
}

$('chapterSelect').onchange = () => selectChapter($('chapterSelect').value);

$('addChapterBtn').onclick = () => {
    // Le nouveau chapitre reprend les personnages du chapitre en cours
    const newChapter = { id: uid('chapter'), title: nextChapterTitle(), cast: [...currentChapter().cast] };
    state.chapters.push(newChapter);
    state.activeChapterId = newChapter.id;
    commit(true);

    const input = $('chapterList').lastElementChild.querySelector('input');
    input.focus();
    input.select();
};


/* ---------- Actions : messages ---------- */

function autoResize() {
    msgInput.style.height = 'auto';
    msgInput.style.height = Math.min(msgInput.scrollHeight + 2, 120) + 'px';
}

function setPendingImage(url) {
    pendingImage = url;
    const box = $('pendingImage');
    box.hidden = !url;
    msgInput.placeholder = url ? 'Image attachée — écrivez votre message...' : 'Écrire un message...';
    if (!url) { box.replaceChildren(); return; }

    const thumb = el('img', { src: url, alt: '' });
    thumb.onerror = () => { thumb.hidden = true; };
    box.replaceChildren(
        thumb,
        el('span', { text: 'Image attachée au prochain message' }),
        el('button', { class: 'icon-btn-sm danger', title: 'Retirer l’image', 'aria-label': 'Retirer l’image', onclick: () => setPendingImage(null) }, icon('x')),
    );
    refreshIcons();
}

function sendMsg() {
    const text = msgInput.value.trim();
    if (!text && !pendingImage) return;

    const msg = {
        id: uid('msg'),
        chapterId: state.activeChapterId,
        charId: state.activeChar,
        text,
        align: state.align,
        image: pendingImage,
    };
    state.messages.push(msg);
    lastAddedId = msg.id;

    msgInput.value = '';
    autoResize();
    setPendingImage(null);
    renderMsgs(true);
    refreshIcons();
    saveToLocal();
}

function deleteMessage(id) {
    state.messages = state.messages.filter(m => m.id !== id);
    renderMsgs();
    refreshIcons();
    saveToLocal();
}

$('sendBtn').onclick = sendMsg;
msgInput.oninput = autoResize;
msgInput.onkeydown = e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMsg(); }
};

$('alignToggle').onclick = () => {
    state.align = state.align === 'left' ? 'right' : 'left';
    renderAlign();
    refreshIcons();
    saveToLocal();
};

$('appTitle').oninput = () => { state.appTitle = $('appTitle').value; saveToLocal(); };


/* ---------- Fenêtres ---------- */

// Dans l'ordre où Échap les ferme : la fenêtre d'image peut être ouverte par-dessus celle de modification
const MODALS = ['imgModal', 'exportModal', 'editModal', 'textImportModal'];

function openModal(id, focusId) {
    $(id).hidden = false;
    if (focusId) $(focusId).focus();
}

function closeModal(id) { $(id).hidden = true; }

// Un clic sur le fond ferme la fenêtre (sauf la modification, pour ne pas perdre de saisie)
['exportModal', 'imgModal'].forEach(id => {
    $(id).onclick = e => { if (e.target === $(id)) closeModal(id); };
});

// Choix d'une image : partagé par les messages, la modification d'un message et les photos de profil
const IMAGE_HELP = 'Image introuvable. L’adresse doit mener à l’image elle-même : sur internet, faites un clic droit ' +
    'sur l’image puis « Copier l’adresse de l’image ». Pour une image de l’ordinateur, utilisez « Choisir sur l’ordinateur ».';
let imagePicker = null;  // { maxSize, onConfirm }
let pickedImage = null;

function openImagePicker({ title, current = null, maxSize, onConfirm }) {
    imagePicker = { maxSize, onConfirm };
    $('imgModalTitle').textContent = title;
    $('imgConfirm').textContent = current ? 'Valider' : 'Ajouter';
    $('imgRemove').hidden = !current;
    // Une image intégrée est une très longue suite de caractères : inutile de l'afficher dans le champ
    $('imgUrlInput').value = current && !current.startsWith('data:') ? current : '';
    showImagePreview(current);
    openModal('imgModal', 'imgUrlInput');
}

function showImagePreview(src) {
    pickedImage = src || null;
    if (!src) { $('imgPreview').replaceChildren(); return; }
    const img = el('img', { src, alt: 'Aperçu' });
    img.onerror = () => $('imgPreview').replaceChildren(el('div', { class: 'img-error', text: IMAGE_HELP }));
    $('imgPreview').replaceChildren(img);
}

function finishImagePicker(url) {
    closeModal('imgModal');
    imagePicker.onConfirm(url);
}

$('imgFileBtn').onclick = () => $('imgFile').click();
$('imgFile').onchange = async () => {
    const file = $('imgFile').files[0];
    $('imgFile').value = '';
    if (!file) return;
    try {
        const dataUrl = await imageFileToDataUrl(file, imagePicker.maxSize);
        $('imgUrlInput').value = '';
        showImagePreview(dataUrl);
    } catch (e) {
        console.error(e);
        showToast('Impossible de lire cette image (format non pris en charge ?).', 'error');
    }
};
$('imgUrlInput').oninput = () => showImagePreview(normalizeImageUrl($('imgUrlInput').value));
$('imgUrlInput').onkeydown = e => { if (e.key === 'Enter') $('imgConfirm').click(); };
$('imgCancel').onclick = () => closeModal('imgModal');
$('imgRemove').onclick = () => finishImagePicker(null);
$('imgConfirm').onclick = () => { if (pickedImage) finishImagePicker(pickedImage); };

$('imgBtn').onclick = () => openImagePicker({
    title: 'Ajouter une image',
    current: pendingImage,
    maxSize: 1280,
    onConfirm: url => { setPendingImage(url); msgInput.focus(); },
});

// Modification d'un message
let editImage = null;

function renderEditImage() {
    const preview = $('editImagePreview');
    if (editImage) {
        const img = el('img', { src: editImage, alt: '' });
        img.onerror = () => preview.replaceChildren(el('span', { class: 'img-error', text: 'Image introuvable' }));
        preview.replaceChildren(img);
    } else {
        preview.replaceChildren('Aucune image');
    }
    $('editImageBtn').textContent = editImage ? 'Changer…' : 'Ajouter une image…';
}

$('editImageBtn').onclick = () => openImagePicker({
    title: 'Image du message',
    current: editImage,
    maxSize: 1280,
    onConfirm: url => { editImage = url; renderEditImage(); },
});

function openEditModal(id) {
    const msg = state.messages.find(m => m.id === id);
    if (!msg) return;
    editingId = id;

    const chapter = state.chapters.find(ch => ch.id === msg.chapterId) || currentChapter();
    const choices = state.characters.filter(c => inChapter(c, chapter) || c.id === msg.charId);
    $('editChar').replaceChildren(...choices.map(c => {
        const option = el('option', { value: c.id, text: c.name });
        option.selected = c.id === msg.charId;
        return option;
    }));
    $('editText').value = msg.text;
    editImage = msg.image;
    renderEditImage();
    $('editAlign').value = msg.align;
    openModal('editModal', 'editText');
}

function confirmEdit() {
    const msg = state.messages.find(m => m.id === editingId);
    if (!msg) { closeModal('editModal'); return; }

    const text = $('editText').value.trim();
    const image = editImage;
    if (!text && !image) {
        showToast('Le message doit contenir du texte ou une image.', 'error');
        return;
    }
    Object.assign(msg, { text, image, charId: $('editChar').value, align: $('editAlign').value });
    closeModal('editModal');
    renderMsgs();
    refreshIcons();
    saveToLocal();
}

$('editCancel').onclick = () => closeModal('editModal');
$('editConfirm').onclick = confirmEdit;
$('editText').onkeydown = e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) confirmEdit(); };

// Export texte
function buildExportText() {
    const line = '═══════════════════════════════════════════════════════════\n';
    const msgs = chapterMessages();
    let text = line + (state.appTitle || 'Mon Histoire').toUpperCase() + '\n' + currentChapter().title + '\n' + line + '\n';

    if (!msgs.length) text += '[Aucun message]\n\n';
    for (const m of msgs) {
        const c = findChar(m.charId);
        text += c.isNarrator ? '[NARRATEUR]\n' : c.name.toUpperCase() + ' :\n';
        if (m.text) text += m.text + '\n';
        if (m.image) text += m.image.startsWith('data:') ? IMAGE_EMBEDDED + '\n' : '[Image : ' + m.image + ']\n';
        text += '\n';
    }

    return text + line + 'Généré le ' + new Date().toLocaleDateString('fr-FR') + '\nCréé avec Story Messenger\n' + line;
}

$('exportBtn').onclick = () => {
    $('exportText').value = buildExportText();
    openModal('exportModal', 'exportText');
    $('exportText').select();
};
$('exportDownload').onclick = async () => {
    const name = safeFileName(`${state.appTitle} - ${currentChapter().title}`) + '.txt';
    const content = $('exportText').value;
    if (!canUseFiles) {
        downloadFile(name, content, 'text/plain;charset=utf-8');
        return;
    }
    try {
        const dir = await getWritableSaveDir();
        const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
        await writable.write(content);
        await writable.close();
        showToast(`Texte enregistré dans « ${dir.name}/${name} »`);
    } catch (e) {
        if (e.name === 'AbortError') return;
        console.error(e);
        downloadFile(name, content, 'text/plain;charset=utf-8');
    }
};
$('exportClose').onclick = () => closeModal('exportModal');
$('exportCancel').onclick = () => closeModal('exportModal');
$('exportCopy').onclick = async () => {
    try {
        await navigator.clipboard.writeText($('exportText').value);
        showToast('Texte copié dans le presse-papiers');
    } catch (e) {
        $('exportText').select();
        showToast('Copie automatique impossible : faites Ctrl+C sur le texte sélectionné.', 'error');
    }
};


/* ---------- Import texte ---------- */

const RULE_RE = /^═{5,}$/;
const IMAGE_RE = /^\[\s*image\s*:\s*(.+?)\s*\]$/i;
// Les images intégrées ne sont pas recopiées dans l'export texte (des milliers de caractères illisibles)
const IMAGE_EMBEDDED = '[Image intégrée]';
const NARRATOR_NAMES = ['narrateur', 'narratrice', 'narration'];

// Reconnaît une ligne « Nom : » (format de l'export), « Nom : message » ou « [Nom] »
function parseSpeaker(line, knownNames) {
    const bracket = line.match(/^\[([^\]]{1,40})\]$/);
    if (bracket) return { name: bracket[1].trim(), rest: '' };

    const m = line.match(/^([^:]{1,40}?)\s*:\s*(.*)$/);
    // Ignore les URL (« https://… ») et les heures (« 10:30 »)
    if (!m || m[2].startsWith('//') || !/\p{L}/u.test(m[1])) return null;
    const name = m[1].trim(), rest = m[2].trim();

    if (knownNames.has(name.toLowerCase())) return { name, rest };
    // Nom inconnu : on évite de prendre une phrase de narration (« Il dit : … ») pour un personnage
    if (!rest) return /[.!?…]/.test(name) ? null : { name, rest };
    if (name.split(/\s+/).length <= 3 && !/[.!?…«»"“”(),;]/.test(name)) return { name, rest };
    return null;
}

// Découpe le texte en messages { name, text, image } ; name vaut null pour la narration
function parseStoryText(raw, knownNames) {
    let lines = raw.replace(/\r\n?/g, '\n').split('\n');
    let chapterTitle = null;

    // En-tête et pied de page du format « Exporter », entre lignes ═══
    const rules = lines.flatMap((l, i) => (RULE_RE.test(l.trim()) ? [i] : []));
    const exportFormat = rules.length >= 2 && lines.slice(0, rules[0]).every(l => !l.trim());
    if (exportFormat) {
        const header = lines.slice(rules[0] + 1, rules[1]).map(l => l.trim()).filter(Boolean);
        if (header.length >= 2) chapterTitle = header[1];
        lines = lines.slice(rules[1] + 1, rules[2] ?? lines.length);
    }

    const entries = [];
    let speaker = null;
    let current = null;
    let afterBlank = true;
    const start = () => { current = { name: speaker, text: '', image: null }; };
    const flush = () => {
        if (current) {
            current.text = current.text.trim();
            if (current.text || current.image) entries.push(current);
        }
        current = null;
    };

    for (const rawLine of lines) {
        const line = rawLine.trim();
        // Une ligne vide termine le message ; ce qui suit sans nom redevient de la narration
        if (!line) { flush(); speaker = null; afterBlank = true; continue; }
        const isFirstLine = afterBlank;
        afterBlank = false;
        if (line === '[Aucun message]' || line === IMAGE_EMBEDDED) continue;

        const image = line.match(IMAGE_RE);
        if (image) {
            if (!current || current.image) { flush(); start(); }
            current.image = normalizeImageUrl(image[1]);
            continue;
        }

        // Dans le format de l'export, le nom est seul sur la première ligne de chaque bloc :
        // une ligne de texte comme « Salut : ça va ? » ne doit pas être prise pour un personnage
        const sp = parseSpeaker(line, knownNames);
        if (sp && (!exportFormat || (isFirstLine && !sp.rest))) {
            flush();
            speaker = NARRATOR_NAMES.includes(sp.name.toLowerCase()) ? null : sp.name;
            if (sp.rest) { start(); current.text = sp.rest; }
            continue;
        }

        if (!current) start();
        current.text += (current.text ? '\n' : '') + rawLine.trimEnd();
    }
    flush();
    return { chapterTitle, entries };
}

// « LE CHEF » (noms en majuscules de l'export) devient « Le Chef »
function prettifyName(name) {
    if (name !== name.toUpperCase() || !/\p{L}/u.test(name)) return name;
    return name.toLowerCase().replace(/(^|[\s\-'’"])(\p{L})/gu, (_, sep, letter) => sep + letter.toUpperCase());
}

// Associe les noms aux personnages existants (sans tenir compte de la casse) ou en crée de nouveaux, sans modifier `state`
function resolveImport(entries) {
    const narrator = findChar(NARRATOR.id);
    const byName = new Map(state.characters.map(c => [c.name.toLowerCase(), c]));
    const created = [];

    // Chaque personnage garde le côté de son dernier message ; les autres alternent gauche / droite
    const sideOf = new Map(state.messages.map(m => [m.charId, m.align]));
    let nextSide = 'left';

    const messages = entries.map(e => {
        let c = e.name ? byName.get(e.name.toLowerCase()) : narrator;
        if (!c) {
            c = { id: uid('char'), name: prettifyName(e.name), color: nextColor([...state.characters, ...created]), avatar: null, isNarrator: false };
            created.push(c);
            byName.set(e.name.toLowerCase(), c);
        }
        if (!c.isNarrator && !sideOf.has(c.id)) {
            sideOf.set(c.id, nextSide);
            nextSide = nextSide === 'left' ? 'right' : 'left';
        }
        return { charId: c.id, text: e.text, image: e.image, align: sideOf.get(c.id) || 'left' };
    });
    return { messages, created };
}

function analyzeTextImport() {
    const knownNames = new Set(state.characters.map(c => c.name.toLowerCase()));
    const parsed = parseStoryText($('textImportInput').value, knownNames);
    return { ...parsed, ...resolveImport(parsed.entries) };
}

function renderTextImportPreview() {
    const { messages, created } = analyzeTextImport();
    $('textImportConfirm').disabled = !messages.length;
    if (!messages.length) {
        $('textImportPreview').replaceChildren(el('div', { text: 'Aucun message détecté.' }));
        return;
    }

    const charName = id => (findChar(id) || created.find(c => c.id === id)).name;
    const speakers = new Set(messages.map(m => m.charId)).size;
    let summary = `${messages.length} message(s) · ${speakers} personnage(s)`;
    if (created.length) summary += ` · nouveau(x) : ${created.map(c => c.name).join(', ')}`;

    const lines = messages.slice(0, 5).map(m => el('div', { class: 'import-line' }, [
        el('strong', { text: charName(m.charId) + ' : ' }),
        (m.text.split('\n')[0] || '') + (m.image ? ' [image]' : ''),
    ]));
    if (messages.length > 5) lines.push(el('div', { text: `… et ${messages.length - 5} autre(s)` }));

    $('textImportPreview').replaceChildren(el('div', { class: 'import-summary', text: summary }), ...lines);
}

/* Fichiers Word (.docx) : convertis en texte puis traités comme un import texte */

const MAMMOTH_URL = 'vendor/mammoth.browser.min.js';
const DOCX_BLOCKS = 'p, li, h1, h2, h3, h4, h5, h6';
let mammothLoading = null;

function isDocx(file) { return /\.docx$/i.test(file.name); }
function isText(file) { return /\.txt$/i.test(file.name) || file.type === 'text/plain'; }

// La bibliothèque (~600 Ko) n'est chargée qu'au premier fichier Word
function loadMammoth() {
    if (window.mammoth) return Promise.resolve();
    mammothLoading ??= new Promise((resolve, reject) => {
        const script = el('script', { src: MAMMOTH_URL });
        script.onload = resolve;
        script.onerror = () => { mammothLoading = null; reject(new Error('Chargement de mammoth.js impossible')); };
        document.head.append(script);
    });
    return mammothLoading;
}

async function docxToText(file) {
    await loadMammoth();
    let images = 0;
    const { value: html } = await mammoth.convertToHtml({ arrayBuffer: await file.arrayBuffer() }, {
        // Les paragraphes vides séparent les messages : il faut les garder
        ignoreEmptyParagraphs: false,
        // Les images intégrées ne sont pas importées (elles satureraient la sauvegarde du navigateur)
        convertImage: mammoth.images.imgElement(() => { images++; return { src: '' }; }),
    });

    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('br').forEach(br => br.replaceWith('\n'));
    const text = [...doc.body.querySelectorAll(DOCX_BLOCKS)]
        .filter(block => !block.querySelector(DOCX_BLOCKS))
        .map(block => block.textContent)
        .join('\n');
    return { text, images };
}

// Lit un fichier .txt ou .docx et ouvre (ou remplit) la fenêtre d'import texte
async function importTextFile(file) {
    if (!isDocx(file)) {
        openTextImport(await file.text());
        return;
    }
    showToast('Lecture du fichier Word…');
    try {
        const { text, images } = await docxToText(file);
        openTextImport(text);
        if (images) showToast(`${images} image(s) du document non importée(s) : ajoutez-les avec une URL.`);
    } catch (e) {
        console.error(e);
        showToast('Impossible de lire ce fichier Word.', 'error');
    }
}

function openTextImport(text = '') {
    $('textImportInput').value = text;
    renderTextImportPreview();
    toggleSidebar(false);
    openModal('textImportModal', 'textImportInput');
}

function confirmTextImport() {
    const { chapterTitle, messages, created } = analyzeTextImport();
    if (!messages.length) return;

    if ($('textImportDest').value === 'new') {
        const chapter = { id: uid('chapter'), title: chapterTitle ? uniqueChapterTitle(chapterTitle) : nextChapterTitle(), cast: [] };
        state.chapters.push(chapter);
        state.activeChapterId = chapter.id;
    }
    state.characters.push(...created);
    // Ceux qui parlent dans le texte importé font partie du chapitre
    const speakers = messages.map(m => m.charId).filter(id => id !== NARRATOR.id);
    currentChapter().cast = [...new Set([...currentChapter().cast, ...speakers])];
    state.messages.push(...messages.map(m => ({ id: uid('msg'), chapterId: state.activeChapterId, ...m })));

    closeModal('textImportModal');
    commit(true);
    showToast(`${messages.length} message(s) importé(s)`);
}

$('textImportBtn').onclick = () => openTextImport();
$('textImportInput').oninput = renderTextImportPreview;
$('textImportInput').onkeydown = e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) confirmTextImport(); };
$('textImportFileBtn').onclick = () => $('textImportFile').click();
$('textImportFile').onchange = async () => {
    const file = $('textImportFile').files[0];
    $('textImportFile').value = '';
    if (file) await importTextFile(file);
};
$('textImportCancel').onclick = () => closeModal('textImportModal');
$('textImportConfirm').onclick = confirmTextImport;


/* ---------- Mode lecture ---------- */

function openReading() {
    const msgs = chapterMessages();
    if (!msgs.length) {
        showToast('Ce chapitre ne contient aucun message.');
        return;
    }
    reading = { msgs, idx: 0 };
    $('readTitle').textContent = (state.appTitle || 'Mon Histoire') + ' — ' + currentChapter().title;
    $('readArea').replaceChildren();
    $('readingMode').hidden = false;
    // Sans ça, le focus reste sur le bouton « Lecture » caché derrière et Espace ne ferait rien
    $('readArea').focus();
    showNextReading();
}

function showNextReading() {
    if (!reading || reading.idx >= reading.msgs.length) return;
    const m = reading.msgs[reading.idx++];
    $('readArea').append(messageEl(m, findChar(m.charId), { reading: true }));
    $('readArea').scrollTop = $('readArea').scrollHeight;

    $('readHint').textContent = reading.idx < reading.msgs.length
        ? 'Cliquez ou appuyez sur Espace pour afficher le message suivant'
        : 'Fin du chapitre — Échap pour fermer';
}

function closeReading() {
    $('readingMode').hidden = true;
    reading = null;
}

$('readBtn').onclick = openReading;
$('readingMode').onclick = e => { if (!e.target.closest('#readClose')) showNextReading(); };
$('readClose').onclick = closeReading;


/* ---------- Clavier ---------- */

document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
        const openId = MODALS.find(id => !$(id).hidden);
        if (openId) closeModal(openId);
        else if (reading) closeReading();
        else toggleSidebar(false);
        return;
    }
    if (reading && [' ', 'Enter', 'ArrowRight', 'ArrowDown'].includes(e.key) && !e.target.closest('#readClose')) {
        e.preventDefault();
        showNextReading();
    }
});


/* ---------- Barre latérale (petits écrans) ---------- */

function toggleSidebar(open) {
    document.body.classList.toggle('sidebar-open', open);
}

$('sidebarToggle').onclick = () => toggleSidebar(!document.body.classList.contains('sidebar-open'));
$('sidebarBackdrop').onclick = () => toggleSidebar(false);


/* ---------- Fichier de sauvegarde ---------- */

// Chrome et Edge peuvent écrire directement dans un fichier choisi par l'utilisateur :
// l'histoire y est alors enregistrée automatiquement à chaque modification.
// Ailleurs (Firefox, Safari), « Enregistrer » télécharge une copie du fichier.
const canUseFiles = 'showDirectoryPicker' in window && 'showOpenFilePicker' in window;

// Dossier « save » choisi une fois par l'utilisateur : les histoires et exports y sont écrits directement
let saveDir = null;
let fileHandle = null;
let fileStatus = 'none';  // none | saved | reconnect | error
let fileWriteTimer = null;
let fileWriteQueue = Promise.resolve();

function safeFileName(name) {
    return (name || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 100) || 'Mon Histoire';
}

function serializeState() {
    return JSON.stringify({ app: 'story-messenger', version: 1, ...state }, null, 2);
}

function downloadFile(name, content, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const a = el('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
}

// Le lien vers le fichier est gardé dans IndexedDB pour le retrouver à la prochaine ouverture
function idbRequest(mode, action) {
    return new Promise((resolve, reject) => {
        const open = indexedDB.open('storyMessenger', 1);
        open.onupgradeneeded = () => open.result.createObjectStore('files');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
            const db = open.result;
            try {
                const req = action(db.transaction('files', mode).objectStore('files'));
                req.onsuccess = () => { resolve(req.result); db.close(); };
                req.onerror = () => { reject(req.error); db.close(); };
            } catch (e) {
                db.close();
                reject(e);
            }
        };
    });
}
const getStored = key => idbRequest('readonly', store => store.get(key)).catch(() => null);
const putStored = (key, value) => idbRequest('readwrite', store => store.put(value, key)).catch(e => console.error(e));

function setFileStatus(status) {
    fileStatus = status;
    const name = fileHandle ? fileHandle.name : '';
    const look = {
        none: ['download', 'Enregistrer', canUseFiles
            ? 'Choisir le dossier « save » où l’histoire sera enregistrée automatiquement'
            : 'Télécharger une sauvegarde de l’histoire (.json)'],
        saved: ['check', 'Enregistré', `Enregistré automatiquement dans « ${name} »`],
        reconnect: ['refresh-cw', 'Reconnecter', `Cliquer pour reprendre l’enregistrement dans « ${name} »`],
        error: ['alert-triangle', 'Non enregistré', `Impossible d’écrire dans « ${name} » : cliquer pour choisir un fichier`],
    }[status];
    const btn = $('saveBtn');
    btn.className = `btn btn-save ${status}`;
    btn.title = look[2];
    btn.replaceChildren(icon(look[0]), el('span', { class: 'btn-label', text: look[1] }));
    refreshIcons();
}

async function writeToFile() {
    if (!fileHandle || fileStatus === 'reconnect') return;
    try {
        const writable = await fileHandle.createWritable();
        await writable.write(serializeState());
        await writable.close();
        setFileStatus('saved');
    } catch (e) {
        console.error('Erreur d’écriture du fichier', e);
        setFileStatus('error');
    }
}

// Les écritures passent par une file d'attente pour ne jamais se chevaucher
function queueFileWrite() {
    clearTimeout(fileWriteTimer);
    fileWriteQueue = fileWriteQueue.then(writeToFile);
    return fileWriteQueue;
}

// Appelé à chaque modification : on attend une courte pause dans la saisie avant d'écrire
function scheduleFileWrite() {
    if (!fileHandle || fileStatus === 'reconnect') return;
    clearTimeout(fileWriteTimer);
    fileWriteTimer = setTimeout(queueFileWrite, 800);
}

async function linkFile(handle) {
    fileHandle = handle;
    await putStored('saveFile', handle);
}

// Demande le dossier « save » (une seule fois : il est ensuite retenu)
async function pickSaveDir() {
    showToast('Choisissez le dossier « save » de Story Messenger');
    const dir = await window.showDirectoryPicker({ id: 'story-save', mode: 'readwrite', startIn: saveDir || 'documents' });
    saveDir = dir;
    await putStored('saveDir', dir);
    return dir;
}

// Renvoie le dossier « save » prêt à être écrit, en le demandant si besoin (doit suivre un clic)
async function getWritableSaveDir() {
    if (saveDir && await requestWriteAccess(saveDir)) return saveDir;
    return pickSaveDir();
}

// Si le fichier a été modifié plus récemment (ex. sur un autre ordinateur), on charge sa version
async function syncFromFile() {
    try {
        const data = JSON.parse(await (await fileHandle.getFile()).text());
        if ((Number(data.savedAt) || 0) <= state.savedAt) return;
        state = normalizeState(data);
        renderAll(true);
        writeBrowserCopy();
        showToast(`Version plus récente chargée depuis « ${fileHandle.name} »`);
    } catch (e) {
        // Fichier vide, supprimé ou illisible : il sera réécrit avec l'histoire actuelle
        console.error(e);
    }
}

// Le navigateur redemande l'autorisation d'écrire après avoir été fermé
async function requestWriteAccess(handle) {
    const options = { mode: 'readwrite' };
    if (await handle.queryPermission(options) === 'granted') return true;
    return await handle.requestPermission(options) === 'granted';
}

async function reconnectFile() {
    try {
        if (!await requestWriteAccess(fileHandle)) {
            showToast('Autorisation refusée : l’histoire reste enregistrée dans le navigateur seulement.', 'error');
            return;
        }
    } catch (e) {
        console.error(e);
        setFileStatus('error');
        return;
    }
    fileStatus = 'saved';
    await syncFromFile();
    await queueFileWrite();
    showToast(`Enregistrement automatique dans « ${fileHandle.name} »`);
}

async function chooseSaveFile() {
    let handle;
    try {
        const dir = await getWritableSaveDir();
        handle = await dir.getFileHandle(safeFileName(state.appTitle) + '.json', { create: true });
    } catch (e) {
        if (e.name !== 'AbortError') {
            console.error(e);
            showToast('Impossible d’enregistrer dans ce dossier.', 'error');
        }
        return;
    }

    // Protège contre l'écrasement d'une histoire existante (ex. choisir son ancien fichier au lieu de l'ouvrir)
    let existing = null;
    try { existing = normalizeState(JSON.parse(await (await handle.getFile()).text())); } catch (e) { /* fichier neuf ou vide */ }
    if (existing && existing.messages.length &&
        !confirm(`« ${handle.name} » existe déjà et contient une histoire (${existing.messages.length} message(s)).\nLa remplacer par l’histoire affichée ?\n\nPour reprendre cette histoire, annulez puis utilisez « Ouvrir ». Pour garder les deux, changez d’abord le titre de l’histoire.`)) return;

    await linkFile(handle);
    fileStatus = 'saved';
    await queueFileWrite();
    if (fileStatus === 'saved') showToast(`Enregistrement automatique activé dans « ${handle.name} »`);
}

$('saveBtn').onclick = async () => {
    if (!canUseFiles) {
        saveToLocal();
        downloadFile(safeFileName(state.appTitle) + '.json', serializeState(), 'application/json');
        showToast('Sauvegarde téléchargée');
        return;
    }
    if (fileStatus === 'reconnect') return reconnectFile();
    if (fileStatus === 'saved') {
        await queueFileWrite();
        showToast(`Enregistré dans « ${fileHandle.name} »`);
        return;
    }
    return chooseSaveFile();
};

// Ouverture d'une histoire (.json) ; renvoie les données ou null si annulé / invalide
async function readStoryFile(file) {
    let imported;
    try {
        imported = normalizeState(JSON.parse(await file.text()));
    } catch (e) {
        console.error(e);
        showToast('Fichier invalide : ce n’est pas une histoire Story Messenger.', 'error');
        return null;
    }
    // Inutile de demander si l'histoire actuelle est déjà à l'abri dans son fichier
    const safe = fileHandle && fileStatus === 'saved';
    if (state.messages.length && !safe &&
        !confirm('Remplacer l’histoire actuelle par celle du fichier ?\nL’histoire actuelle n’est enregistrée dans aucun fichier et sera perdue.')) return null;
    return imported;
}

function showStory(imported) {
    state = imported;
    setPendingImage(null);
    commit(true);
}

$('importBtn').onclick = async () => {
    if (!canUseFiles) { $('importInput').click(); return; }

    let handle;
    try {
        [handle] = await window.showOpenFilePicker({
            startIn: saveDir || 'documents',
            types: [{
                description: 'Histoire, texte ou document Word',
                accept: {
                    'application/json': ['.json'],
                    'text/plain': ['.txt'],
                    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
                },
            }],
        });
    } catch (e) {
        if (e.name !== 'AbortError') console.error(e);
        return;
    }

    const file = await handle.getFile();
    if (isText(file) || isDocx(file)) return importTextFile(file);

    const imported = await readStoryFile(file);
    if (!imported) return;

    // Le fichier ouvert devient le fichier de sauvegarde automatique
    await linkFile(handle);
    let writable = false;
    try { writable = await requestWriteAccess(handle); } catch (e) { console.error(e); }
    fileStatus = writable ? 'saved' : 'reconnect';
    showStory(imported);
    await queueFileWrite();
    setFileStatus(fileStatus);
    showToast(writable ? `Histoire ouverte : enregistrement automatique dans « ${handle.name} »` : 'Histoire ouverte');
};

// Navigateurs sans accès aux fichiers : simple sélection de fichier
$('importInput').onchange = async () => {
    const file = $('importInput').files[0];
    $('importInput').value = '';
    if (!file) return;
    if (isText(file) || isDocx(file)) return importTextFile(file);

    const imported = await readStoryFile(file);
    if (!imported) return;
    showStory(imported);
    showToast('Histoire ouverte');
};

async function restoreFileLink() {
    if (!canUseFiles) return;
    saveDir = await getStored('saveDir');
    const handle = await getStored('saveFile');
    if (!handle) return;
    fileHandle = handle;

    let granted = false;
    try { granted = await handle.queryPermission({ mode: 'readwrite' }) === 'granted'; } catch (e) { console.error(e); }
    if (!granted) {
        setFileStatus('reconnect');
        return;
    }
    fileStatus = 'saved';
    await syncFromFile();
    await queueFileWrite();
}


/* ---------- Démarrage ---------- */

(async () => {
    await loadFromLocal();
    renderAll(true);
    setPendingImage(null);
    autoResize();
    setFileStatus('none');
    restoreFileLink();
})();
