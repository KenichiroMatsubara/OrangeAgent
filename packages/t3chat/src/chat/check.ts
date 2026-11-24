// Holds each declared export (surface.types.ts, starter.types.ts, fake.types.ts) to its implementation, so a
// change to one that the other does not follow fails this package's type-check.
import type * as FakeDeclared from './fake.types.ts';
import * as Fake from './fake.ts';
import type SurfaceDeclared from './surface.types.ts';
import Surface from './surface.tsx';
import type StarterDeclared from './starter.types.ts';
import Starter from './starter.tsx';

export const surface: typeof SurfaceDeclared = Surface;
export const starter: typeof StarterDeclared = Starter;
export const fakeThreadId: typeof FakeDeclared.FAKE_THREAD_ID = Fake.FAKE_THREAD_ID;
export const createFake: typeof FakeDeclared.createFakeTransport = Fake.createFakeTransport;
export const fakeForkId: typeof FakeDeclared.FAKE_FORK_ID = Fake.FAKE_FORK_ID;
