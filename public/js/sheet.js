// Accessible bottom-sheet / dialog helper: inert background, focus restore, Esc and backdrop close.
export class Sheet {
  static current = null;
  #overlay; #app; #onRequestClose; #last = null;

  constructor({ overlay, app, onRequestClose }) {
    this.#overlay = overlay; this.#app = app; this.#onRequestClose = onRequestClose ?? (() => this.close());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) this.requestClose(); });
  }
  get isOpen() { return this.#overlay.classList.contains('open'); }
  open(focusEl) {
    this.#last = document.activeElement;
    this.#overlay.classList.add('open');
    this.#app.inert = true;
    Sheet.current = this;
    focusEl?.focus();
  }
  close() {
    this.#overlay.classList.remove('open');
    this.#app.inert = false;
    if (Sheet.current === this) Sheet.current = null;
    if (this.#last instanceof HTMLElement) this.#last.focus();
  }
  requestClose() { this.#onRequestClose(); }
}
