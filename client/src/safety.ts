// Blocking and reporting (see server api/safety.rs). Blocking someone stops them DMing,
// ringing or friending you, ends any friendship, and folds their messages away in servers you
// share. Reports go to this Llamble's admins (and the server's owner).
import { api } from "./api";
import { useStore } from "./store";
import { openModal, toast } from "./ui";

export const isBlocked = (uid: string) => useStore.getState().blocked.includes(uid);

export function useBlocked(uid: string | undefined) {
  return useStore((s) => !!uid && s.blocked.includes(uid));
}

export function block(uid: string, name: string) {
  openModal({
    kind: "confirm",
    title: `Block ${name}?`,
    body: "They won't be able to message you, call you or send you a friend request, and you'll stop being friends. In servers you share, their messages are folded away. They aren't told. You can unblock them any time in Settings → Blocked.",
    danger: true,
    confirmLabel: "Block",
    onConfirm: () =>
      api(`/api/blocks/${uid}`, { method: "PUT" })
        .then(() => {
          useStore.setState((s) => ({ blocked: s.blocked.includes(uid) ? s.blocked : [...s.blocked, uid] }));
          toast(`Blocked ${name}`);
        })
        .catch((e) => toast(e.message, "error")),
  });
}

export function unblock(uid: string, name?: string) {
  return api(`/api/blocks/${uid}`, { method: "DELETE" })
    .then(() => {
      useStore.setState((s) => ({ blocked: s.blocked.filter((b) => b !== uid) }));
      toast(name ? `Unblocked ${name}` : "Unblocked");
    })
    .catch((e) => toast(e.message, "error"));
}

export function report(userId: string, messageId?: string) {
  openModal({ kind: "report", userId, messageId });
}

export const REASONS: [string, string][] = [
  ["harassment", "Harassment or bullying"],
  ["hate", "Hate or discrimination"],
  ["sexual", "Sexual content"],
  ["violence", "Violence or threats"],
  ["spam", "Spam or scams"],
  ["other", "Something else"],
];
export const reasonLabel = (r: string) => REASONS.find((x) => x[0] === r)?.[1] || r;
