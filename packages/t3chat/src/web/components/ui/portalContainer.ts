// OrangeAgent: popups (menus, tooltips, dialogs, toasts) open inside the chat's own `.t3chat`
// element rather than at the end of <body>, so the styles scoped there (chat.css) reach them and
// none reach OrangeAgent's other screens. ChatSurface renders the element this points at.
export const chatPortalContainer: { current: HTMLElement | null } = { current: null };
