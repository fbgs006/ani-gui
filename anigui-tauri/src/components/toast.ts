// ─── Toast Notifications ─────────────────────────────────────────────────────

import { $ } from '../utils';
import { el } from '../utils';

export function toast(msg: string, type: "success" | "error" | "info" = "info") {
  const c = $("#toast-container");
  const t = el("div", `toast ${type}`);
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}
