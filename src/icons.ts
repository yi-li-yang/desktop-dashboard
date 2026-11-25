// Tabler outline icons (MIT, tabler.io/icons) at the system's 1.5px stroke.
// They take currentColor, so they stay in ink or muted.

const svg = (paths: string) =>
  `<svg class="icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

export const ICON = {
  chevronDown: svg(`<path d="M6 9l6 6l6 -6"/>`),
  pencil: svg(`<path d="M4 20h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4"/><path d="M13.5 6.5l4 4"/>`),
  refresh: svg(`<path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"/>`),
  x: svg(`<path d="M18 6l-12 12"/><path d="M6 6l12 12"/>`),
};
