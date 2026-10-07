// The modifier the swarm's shortcuts use, as this platform spells it: ⌘ on a
// Mac, Ctrl elsewhere (the handlers accept either key).
const mac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent);

/** Joined to a key: "⌘↵" or "Ctrl+↵". */
export const MOD = mac ? '⌘' : 'Ctrl+';
/** Before a key with a space, as the help table lists them: "⌘ ↵" or "ctrl ↵". */
export const MOD_NAME = mac ? '⌘' : 'ctrl';
