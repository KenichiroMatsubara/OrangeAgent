// What `@mail/t3chat/surface` exports, declared apart from the copied code so a consumer's
// type-check does not compile the copy under its own options. check.ts keeps the two equal.
import type { ReactElement } from 'react';

import type { ChatSurfaceProps } from './api';

declare const ChatSurface: (props: ChatSurfaceProps) => ReactElement;
export default ChatSurface;
