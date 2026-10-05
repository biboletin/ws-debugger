const P = 'wsd.';
export const load = (k, fb) => {
  try { const v = localStorage.getItem(P + k); return v === null ? fb : JSON.parse(v); } catch { return fb; }
};
export const save = (k, v) => {
  try { localStorage.setItem(P + k, JSON.stringify(v)); return true; } catch { return false; }
};
export const remove = (k) => { try { localStorage.removeItem(P + k); } catch { /* ignore */ } };
