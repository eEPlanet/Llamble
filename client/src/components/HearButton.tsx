// Who I hear in a room, and who hears me: everyone, friends only, or no one else.
// One button (by your name, and in a Watch room's controls) that opens the three choices.
import { openMenu } from "../ui";
import { setFriendsOnly, setPeopleMuted, useVoice } from "../voice";
import { Icon } from "./common";

type Mode = "all" | "friends" | "none";

const LABEL: Record<Mode, string> = {
  all: "Hear everyone",
  friends: "Friends only: hear only your friends, and only they hear you",
  none: "Mute everyone else: silence their voices for you",
};

function mode(v: { friendsOnly: boolean; peopleMuted: boolean }): Mode {
  return v.friendsOnly ? "friends" : v.peopleMuted ? "none" : "all";
}

function choose(m: Mode) {
  if (m === "friends") setFriendsOnly(true);
  else if (m === "none") setPeopleMuted(true);
  else {
    setFriendsOnly(false);
    setPeopleMuted(false);
  }
}

/** `call`: the round buttons under a Watch player; otherwise the small one by your name. */
export function HearButton({ call }: { call?: boolean }) {
  const v = useVoice();
  const m = mode(v);
  const icon = m === "friends" ? "usersHeart" : m === "none" ? "usersNo" : "users";
  const cls = call ? "call-btn" + (m === "none" ? " off" : m === "friends" ? " friends" : "") : "icon-btn" + (m === "none" ? " red" : m === "friends" ? " green" : "");
  const title =
    m === "friends"
      ? "Friends only: you hear only your friends, and only they hear your voice (your screen and camera still go to everyone)"
      : m === "none"
        ? "Everyone else is muted for you (videos, shows and screens keep playing)"
        : "Who you hear: everyone, friends only, or no one else";
  const open = (e: React.MouseEvent) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    openMenu({ clientX: r.left, clientY: call ? r.top - 150 : r.top - 150 }, (["all", "friends", "none"] as Mode[]).map((k) => ({ label: (k === m ? "✓ " : "") + LABEL[k], onClick: () => choose(k) })));
  };
  return (
    <button className={cls} title={title} aria-label={title} onClick={open}>
      <Icon name={icon} size={call ? 22 : 18} />
    </button>
  );
}
