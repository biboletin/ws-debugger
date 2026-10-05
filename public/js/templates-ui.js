// Templates sheet. All stored text is rendered through textContent.
import { t } from './i18n.js';
import { Sheet } from './sheet.js';
import { sanitizeTemplates, addTemplate, removeTemplate, expandVars, VARS } from './templates.js';
import { load, save } from './storage.js';

const mk = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};

export class TemplatePanel {
  #list = sanitizeTemplates(load('templates', []));
  #counter = 0; #sheet; #e; #getDraft; #apply;

  /** els: {openBtn, closeBtn, list, name, saveBtn, status, vars}; getDraft(): {type,text}; apply(type,text) */
  constructor({ overlay, app, els, getDraft, apply }) {
    this.#e = els; this.#getDraft = getDraft; this.#apply = apply;
    this.#sheet = new Sheet({ overlay, app });
    els.openBtn.addEventListener('click', () => {
      this.#say('');
      this.#render();
      this.#sheet.open(els.name);
    });
    els.closeBtn.addEventListener('click', () => this.#sheet.requestClose());
    els.saveBtn.addEventListener('click', () => this.#saveCurrent());
    els.name.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); this.#saveCurrent(); } });
    this.refreshLabels();
  }

  refreshLabels() {
    this.#e.vars.textContent = `${t('tpl.vars')} ${VARS.map((v) => `{{${v}}}`).join(' ')}`;
    this.#render();
  }
  reset() { this.#list = []; this.#render(); }

  #say(text) { this.#e.status.textContent = text; }
  #persist() { save('templates', this.#list); }

  #saveCurrent() {
    const { type, text } = this.#getDraft();
    const r = addTemplate(this.#list, { name: this.#e.name.value, type, text });
    if (!r.ok) { this.#say(t(r.error.key, r.error)); return; }
    this.#list = r.list;
    this.#persist();
    this.#e.name.value = '';
    this.#say(t('tpl.saved'));
    this.#render();
  }

  #render() {
    const box = this.#e.list;
    box.textContent = '';
    if (!this.#list.length) { box.append(mk('p', 'muted', t('tpl.empty'))); return; }
    for (const tpl of this.#list) {
      const row = mk('div', 'tpl-row');
      const use = mk('button', 'tpl-use');
      use.type = 'button';
      use.setAttribute('aria-label', `${t('tpl.use')}: ${tpl.name}`);
      const preview = tpl.text.replace(/\s+/g, ' ').slice(0, 80);
      use.append(mk('span', 'tpl-name', tpl.name), mk('span', 'tpl-meta', `${tpl.type.toUpperCase()} · ${preview}`));
      use.addEventListener('click', () => {
        const text = expandVars(tpl.text, { counter: ++this.#counter });
        this.#sheet.close();
        this.#apply(tpl.type, text);
      });
      const del = mk('button', 'icon-btn tpl-del', '✕');
      del.type = 'button';
      del.setAttribute('aria-label', `${t('tpl.delete')}: ${tpl.name}`);
      del.addEventListener('click', () => {
        this.#list = removeTemplate(this.#list, tpl.id);
        this.#persist();
        this.#say(t('tpl.deleted'));
        this.#render();
      });
      row.append(use, del);
      box.append(row);
    }
  }
}
